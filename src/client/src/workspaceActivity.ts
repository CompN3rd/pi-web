import type { Project, Workspace } from "./api";

export function projectOwnsWorkspacePath(project: Project, knownWorkspaces: readonly Workspace[], cwd: string): boolean {
  return knownWorkspaces.some((workspace) => workspace.projectId === project.id && workspace.path === cwd)
    || cwd === project.path
    || cwd.startsWith(`${project.path}/`);
}
