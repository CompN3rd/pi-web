import type { FastifyInstance } from "fastify";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import { sendWorkspaceRequestError } from "./workspaces/workspaceRouteErrors.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { gitDiff, gitStatus } from "./git/gitService.js";

export function registerGitRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceCatalog, prefix = "/api"): void {
  app.get<{ Params: { projectId: string; workspaceId: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/git/status`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await gitStatus(context.root);
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string; staged?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/git/diff`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await gitDiff(context.root, { ...(request.query.path === undefined ? {} : { path: request.query.path }), staged: request.query.staged === "true" });
    } catch (error) {
      return sendWorkspaceRequestError(reply, error, 400);
    }
  });
}
