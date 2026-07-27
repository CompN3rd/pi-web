import type { ProjectService } from "../projects/projectService.js";
import type { Project, Workspace } from "../types.js";
import { cwdPathsEqual } from "../workingDirectory.js";
import type { WorkspaceCatalog } from "./workspaceCatalog.js";

export interface WorkspaceContext {
  project: Project;
  workspace: Workspace;
  root: string;
}

export async function resolveWorkspaceContext(
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const project = await projects.requireProject(projectId);
  const workspace = await workspaces.resolve(project.id, workspaceId);
  return { project, workspace, root: workspace.path };
}

export async function resolveWorkspaceContextForCwd(
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  cwd: string,
): Promise<WorkspaceContext> {
  for (const project of await projects.list()) {
    const workspace = (await workspaces.list(project.id)).find((candidate) => cwdPathsEqual(candidate.path, cwd));
    if (workspace !== undefined) return { project, workspace, root: workspace.path };
  }
  throw new Error("Workspace not found");
}
