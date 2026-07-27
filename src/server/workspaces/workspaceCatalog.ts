import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import type { Workspace } from "../../shared/apiTypes.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginRuntimeRecord,
} from "../plugins/serverPluginRuntime.js";

/** Web-side port for sessiond's authoritative, live workspace catalog. */
export interface WorkspaceCatalog {
  list(projectId: string): Promise<Workspace[]>;
  resolve(projectId: string, workspaceId: string): Promise<Workspace>;
}

/** Immutable startup snapshot used to reconcile desired plugins in a later UI slice. */
export interface WorkspaceProviderRuntimeSnapshot {
  safeStart?: ServerPluginSafeStart;
  records: readonly ServerPluginRuntimeRecord[];
  health: readonly ServerPluginHealthInspection[];
}

export function createWorkspaceProviderRuntimeSnapshot(
  records: readonly ServerPluginRuntimeRecord[],
  health: readonly ServerPluginHealthInspection[],
  safeStart?: ServerPluginSafeStart,
): WorkspaceProviderRuntimeSnapshot {
  return Object.freeze({
    ...(safeStart === undefined ? {} : { safeStart }),
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    health: Object.freeze(health.map((inspection) => Object.freeze({
      ...inspection,
      health: Object.freeze({ ...inspection.health }),
    }))),
  });
}

export class WorkspaceCatalogUnavailableError extends Error {
  override name = "WorkspaceCatalogUnavailableError";
}

export class WorkspaceCatalogProtocolError extends Error {
  override name = "WorkspaceCatalogProtocolError";
}

export class WorkspaceCatalogRequestError extends Error {
  override name = "WorkspaceCatalogRequestError";

  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

/** Preserve route-specific legacy status codes while making authority failures explicit. */
export function workspaceCatalogHttpStatus(error: unknown, fallbackStatus: number): number {
  if (error instanceof WorkspaceCatalogUnavailableError) return 503;
  if (error instanceof WorkspaceCatalogProtocolError) return 502;
  if (error instanceof WorkspaceCatalogRequestError) {
    if (error.statusCode === 503) return 503;
    if (error.statusCode >= 500) return 502;
  }
  return fallbackStatus;
}

/**
 * Browser plugin v1 requires Git-shaped fields. During the migration, an owner
 * may publish those deprecated values as public metadata; core does not branch
 * on provider identity and replacements are not required to publish them.
 */
export function withBrowserV1WorkspaceCompatibility(workspace: Workspace): Workspace {
  const metadata = workspace.provider?.metadata;
  if (metadata === undefined) return workspace;

  const branch = metadata["branch"];
  const isGitRepo = metadata["isGitRepo"];
  const isGitWorktree = metadata["isGitWorktree"];
  return {
    ...workspace,
    ...(typeof branch === "string" ? { branch } : {}),
    ...(typeof isGitRepo === "boolean" ? { isGitRepo } : {}),
    ...(typeof isGitWorktree === "boolean" ? { isGitWorktree } : {}),
  };
}
