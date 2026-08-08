import type { FastifyInstance } from "fastify";
import type { WriteWorkspaceFileOptions } from "../shared/apiTypes.js";
import type { PiWebConfigService } from "./configRoutes.js";
import type { ProjectService } from "./projects/projectService.js";
import { deleteWorkspaceFile, moveWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "./workspaces/fileContentService.js";
import { isAbsoluteishFileSuggestionQuery, listFileSuggestions, listPathSuggestions } from "./workspaces/fileSuggestions.js";
import { listWorkspaceTree } from "./workspaces/fileTreeService.js";
import { readWorkspaceImagePreview } from "./workspaces/imagePreviewService.js";
import { PdfRangeNotSatisfiableError, readWorkspacePdfPreview } from "./workspaces/pdfPreviewService.js";
import { resolveWorkspaceContext } from "./workspaces/workspaceContext.js";
import { pathAccessForWorkspaceContext } from "./workspaces/effectivePathAccess.js";
import type { WorkspaceService } from "./workspaces/workspaceService.js";

export interface WorkspaceExplorerRouteOptions {
  config?: Pick<PiWebConfigService, "read">;
}

export function registerWorkspaceExplorerRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, prefix = "/api", options: WorkspaceExplorerRouteOptions = {}): void {
  registerWorkspaceFileContentParsers(app);

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/tree`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await listWorkspaceTree(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await readWorkspaceFile(context.root, request.query.path, await pathAccessForWorkspaceContext(context, options.config));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { projectId: string; workspaceId: string }; Body: Buffer; Querystring: { path?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const writeOptions: WriteWorkspaceFileOptions = {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite !== "false",
      };
      return await writeWorkspaceFile(context.root, request.query.path, request.body, writeOptions);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await deleteWorkspaceFile(context.root, request.query.path);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { projectId: string; workspaceId: string }; Querystring: { fromPath?: string; toPath?: string; createDirs?: string; overwrite?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/move`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      return await moveWorkspaceFile(context.root, request.query.fromPath, request.query.toPath, {
        createDirs: request.query.createDirs !== "false",
        overwrite: request.query.overwrite === "true",
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/preview`, { config: { compress: false } }, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const pathAccess = await pathAccessForWorkspaceContext(context, options.config);
      if (request.query.path?.toLowerCase().endsWith(".pdf") === true) {
        // A validator-bearing If-Range request is served conservatively in full;
        // this route does not expose a stable strong validator for PDFs yet.
        const range = request.headers["if-range"] === undefined ? firstHeaderValue(request.headers.range) : undefined;
        const preview = await readWorkspacePdfPreview(context.root, request.query.path, range, pathAccess);
        const response = reply
          .code(preview.range === undefined ? 200 : 206)
          .type(preview.mimeType)
          .header("Accept-Ranges", "bytes")
          .header("Cache-Control", "private, max-age=3600")
          .header("Content-Disposition", preview.disposition)
          .header("Content-Encoding", "identity")
          .header("Content-Length", String(preview.contentLength))
          .header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'")
          .header("Cross-Origin-Resource-Policy", "same-origin")
          .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
          .header("X-Content-Type-Options", "nosniff");
        if (preview.range !== undefined) response.header("Content-Range", `bytes ${String(preview.range.start)}-${String(preview.range.end)}/${String(preview.size)}`);
        return await response.send(preview.stream);
      }

      const preview = await readWorkspaceImagePreview(context.root, request.query.path, pathAccess);
      return await reply
        .type(preview.mimeType)
        .header("Cache-Control", "private, max-age=3600")
        .header("Content-Length", String(preview.size))
        .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'")
        .header("Last-Modified", new Date(preview.modifiedAt).toUTCString())
        .header("X-Content-Type-Options", "nosniff")
        .send(preview.stream);
    } catch (error) {
      if (error instanceof PdfRangeNotSatisfiableError) {
        return reply
          .code(416)
          .header("Accept-Ranges", "bytes")
          .header("Content-Encoding", "identity")
          .header("Content-Range", `bytes */${String(error.size)}`)
          .send({ error: error.message });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { q?: string; kind?: "tracked" | "untracked" | "other"; mode?: "file" | "path"; scope?: "tracked" | "all" } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/files`, async (request, reply) => {
    try {
      const context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId);
      const query = request.query.q ?? "";
      const pathAccess = isAbsoluteishFileSuggestionQuery(query) ? await pathAccessForWorkspaceContext(context, options.config) : undefined;
      if (request.query.mode === "path") return await listPathSuggestions(context.root, query, pathAccess);
      return await listFileSuggestions(context.root, query, { kind: request.query.kind, scope: request.query.scope, pathAccess });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function registerWorkspaceFileContentParsers(app: FastifyInstance): void {
  // Fastify's default parser only handles JSON; workspace file writes need to
  // accept text and arbitrary binary payloads. This route module is registered
  // for both local aliases, so parser registration must tolerate repeats.
  try { app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => { done(null, Buffer.from(body)); }); } catch { /* already registered */ }
  try { app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
  try { app.addContentTypeParser(/^([a-z]+\/[a-z0-9.+-]+)$/u, { parseAs: "buffer" }, (_request, body, done) => { done(null, body); }); } catch { /* already registered */ }
}
