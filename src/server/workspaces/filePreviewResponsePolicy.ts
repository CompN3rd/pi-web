import { basename } from "node:path";
import { classifyWorkspaceFile } from "../../shared/workspaceFiles.js";

export interface WorkspaceFilePreviewResponsePolicy {
  readonly contentType: string;
  readonly contentDisposition: string;
  readonly contentSecurityPolicy: string;
  readonly contentTypeOptions: "nosniff";
}

const IMAGE_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
const HTML_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'; frame-ancestors 'self'";
// Native PDF viewers commonly require a non-opaque document origin. The
// embedding iframe supplies the only sandbox allowance (`allow-same-origin`),
// while this policy still denies scripts, navigation helpers, and subresources.
const PDF_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'self'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'self'";
const DOWNLOAD_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; worker-src 'none'; frame-ancestors 'none'";

export function workspaceFilePreviewResponsePolicy(path: string, options: { download?: boolean } = {}): WorkspaceFilePreviewResponsePolicy {
  const filename = workspaceFileName(path);
  if (options.download === true) {
    return responsePolicy("application/octet-stream", "attachment", filename, DOWNLOAD_CONTENT_SECURITY_POLICY);
  }

  const classification = classifyWorkspaceFile(path);
  if (classification === undefined || !("previewMimeType" in classification)) {
    throw new Error("Inline preview is not supported for this file type");
  }

  const contentSecurityPolicy = classification.mediaType === "image"
    ? IMAGE_CONTENT_SECURITY_POLICY
    : classification.mediaType === "html"
      ? HTML_CONTENT_SECURITY_POLICY
      : PDF_CONTENT_SECURITY_POLICY;
  return responsePolicy(classification.previewMimeType, "inline", filename, contentSecurityPolicy);
}

function responsePolicy(contentType: string, disposition: "inline" | "attachment", filename: string, contentSecurityPolicy: string): WorkspaceFilePreviewResponsePolicy {
  return {
    contentType,
    contentDisposition: contentDisposition(disposition, filename),
    contentSecurityPolicy,
    contentTypeOptions: "nosniff",
  };
}

function workspaceFileName(path: string): string {
  const filename = basename(path);
  if (filename === "") throw new Error("Workspace file path must include a filename");
  return filename;
}

function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
