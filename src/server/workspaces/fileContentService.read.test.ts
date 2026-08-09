import { mkdir, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_INLINE_PREVIEW_BYTES, MAX_WORKSPACE_FILE_CONTENT_BYTES } from "../../shared/workspaceFiles.js";
import { readWorkspaceFile } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";
import { readWorkspaceFilePreview } from "./filePreviewService.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("readWorkspaceFile", () => {
  it("reads text files with normalized paths and language metadata", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), "const answer = 42;\n");

    const file = await readWorkspaceFile(root, "./src//main.ts");

    expect(file).toMatchObject({
      path: "src/main.ts",
      language: "typescript",
      encoding: "utf8",
      content: "const answer = 42;\n",
      truncated: false,
      binary: false,
    });
    expect(file.size).toBe(19);
    expect(Date.parse(file.modifiedAt)).not.toBeNaN();
  });

  it("rejects missing paths, directories, traversal, and absolute paths", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "dir"));

    await expect(readWorkspaceFile(root, undefined)).rejects.toThrow("path query parameter is required");
    await expect(readWorkspaceFile(root, "dir")).rejects.toThrow("Path is not a file");
    await expect(readWorkspaceFile(root, "missing.txt")).rejects.toThrow("Path does not exist");
    await expect(readWorkspaceFile(root, "../secret.txt")).rejects.toThrow("Path traversal is not allowed");
    await expect(readWorkspaceFile(root, "/etc/passwd")).rejects.toThrow("Absolute paths are not allowed");
  });

  it("reads allowed absolute files outside the workspace", async () => {
    const root = await createTempWorkspace();
    const external = await createTempWorkspace();
    await writeFile(join(external, "README.md"), "external docs\n");

    const file = await readWorkspaceFile(root, join(external, "README.md"), { allowedPaths: [external] });

    expect(file).toMatchObject({
      path: join(external, "README.md"),
      language: "markdown",
      content: "external docs\n",
      truncated: false,
      binary: false,
    });
    await expect(readWorkspaceFile(root, join(external, "README.md"))).rejects.toThrow("Absolute paths are not allowed");
  });

  it("detects binary files and omits binary content", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "image.bin"), Buffer.from([0x66, 0x6f, 0x00, 0x6f]));

    const file = await readWorkspaceFile(root, "image.bin");

    expect(file).toMatchObject({ content: "", binary: true, truncated: false });
    expect(file.size).toBe(4);
  });

  it("marks supported images as previewable", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "logo.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const file = await readWorkspaceFile(root, "logo.PNG");

    expect(file).toMatchObject({ mediaType: "image", mimeType: "image/png", content: "", binary: true, truncated: false });
    expect(file.size).toBe(9);
  });

  it("preserves literal HTML and Markdown source while keeping PDF bytes out of JSON", async () => {
    const root = await createTempWorkspace();
    const html = "<h1>hi</h1><script>window.top.location = '/stolen'</script>";
    const markdown = "# Notes\n\n<img src=x onerror=alert(1)>\n";
    await writeFile(join(root, "report.html"), html);
    await writeFile(join(root, "README.MD"), markdown);
    await writeFile(join(root, "spec.PDF"), Buffer.from("%PDF-1.4\n"));

    const htmlFile = await readWorkspaceFile(root, "report.html");
    const markdownFile = await readWorkspaceFile(root, "README.MD");
    const pdfFile = await readWorkspaceFile(root, "spec.PDF");

    expect(htmlFile).toMatchObject({ mediaType: "html", mimeType: "text/html; charset=utf-8", content: html, binary: false });
    expect(markdownFile).toMatchObject({ mediaType: "markdown", language: "markdown", content: markdown, binary: false });
    expect(markdownFile.mimeType).toBeUndefined();
    expect(pdfFile).toMatchObject({ mediaType: "pdf", mimeType: "application/pdf", content: "", binary: true });
  });

  it("leaves unsupported binaries without a media type so they fall back to download", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

    const file = await readWorkspaceFile(root, "archive.zip");

    expect(file.mediaType).toBeUndefined();
    expect(file).toMatchObject({ content: "", binary: true });
  });

  it("opens inline preview streams only for supported types within the preview size limit", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    await writeFile(join(root, "note.txt"), "hello");
    await writeFile(join(root, "README.md"), "# Read me\n");
    await writeFile(join(root, "huge.png"), "");
    await truncate(join(root, "huge.png"), MAX_INLINE_PREVIEW_BYTES + 1);

    const preview = await readWorkspaceFilePreview(root, "diagram.svg");
    preview.stream.destroy();

    expect(preview).toMatchObject({ path: "diagram.svg", filename: "diagram.svg", mediaType: "image", size: 46 });
    await expect(readWorkspaceFilePreview(root, "note.txt")).rejects.toThrow("Inline preview is not supported");
    await expect(readWorkspaceFilePreview(root, "README.md")).rejects.toThrow("Inline preview is not supported");
    await expect(readWorkspaceFilePreview(root, "huge.png")).rejects.toThrow("File is too large to preview");
  });

  it("serves any file as an octet-stream attachment in download mode, ignoring the size cap", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "note.txt"), "hello");
    await writeFile(join(root, "huge.png"), "");
    await truncate(join(root, "huge.png"), MAX_INLINE_PREVIEW_BYTES + 1);

    const textDownload = await readWorkspaceFilePreview(root, "note.txt", undefined, { download: true });
    textDownload.stream.destroy();
    expect(textDownload).toMatchObject({ filename: "note.txt", size: 5 });
    expect(textDownload.mediaType).toBeUndefined();

    // Download mode bypasses the inline size cap.
    const bigDownload = await readWorkspaceFilePreview(root, "huge.png", undefined, { download: true });
    bigDownload.stream.destroy();
    expect(bigDownload.size).toBe(MAX_INLINE_PREVIEW_BYTES + 1);
  });

  it.each(["large.md", "large.html"])("caps literal source for %s", async (path) => {
    const root = await createTempWorkspace();
    await writeFile(join(root, path), "a".repeat(MAX_WORKSPACE_FILE_CONTENT_BYTES + 7));

    const file = await readWorkspaceFile(root, path);

    expect(file.content).toHaveLength(MAX_WORKSPACE_FILE_CONTENT_BYTES);
    expect(file.truncated).toBe(true);
    expect(file.binary).toBe(false);
  });

  it("retains preview path containment for inline and download requests", async () => {
    const root = await createTempWorkspace();
    const external = await createTempWorkspace();
    await writeFile(join(external, "outside.html"), "<h1>outside</h1>");
    const escapedPath = join("..", basename(external), "outside.html");

    await expect(readWorkspaceFilePreview(root, escapedPath)).rejects.toThrow("Path traversal is not allowed");
    await expect(readWorkspaceFilePreview(root, escapedPath, undefined, { download: true })).rejects.toThrow("Path traversal is not allowed");

    const allowed = await readWorkspaceFilePreview(root, join(external, "outside.html"), { allowedPaths: [external] });
    allowed.stream.destroy();
    expect(allowed).toMatchObject({ path: join(external, "outside.html"), mediaType: "html" });
  });
});
