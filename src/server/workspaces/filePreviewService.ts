import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FileContentMediaType, PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { classifyWorkspaceFile, MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

export interface WorkspaceFilePreview {
  path: string;
  filename: string;
  mediaType?: FileContentMediaType;
  size: number;
  modifiedAt: string;
  stream: ReadStream;
}

export interface ReadWorkspaceFilePreviewOptions {
  download?: boolean;
}

export async function readWorkspaceFilePreview(
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebPathAccessConfig,
  options: ReadWorkspaceFilePreviewOptions = {},
): Promise<WorkspaceFilePreview> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const filename = basename(displayPath);
  const modifiedAt = s.mtime.toISOString();

  // Download mode serves any file as an opaque octet-stream attachment. No size
  // cap: the response is streamed, and the browser writes it straight to disk.
  if (options.download === true) {
    return { path: displayPath, filename, size: s.size, modifiedAt, stream: createReadStream(target) };
  }

  const classification = classifyWorkspaceFile(displayPath);
  if (classification === undefined || !("previewMimeType" in classification)) throw new Error("Inline preview is not supported for this file type");
  if (s.size > MAX_INLINE_PREVIEW_BYTES) throw new Error(`File is too large to preview (limit ${MAX_INLINE_PREVIEW_LABEL})`);
  return { path: displayPath, filename, mediaType: classification.mediaType, size: s.size, modifiedAt, stream: createReadStream(target) };
}
