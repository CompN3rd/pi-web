import { describe, expect, it, vi } from "vitest";
import type { SessionStatus, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { PluginBackgroundSessionRegistry } from "./pluginBackgroundSessionService.js";

const project: Project = { id: "p1", name: "Project", path: "/repo", createdAt: "2026-08-01T00:00:00.000Z" };
const workspace = { id: "w1", projectId: "p1", path: "/repo/worktree", label: "feature", isMain: false };
function status(running = false): SessionStatus {
  return {
    sessionId: "s1",
    model: { provider: "anthropic", id: "model", name: "Model" },
    thinkingLevel: "medium",
    isStreaming: running,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    cost: 0.25,
  };
}
function authority(current: WorkspaceProviderAuthorityResolution) {
  return { resolve: () => Promise.resolve(current) };
}
function resolution(): WorkspaceProviderAuthorityResolution {
  return { status: "folder", projectId: "p1", workspaces: [workspace], diagnostics: [] };
}

function sessionHost() {
  return {
    backgroundSessionModels: vi.fn(() => [{ provider: "anthropic", id: "model", name: "Model", thinkingLevels: ["medium"] }]),
    startBackgroundSession: vi.fn(() => Promise.resolve({
      session: { id: "s1", path: "/sessions/s1.jsonl", cwd: workspace.path, created: "2026-08-01T00:00:00.000Z", modified: "2026-08-01T00:00:00.000Z", messageCount: 0, firstMessage: "" },
      status: status(),
    })),
    promptBackgroundSession: vi.fn(() => Promise.resolve(status())),
    backgroundSessionStatus: vi.fn(() => Promise.resolve(status(true))),
    abortBackgroundSession: vi.fn(() => Promise.resolve()),
    forceStopBackgroundSession: vi.fn(() => Promise.resolve()),
    releaseBackgroundSession: vi.fn(),
  };
}

describe("PluginBackgroundSessionRegistry", () => {
  it("revalidates authoritative workspace identity and binds plugin ownership", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry(
      { requireProject: (id) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found")) },
      authority(resolution()),
      sessions,
    );
    const service = registry.forPlugin("automations");

    const lease = await service.create({ projectId: "p1", workspaceId: "w1", model: { provider: "anthropic", id: "model" }, thinkingLevel: "medium" });
    expect(sessions.startBackgroundSession).toHaveBeenCalledWith("automations", workspace.path, {
      model: { provider: "anthropic", id: "model" },
      thinkingLevel: "medium",
    });
    await expect(lease.snapshot()).resolves.toMatchObject({ sessionId: "s1", status: "running" });
    await expect(lease.prompt("work")).resolves.toEqual({
      status: "completed",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, estimatedCostUsd: 0.25 },
    });
    expect(sessions.releaseBackgroundSession).toHaveBeenCalledWith("automations", { id: "s1", cwd: workspace.path });
  });

  it("fails closed for stale or degraded workspaces", async () => {
    const sessions = sessionHost();
    const current = resolution();
    const workspaces = authority(current);
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, workspaces, sessions);
    const service = registry.forPlugin("automations");

    await expect(service.create({ projectId: "p1", workspaceId: "stale" })).rejects.toThrow("Workspace not found");
    workspaces.resolve = () => Promise.resolve({ status: "degraded", projectId: "p1", workspaces: [workspace], diagnostics: [] });
    await expect(service.create({ projectId: "p1", workspaceId: "w1" })).rejects.toThrow("authority is degraded");
    expect(sessions.startBackgroundSession).not.toHaveBeenCalled();
  });

  it("reports cancellation and releases ownership after the awaited prompt settles", async () => {
    const sessions = sessionHost();
    let settlePrompt: ((value: SessionStatus) => void) | undefined;
    sessions.promptBackgroundSession.mockImplementation(() => new Promise((resolvePrompt) => { settlePrompt = resolvePrompt; }));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const lease = await registry.forPlugin("automations").create({ projectId: "p1", workspaceId: "w1" });

    const prompt = lease.prompt("work");
    await lease.abort();
    settlePrompt?.(status());

    await expect(prompt).resolves.toMatchObject({ status: "aborted" });
    expect(sessions.abortBackgroundSession).toHaveBeenCalledOnce();
    expect(sessions.releaseBackgroundSession).toHaveBeenCalledOnce();
  });

  it("force-stops every outstanding lease during quiesce", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const service = registry.forPlugin("automations");
    await service.create({ projectId: "p1", workspaceId: "w1" });

    await registry.quiesceAll();
    await registry.quiesceAll();

    expect(sessions.forceStopBackgroundSession).toHaveBeenCalledOnce();
    expect(sessions.releaseBackgroundSession).not.toHaveBeenCalled();
  });
});
