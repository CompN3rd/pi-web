import type { Project, Workspace } from "../types.js";

export interface AutomationProjectProvider {
  requireProject(id: string): Promise<Project>;
}

export interface AutomationWorkspaceProvider {
  list(project: Project): Promise<Workspace[]>;
}

export class AutomationWorkspaceAuthorizer {
  constructor(
    private readonly projects: AutomationProjectProvider,
    private readonly workspaces: AutomationWorkspaceProvider,
  ) {}

  async requireWorkspace(projectId: string, workspaceId: string): Promise<Workspace> {
    const project = await this.projects.requireProject(requireId(projectId, "projectId"));
    const workspace = (await this.workspaces.list(project)).find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) throw new Error("Workspace not found");
    return workspace;
  }
}

function requireId(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${name} is required`);
  return normalized;
}
