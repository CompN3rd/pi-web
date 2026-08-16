import type { FastifyInstance } from "fastify";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { WorkspaceTrustResponse } from "../shared/apiTypes.js";
import type { ProjectService } from "./projects/projectService.js";
import type { WorkspaceCatalog } from "./workspaces/workspaceCatalog.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";

/**
 * Collaborators the trust routes read from the surrounding app: the active
 * agent directory (which owns `trust.json`) and whether PI WEB currently
 * honors project trust at session start.
 */
export interface ProjectTrustRouteDeps {
  agentDir: () => Promise<string>;
  respectProjectTrust: () => Promise<boolean>;
}

/**
 * Read/write per-project Pi trust for a workspace. The workspace path is
 * resolved server-side from the project/workspace ids, so a client can only
 * set trust for a path PI WEB already manages — never an arbitrary path.
 */
export function registerProjectTrustRoutes(
  app: FastifyInstance,
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  deps: ProjectTrustRouteDeps,
  prefix = "/api",
): void {
  const route = `${prefix}/projects/:projectId/workspaces/:workspaceId/trust`;

  async function describe(path: string): Promise<WorkspaceTrustResponse> {
    const agentDir = await deps.agentDir();
    const decision = new ProjectTrustStore(agentDir).get(path);
    const trusted = decision ?? SettingsManager.create(path, agentDir).getDefaultProjectTrust() === "always";
    return { path, decision, trusted, respectProjectTrust: await deps.respectProjectTrust() };
  }

  app.get<{ Params: { projectId: string; workspaceId: string } }>(route, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await describe(context.root);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: { trusted?: unknown } }>(route, async (request, reply) => {
    if (typeof request.body.trusted !== "boolean") {
      return reply.code(400).send({ error: "trusted must be a boolean" });
    }
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const agentDir = await deps.agentDir();
      // Writes go through the SDK store's file lock; an EACCES here (e.g. a
      // read-only, admin-controlled trust.json) surfaces to the client rather
      // than being swallowed.
      new ProjectTrustStore(agentDir).set(context.root, request.body.trusted);
      return await describe(context.root);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
