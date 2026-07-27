import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { TerminalCommandRun, Workspace } from "../../shared/apiTypes.js";
import { workspaceDeletionMetadata } from "../../shared/workspaceDeletion.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/terminalService.js";
import {
  WorkspaceProviderRemovalError,
  type WorkspaceProviderRemovalTarget,
} from "./workspaceProviderRegistry.js";

export interface WorkspaceRemovalProvider {
  resolveRemoval(project: Project, workspaceId: string): Promise<WorkspaceProviderRemovalTarget>;
}

export interface WorkspaceRemovalTerminalHost {
  closeForCwd(cwd: string): void;
  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun;
}

export class WorkspaceRemovalError extends Error {
  override name = "WorkspaceRemovalError";

  constructor(message: string, readonly statusCode = 400, options: ErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * Sessiond-owned removal orchestration. Providers validate and plan their native
 * operation; the host retains generic path safety, terminal lifetime, and the
 * visible command-run contract.
 */
export class WorkspaceRemovalService {
  constructor(
    private readonly providers: WorkspaceRemovalProvider,
    private readonly terminals: WorkspaceRemovalTerminalHost,
  ) {}

  async remove(project: Project, workspaceId: string): Promise<TerminalCommandRun> {
    const current = await this.providers.resolveRemoval(project, workspaceId);
    const { target, commandWorkspace } = validateCurrentRemoval(project, workspaceId, current);
    const plan = await current.prepare();

    try {
      this.terminals.closeForCwd(target.path);
    } catch (error) {
      throw new WorkspaceRemovalError(
        `Failed to close workspace terminals: ${errorMessage(error)}`,
        400,
        { cause: error },
      );
    }

    try {
      return this.terminals.runCommand({
        origin: "core",
        projectId: project.id,
        workspaceId: commandWorkspace.id,
        cwd: commandWorkspace.path,
        title: plan.title,
        command: plan.command,
        metadata: workspaceDeletionMetadata(target),
      });
    } catch (error) {
      throw new WorkspaceRemovalError(
        `Failed to start workspace removal: ${errorMessage(error)}`,
        400,
        { cause: error },
      );
    }
  }
}

export function workspaceRemovalHttpStatus(error: unknown, fallback = 500): number {
  if (error instanceof WorkspaceRemovalError || error instanceof WorkspaceProviderRemovalError) {
    return error.statusCode;
  }
  return fallback;
}

function validateCurrentRemoval(
  project: Project,
  workspaceId: string,
  current: WorkspaceProviderRemovalTarget,
): { target: Workspace; commandWorkspace: Workspace } {
  const target = current.workspaces.find((workspace) => workspace.id === workspaceId);
  if (target?.id !== current.target.id || target.path !== current.target.path) {
    throw new WorkspaceRemovalError("Workspace is no longer current", 409);
  }
  if (target.projectId !== project.id) {
    throw new WorkspaceRemovalError("Workspace does not belong to the registered project", 409);
  }
  if (target.provider?.pluginId !== current.ownerPluginId) {
    throw new WorkspaceRemovalError("Workspace owner is no longer current", 409);
  }
  if (target.removal === undefined || !target.provider.capabilities.remove) {
    throw new WorkspaceRemovalError("Workspace removal is not available", 409);
  }
  if (target.isMain) throw new WorkspaceRemovalError("The main workspace cannot be removed");

  const targetPath = requireAbsolutePath(target.path, "Workspace path");
  const projectPath = requireAbsolutePath(project.path, "Project path");
  if (parse(targetPath).root === targetPath) {
    throw new WorkspaceRemovalError("The filesystem root cannot be removed as a workspace");
  }
  if (targetPath === projectPath) {
    throw new WorkspaceRemovalError("A workspace cannot remove the registered project itself");
  }
  if (isPathAncestor(targetPath, projectPath)) {
    throw new WorkspaceRemovalError("A workspace containing the registered project cannot be removed");
  }

  const candidates = current.workspaces.filter((workspace) => {
    if (workspace.id === target.id || workspace.projectId !== project.id) return false;
    const candidatePath = requireAbsolutePath(workspace.path, "Command workspace path");
    return candidatePath !== targetPath && !isSameOrAncestor(targetPath, candidatePath);
  });
  const commandWorkspace = candidates.find((workspace) => workspace.isMain) ?? candidates[0];
  if (commandWorkspace === undefined) {
    throw new WorkspaceRemovalError("A current non-target command workspace is required", 409);
  }

  return { target, commandWorkspace };
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new WorkspaceRemovalError(`${label} must be absolute`);
  return resolve(value);
}

function isPathAncestor(ancestor: string, descendant: string): boolean {
  const value = relative(ancestor, descendant);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function isSameOrAncestor(ancestor: string, descendant: string): boolean {
  return ancestor === descendant || isPathAncestor(ancestor, descendant);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
