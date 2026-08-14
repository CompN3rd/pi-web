import type {
  BackgroundSessionCreateRequest,
  BackgroundSessionLease,
  BackgroundSessionPromptResult,
  BackgroundSessionService,
  BackgroundSessionSnapshot,
  BackgroundSessionUsage,
} from "../../server-plugin-api.js";
import type { WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import type { PiSessionService } from "../sessions/piSessionService.js";

interface BackgroundProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

interface BackgroundWorkspaceAuthority {
  resolve(project: Project): Promise<WorkspaceProviderAuthorityResolution>;
}

type BackgroundSessionHost = Pick<PiSessionService,
  | "backgroundSessionModels"
  | "startBackgroundSession"
  | "promptBackgroundSession"
  | "backgroundSessionStatus"
  | "abortBackgroundSession"
  | "forceStopBackgroundSession"
  | "releaseBackgroundSession"
>;

export class PluginBackgroundSessionRegistry {
  private readonly leases = new Map<string, Set<HostBackgroundSessionLease>>();

  constructor(
    private readonly projects: BackgroundProjectReader,
    private readonly workspaces: BackgroundWorkspaceAuthority,
    private readonly sessions: BackgroundSessionHost,
  ) {}

  forPlugin(pluginId: string): BackgroundSessionService {
    return Object.freeze({
      listModels: () => this.sessions.backgroundSessionModels(),
      create: (request: BackgroundSessionCreateRequest) => this.create(pluginId, request),
    });
  }

  async quiesceAll(): Promise<void> {
    const leases = [...this.leases.values()].flatMap((owned) => [...owned]);
    await Promise.allSettled(leases.map((lease) => lease.forceStop()));
    this.leases.clear();
  }

  private async create(pluginId: string, request: BackgroundSessionCreateRequest): Promise<BackgroundSessionLease> {
    const project = await this.projects.requireProject(requireId(request.projectId, "projectId"));
    const resolution = await this.workspaces.resolve(project);
    if (resolution.status === "degraded") throw new Error(`Workspace authority is degraded for project ${project.id}`);
    const workspace = resolution.workspaces.find(({ id }) => id === requireId(request.workspaceId, "workspaceId"));
    if (workspace === undefined) throw new Error("Workspace not found");
    const created = await this.sessions.startBackgroundSession(pluginId, workspace.path, {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
    });
    const ref = { id: created.session.id, cwd: workspace.path };
    const lease = new HostBackgroundSessionLease(pluginId, ref, this.sessions, created.status, () => {
      const owned = this.leases.get(pluginId);
      owned?.delete(lease);
      if (owned?.size === 0) this.leases.delete(pluginId);
    });
    const owned = this.leases.get(pluginId) ?? new Set<HostBackgroundSessionLease>();
    owned.add(lease);
    this.leases.set(pluginId, owned);
    return lease.publicHandle();
  }
}

class HostBackgroundSessionLease {
  private released = false;
  private abortRequested = false;
  private lastSnapshot: BackgroundSessionSnapshot;

  constructor(
    private readonly pluginId: string,
    private readonly ref: { id: string; cwd: string },
    private readonly sessions: BackgroundSessionHost,
    initialStatus: Awaited<ReturnType<PiSessionService["status"]>>,
    private readonly onReleased: () => void,
  ) {
    this.lastSnapshot = snapshotFromStatus(initialStatus);
  }

  publicHandle(): BackgroundSessionLease {
    return Object.freeze({
      sessionId: this.ref.id,
      prompt: (text: string) => this.prompt(text),
      snapshot: () => this.snapshot(),
      abort: () => this.abort(),
      forceStop: () => this.forceStop(),
      release: () => this.release(),
    });
  }

  private async prompt(text: string): Promise<BackgroundSessionPromptResult> {
    this.requireActive();
    try {
      const status = await this.sessions.promptBackgroundSession(this.pluginId, this.ref, text);
      this.lastSnapshot = snapshotFromStatus(status);
      return { status: this.abortRequested ? "aborted" : "completed", usage: this.lastSnapshot.usage };
    } catch (error) {
      const snapshot = await this.captureSnapshot();
      return {
        status: this.abortRequested ? "aborted" : "failed",
        usage: snapshot.usage,
        ...(this.abortRequested ? {} : { error: errorMessage(error) }),
      };
    } finally {
      await this.release();
    }
  }

  private async snapshot(): Promise<BackgroundSessionSnapshot> {
    if (this.released) return this.lastSnapshot;
    return this.captureSnapshot();
  }

  private async captureSnapshot(): Promise<BackgroundSessionSnapshot> {
    if (this.released) return this.lastSnapshot;
    try {
      this.lastSnapshot = snapshotFromStatus(await this.sessions.backgroundSessionStatus(this.pluginId, this.ref));
    } catch {
      // The last host-observed usage remains the minimal terminal snapshot.
    }
    return this.lastSnapshot;
  }

  private async abort(): Promise<void> {
    if (this.released) return;
    this.abortRequested = true;
    await this.sessions.abortBackgroundSession(this.pluginId, this.ref);
  }

  async forceStop(): Promise<void> {
    if (this.released) return;
    this.abortRequested = true;
    try {
      await this.sessions.forceStopBackgroundSession(this.pluginId, this.ref);
    } finally {
      this.markReleased();
    }
  }

  private release(): Promise<void> {
    if (!this.released) {
      try {
        this.sessions.releaseBackgroundSession(this.pluginId, this.ref);
      } finally {
        this.markReleased();
      }
    }
    return Promise.resolve();
  }

  private markReleased(): void {
    if (this.released) return;
    this.released = true;
    this.onReleased();
  }

  private requireActive(): void {
    if (this.released) throw new Error("Background session lease is released");
  }
}

function snapshotFromStatus(status: Awaited<ReturnType<PiSessionService["status"]>>): BackgroundSessionSnapshot {
  return Object.freeze({
    sessionId: status.sessionId,
    status: status.isStreaming || status.isCompacting || status.isBashRunning || status.pendingMessageCount > 0 ? "running" : "idle",
    ...(status.model?.provider === undefined || status.model.id === undefined || status.model.name === undefined
      ? {}
      : { model: Object.freeze({ provider: status.model.provider, id: status.model.id, name: status.model.name }) }),
    thinkingLevel: status.thinkingLevel ?? "off",
    usage: usageFromStatus(status),
  });
}

function usageFromStatus(status: Awaited<ReturnType<PiSessionService["status"]>>): BackgroundSessionUsage {
  return Object.freeze({ ...status.tokens, estimatedCostUsd: Number.isFinite(status.cost) ? Math.max(0, status.cost) : 0 });
}

function requireId(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} is required`);
  return normalized;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
