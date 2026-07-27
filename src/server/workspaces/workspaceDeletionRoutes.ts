import type { FastifyInstance, FastifyReply } from "fastify";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";

/** Browser-facing adapter; sessiond owns all workspace removal decisions and effects. */
export function registerWorkspaceDeletionRoutes(
  app: FastifyInstance,
  daemon: SessionProxyDaemon = new SessionDaemonClient(),
  prefix = "/api",
): void {
  app.delete<{ Params: { projectId: string; workspaceId: string } }>(
    `${prefix}/projects/:projectId/workspaces/:workspaceId`,
    async (request, reply) => {
      try {
        const upstream = await daemon.request(
          "DELETE",
          `/workspace-removals/projects/${encodeURIComponent(request.params.projectId)}/workspaces/${encodeURIComponent(request.params.workspaceId)}`,
        );
        return proxyJsonResponse(reply, upstream);
      } catch (error) {
        return reply.code(502).send({
          error: `Session daemon unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );
}

function proxyJsonResponse(
  reply: FastifyReply,
  upstream: { statusCode: number; headers: Record<string, string>; body: string },
): unknown {
  reply.code(upstream.statusCode);
  const contentType = upstream.headers["content-type"];
  if (contentType !== undefined && contentType !== "") reply.header("content-type", contentType);
  if (upstream.body === "") return undefined;
  try {
    const value: unknown = JSON.parse(upstream.body);
    return value;
  } catch (error) {
    return reply.code(502).send({
      error: `Invalid session daemon workspace removal response: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
