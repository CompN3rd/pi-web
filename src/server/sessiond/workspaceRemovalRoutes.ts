import type { FastifyInstance, FastifyReply } from "fastify";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { workspaceRemovalHttpStatus } from "../workspaces/workspaceRemovalService.js";

export interface WorkspaceRemovalProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface WorkspaceRemover {
  remove(project: Project, workspaceId: string): Promise<TerminalCommandRun>;
}

export interface WorkspaceRemovalRouteDependencies {
  projects: WorkspaceRemovalProjectReader;
  removals: WorkspaceRemover;
}

/** Internal sessiond endpoint for host-orchestrated provider workspace removal. */
export function registerWorkspaceRemovalRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceRemovalRouteDependencies,
  prefix = "/workspace-removals",
): void {
  app.delete<{ Params: { projectId: string; workspaceId: string } }>(
    `${prefix}/projects/:projectId/workspaces/:workspaceId`,
    async (request, reply) => {
      let project: Project;
      try {
        project = await dependencies.projects.requireProject(request.params.projectId);
      } catch (error) {
        const message = errorMessage(error);
        return reply.code(message === "Project not found" ? 404 : 500).send({ error: message });
      }

      try {
        return await dependencies.removals.remove(project, request.params.workspaceId);
      } catch (error) {
        return removalRequestFailed(reply, error);
      }
    },
  );
}

function removalRequestFailed(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(workspaceRemovalHttpStatus(error)).send({ error: errorMessage(error) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
