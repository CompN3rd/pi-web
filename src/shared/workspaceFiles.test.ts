import { describe, expect, it } from "vitest";
import { classifyWorkspaceFile } from "./workspaceFiles.js";

describe("classifyWorkspaceFile", () => {
  it.each([
    ["photo.avif", "image/avif"],
    ["photo.bmp", "image/bmp"],
    ["photo.gif", "image/gif"],
    ["photo.ico", "image/x-icon"],
    ["photo.jpeg", "image/jpeg"],
    ["photo.jpg", "image/jpeg"],
    ["photo.png", "image/png"],
    ["photo.svg", "image/svg+xml"],
    ["photo.webp", "image/webp"],
  ])("classifies %s as streamed image bytes", (path, previewMimeType) => {
    expect(classifyWorkspaceFile(path)).toEqual({ mediaType: "image", source: "stream", previewMimeType });
  });

  it("classifies HTML and Markdown as literal text sources", () => {
    expect(classifyWorkspaceFile("REPORT.HTML")).toEqual({ mediaType: "html", source: "text", previewMimeType: "text/html; charset=utf-8" });
    expect(classifyWorkspaceFile("notes.MD")).toEqual({ mediaType: "markdown", source: "text" });
    expect(classifyWorkspaceFile("notes.MarkDown")).toEqual({ mediaType: "markdown", source: "text" });
  });

  it("classifies PDFs as streamed bytes and leaves unsupported extensions unclassified", () => {
    expect(classifyWorkspaceFile("SPEC.PDF")).toEqual({ mediaType: "pdf", source: "stream", previewMimeType: "application/pdf" });
    expect(classifyWorkspaceFile("archive.zip")).toBeUndefined();
    expect(classifyWorkspaceFile("folder.with.dot/file")).toBeUndefined();
  });
});
