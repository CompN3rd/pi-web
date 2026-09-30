import { workspaceFilePreviewUrl } from "../api/urls";
import type { MarkdownWorkspaceContext } from "./workspaceLinks";
import "../components/MarkdownImage";

/** Local Markdown destinations are filesystem references, not website routes. */
export function localMarkdownImage(reference: string, root: string): { path: string; outside: boolean } | undefined {
  const driveReference = /^[a-z]:[\\/]/iu.test(reference);
  if (reference === "" || /^[#?]/u.test(reference) || reference.startsWith("//")
    || (!driveReference && /^[a-z][a-z\d+.-]*:/iu.test(reference))) return undefined;
  let path: string;
  try { path = decodeURIComponent(reference.split(/[?#]/u, 1)[0] ?? ""); } catch { return undefined; }
  // eslint-disable-next-line no-control-regex -- Filesystem references cannot contain control characters.
  if (path === "" || /[\u0000-\u001f\u007f]/u.test(path)) return undefined;
  // Native absolute paths are never URL schemes. Require approval and let the
  // server resolve volume/UNC identities and traversal using its own platform.
  if (/^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\") || path.startsWith("~\\")) return { path, outside: true };
  if (path.includes("\\")) return undefined;
  if (path.startsWith("~/")) return { path, outside: true };
  const isAbsolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (!isAbsolute) segments.push(segment);
    } else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  // Keep URL-style relative paths independent of the server's POSIX/Windows/UNC root.
  // Traversal and normalized home/drive prefixes require opt-in before native server resolution.
  if (!isAbsolute) {
    const relative = segments.join("/");
    const outside = segments[0] === ".." || segments[0] === "~" || /^[a-z]:/iu.test(relative);
    return { path: relative || ".", outside };
  }
  const absolute = `/${segments.join("/")}`;
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  return absolute.startsWith(prefix)
    ? { path: absolute.slice(prefix.length), outside: false }
    : { path: absolute, outside: true };
}

export function replaceLocalMarkdownImages(root: DocumentFragment, workspace: MarkdownWorkspaceContext, identity?: string): void {
  root.querySelectorAll("img[src]").forEach((image, index) => {
    const local = localMarkdownImage(image.getAttribute("src") ?? "", workspace.root);
    if (local === undefined) return;
    const preview = document.createElement("pi-web-markdown-image");
    preview.setAttribute("path", local.path);
    preview.setAttribute("description", image.getAttribute("alt") ?? "");
    if (identity !== undefined) preview.setAttribute("intent-key", JSON.stringify([identity, index]));
    preview.setAttribute("preview-url", workspaceFilePreviewUrl(workspace.projectId, workspace.workspaceId, local.path, {
      machineId: workspace.machineId, showImage: local.outside,
    }));
    if (local.outside) preview.setAttribute("outside", "");
    image.replaceWith(preview);
  });
}
