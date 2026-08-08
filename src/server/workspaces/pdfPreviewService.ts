import type { ReadStream } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import type { PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { MAX_PDF_PREVIEW_BYTES, MAX_PDF_PREVIEW_LABEL } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

export interface WorkspacePdfPreview {
  path: string;
  mimeType: "application/pdf";
  size: number;
  modifiedAt: string;
  disposition: string;
  range: PdfByteRange | undefined;
  contentLength: number;
  stream: ReadStream;
}

export interface PdfByteRange {
  start: number;
  end: number;
}

export interface PdfPreviewReadDependencies {
  /** Test seam for a deterministic path-replacement race after the descriptor opens. */
  afterOpen?: () => void | Promise<void>;
}

export class PdfRangeNotSatisfiableError extends Error {
  constructor(readonly size: number, message = "PDF byte range is not satisfiable") {
    super(message);
    this.name = "PdfRangeNotSatisfiableError";
  }
}

export async function readWorkspacePdfPreview(
  rootPath: string,
  path: string | undefined,
  rangeHeader: string | undefined,
  pathAccess?: PiWebPathAccessConfig,
  dependencies: PdfPreviewReadDependencies = {},
): Promise<WorkspacePdfPreview> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const resolved = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  if (extname(resolved.displayPath).toLowerCase() !== ".pdf") throw new Error("PDF preview requires a .pdf file");

  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved.target, "r");
    await dependencies.afterOpen?.();
    const stats = await verifiedOpenedFileStats(handle, resolved.target, resolved.root);
    if (!stats.isFile()) throw new Error("Path is not a regular file");
    if (stats.size > MAX_PDF_PREVIEW_BYTES) throw new Error(`PDF is too large to preview (limit ${MAX_PDF_PREVIEW_LABEL})`);
    if (stats.size < PDF_MAGIC.length) throw new Error("File is not a PDF");

    const magic = Buffer.alloc(PDF_MAGIC.length);
    const read = await handle.read(magic, 0, magic.length, 0);
    if (read.bytesRead !== PDF_MAGIC.length || !magic.equals(PDF_MAGIC)) throw new Error("File is not a PDF");

    const range = parsePdfByteRange(rangeHeader, stats.size);
    const contentLength = range === undefined ? stats.size : range.end - range.start + 1;
    // Always set an end offset: the validated descriptor may refer to a file
    // another trusted local process can append to while the response is open.
    const stream = handle.createReadStream({
      start: range?.start ?? 0,
      end: range?.end ?? stats.size - 1,
      autoClose: true,
    });
    handle = undefined;
    return {
      path: resolved.displayPath,
      mimeType: "application/pdf",
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      disposition: inlinePdfDisposition(resolved.displayPath),
      range,
      contentLength,
      stream,
    };
  } finally {
    await handle?.close();
  }
}

export function parsePdfByteRange(header: string | undefined, size: number): PdfByteRange | undefined {
  if (header === undefined || header.trim() === "") return undefined;
  const value = header.trim();
  // Unsupported units, malformed syntax, and multipart requests are ignored so
  // the caller serves the complete representation as permitted by HTTP.
  if (value.includes(",")) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value);
  if (match === null) return undefined;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return undefined;
  if (!Number.isSafeInteger(size) || size <= 0) throw new PdfRangeNotSatisfiableError(Math.max(0, size));

  const representationSize = BigInt(size);
  if (startText === "") {
    const suffixLength = parseRangeInteger(endText);
    if (suffixLength === undefined) return undefined;
    if (suffixLength <= 0n) throw new PdfRangeNotSatisfiableError(size);
    const start = suffixLength >= representationSize ? 0 : size - Number(suffixLength);
    return { start, end: size - 1 };
  }

  const startValue = parseRangeInteger(startText);
  if (startValue === undefined) return undefined;
  if (startValue >= representationSize) throw new PdfRangeNotSatisfiableError(size);
  const start = Number(startValue);
  if (endText === "") return { start, end: size - 1 };
  const requestedEnd = parseRangeInteger(endText);
  if (requestedEnd === undefined || requestedEnd < startValue) return undefined;
  const end = requestedEnd >= representationSize ? size - 1 : Number(requestedEnd);
  return { start, end };
}

export function inlinePdfDisposition(path: string): string {
  const original = basename(path).replace(/[\r\n]/gu, "_");
  const ascii = original.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_") || "document.pdf";
  const encoded = encodeURIComponent(original).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function verifiedOpenedFileStats(handle: FileHandle, target: string, root: string) {
  const descriptorIdentity = await handle.stat({ bigint: true });
  const currentTarget = await realpath(target);
  if (!isInsideOrSame(root, currentTarget)) throw new Error("PDF path changed outside its approved root while opening");
  const currentIdentity = await stat(currentTarget, { bigint: true });
  if (descriptorIdentity.dev !== currentIdentity.dev || descriptorIdentity.ino !== currentIdentity.ino) {
    throw new Error("PDF path changed while opening");
  }
  return await handle.stat();
}

function isInsideOrSame(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function parseRangeInteger(value: string): bigint | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  return BigInt(value);
}
