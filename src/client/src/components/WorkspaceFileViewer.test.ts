// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse } from "../api";
import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import { WorkspaceFileViewer, workspaceFilePreviewKind, workspaceFileViewerIdentityKey, type WorkspaceFileViewerIdentity } from "./WorkspaceFileViewer";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace-file-viewer", () => {
  it("shows explicit selection, loading, unavailable, and content-mismatch states", async () => {
    const viewer = await mountViewer(undefined, { selectedPath: undefined });
    expect(statusMessage(viewer)).toBe("Select a file.");

    viewer.selectedPath = "notes.md";
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Loading notes.md…");
    expect(viewer.shadowRoot?.querySelector("[role='status']")?.getAttribute("aria-live")).toBe("polite");

    viewer.loadError = "Path does not exist: notes.md";
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Unable to load notes.md: Path does not exist: notes.md");
    expect(viewer.shadowRoot?.querySelector("[role='alert']")).not.toBeNull();

    viewer.loadError = undefined;
    viewer.file = textFile("other.md", "# Wrong file", { mediaType: "markdown", language: "markdown" });
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toBe("Unable to preview notes.md: loaded content belongs to other.md.");
    expect(viewer.shadowRoot?.querySelector("a, iframe, code-viewer")).toBeNull();
  });

  it("defaults HTML to an exactly sandboxed preview and renders Raw as literal source", async () => {
    const source = `<h1 onclick="alert(1)">Literal heading</h1><script>alert("no")</script>`;
    const file = textFile("pages/report.html", source, {
      mediaType: "html",
      mimeType: "text/html; charset=utf-8",
      language: "html",
    });
    const viewer = await mountViewer(file);

    const group = requiredElement(viewer.shadowRoot?.querySelector("[role='group']"), "mode group");
    expect(group.getAttribute("aria-label")).toBe("View pages/report.html");
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("false");

    const frame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "HTML preview frame");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Preview of pages/report.html");

    const open = anchorWithText(viewer, "Open ↗");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(new URL(open.href).searchParams.get("download")).toBeNull();
    const download = requiredElement(viewer.shadowRoot?.querySelector<HTMLAnchorElement>("a[download]"), "download action");
    expect(download.getAttribute("download")).toBe("report.html");
    expect(new URL(download.href).searchParams.get("download")).toBe("1");

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;

    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "raw code viewer");
    expect(raw.content).toBe(source);
    expect(viewer.shadowRoot?.querySelector("h1, script")).toBeNull();

    modeButton(viewer, "Preview").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();
  });

  it("defaults Markdown to the dedicated safe renderer and keeps literal Raw available", async () => {
    const source = `# Rendered\n\n<script>alert(1)</script>\n\n![remote](https://attacker.test/pixel.png)\n\n[Docs](https://example.test/docs)`;
    const file = textFile("README.md", source, { mediaType: "markdown", language: "markdown" });
    const viewer = await mountViewer(file);

    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    const preview = requiredElement(viewer.shadowRoot?.querySelector(".markdown-preview"), "Markdown preview");
    expect(preview.querySelector("h1")?.textContent).toBe("Rendered");
    expect(preview.querySelector("script, img, iframe, object, embed, svg")).toBeNull();
    expect(preview.textContent).toContain("<script>alert(1)</script>");
    expect(preview.textContent).toContain("[Image omitted: remote]");
    const renderedLink = requiredElement(preview.querySelector("a"), "rendered Markdown link");
    expect(renderedLink.getAttribute("target")).toBe("_blank");
    expect(renderedLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(viewer.shadowRoot?.textContent).not.toContain("Open ↗");

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    const raw = requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "raw Markdown viewer");
    expect(raw.content).toBe(source);
    expect(viewer.shadowRoot?.querySelector(".markdown-preview")).toBeNull();
  });

  it("resets mode to Preview whenever the full selected-file identity changes", async () => {
    const original = textFile("report.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(original);

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(modeButton(viewer, "Raw").getAttribute("aria-pressed")).toBe("true");

    viewer.file = { ...original, content: "<p>updated</p>", modifiedAt: "2026-06-25T00:01:00.000Z" };
    await viewer.updateComplete;
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    viewer.machineId = "remote-1";
    await viewer.updateComplete;
    expect(modeButton(viewer, "Preview").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores stale mode controls after a different file is selected", async () => {
    const html = textFile("first.html", "<p>first</p>", { mediaType: "html", language: "html" });
    const viewer = await mountViewer(html);
    const detachedRawButton = modeButton(viewer, "Raw");

    const image = binaryFile("second.png", { mediaType: "image", mimeType: "image/png" });
    viewer.selectedPath = image.path;
    viewer.file = image;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("img")).not.toBeNull();

    detachedRawButton.click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("img")).not.toBeNull();
    expect(viewer.shadowRoot?.querySelector("code-viewer")).toBeNull();
  });

  it("ignores stale embedded-preview failures and exposes recovery for the current file", async () => {
    const image = binaryFile("first.png", { mediaType: "image", mimeType: "image/png" });
    const viewer = await mountViewer(image);
    const detachedImage = requiredElement(viewer.shadowRoot?.querySelector<HTMLImageElement>("img"), "first image");

    const pdf = binaryFile("second.pdf", { mediaType: "pdf", mimeType: "application/pdf" });
    viewer.selectedPath = pdf.path;
    viewer.file = pdf;
    await viewer.updateComplete;
    const currentFrame = requiredElement(viewer.shadowRoot?.querySelector<HTMLIFrameElement>("iframe"), "current PDF frame");
    expect(currentFrame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(currentFrame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(currentFrame.getAttribute("allow")).toBe("");
    expect(currentFrame.getAttribute("referrerpolicy")).toBe("no-referrer");

    detachedImage.dispatchEvent(new Event("error"));
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).toBe(currentFrame);
    expect(viewer.shadowRoot?.textContent).not.toContain("Preview failed");

    currentFrame.dispatchEvent(new Event("error"));
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain("Preview failed for second.pdf.");
    expect(viewer.shadowRoot?.querySelector("iframe")).toBeNull();
    expect(anchorWithText(viewer, "Open ↗")).toBeDefined();
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    buttonWithText(viewer, "Retry preview").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("iframe")).not.toBeNull();
  });

  it("keeps empty, oversized, unsupported, and truncated states explicit", async () => {
    const emptyMarkdown = textFile("empty.md", "", { mediaType: "markdown", language: "markdown", size: 0 });
    const viewer = await mountViewer(emptyMarkdown);
    expect(statusMessage(viewer)).toBe("This file is empty.");
    expect(modeButton(viewer, "Preview")).toBeDefined();
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    const oversizedHtml = textFile("large.html", "<p>first capped bytes</p>", {
      mediaType: "html",
      language: "html",
      size: MAX_INLINE_PREVIEW_BYTES + 1,
      truncated: true,
    });
    viewer.selectedPath = oversizedHtml.path;
    viewer.file = oversizedHtml;
    await viewer.updateComplete;
    expect(statusMessage(viewer)).toContain("File too large to preview");
    expect(viewer.shadowRoot?.textContent).not.toContain("Open ↗");
    expect(viewer.shadowRoot?.querySelector("a[download]")).not.toBeNull();

    modeButton(viewer, "Raw").click();
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.querySelector("[role='status']")?.textContent).toContain("Raw source is truncated");
    expect(requiredElement(viewer.shadowRoot?.querySelector<HTMLElement & { content: string }>("code-viewer"), "oversized raw source").content).toBe("<p>first capped bytes</p>");

    const archive = binaryFile("archive.zip");
    viewer.selectedPath = archive.path;
    viewer.file = archive;
    await viewer.updateComplete;
    expect(viewer.shadowRoot?.textContent).toContain("Preview isn't available for this file type.");
    expect(viewer.shadowRoot?.querySelector(".download-link")?.textContent).toContain("Download archive.zip");
  });
});

describe("workspace file viewer seams", () => {
  it("classifies every viewer kind including Markdown", () => {
    expect(workspaceFilePreviewKind(binaryFile("logo.png", { mediaType: "image" }))).toBe("image");
    expect(workspaceFilePreviewKind(textFile("report.html", "x", { mediaType: "html" }))).toBe("html");
    expect(workspaceFilePreviewKind(binaryFile("report.pdf", { mediaType: "pdf" }))).toBe("pdf");
    expect(workspaceFilePreviewKind(textFile("README.md", "x", { mediaType: "markdown" }))).toBe("markdown");
    expect(workspaceFilePreviewKind(binaryFile("archive.zip"))).toBe("download");
    expect(workspaceFilePreviewKind(textFile("main.ts", "const x = 1", { language: "typescript" }))).toBe("code");
  });

  it("keys state by machine, project, workspace, path, modified time, and loaded format", () => {
    const file = textFile("report.html", "<p>x</p>", { mediaType: "html" });
    const base: WorkspaceFileViewerIdentity = {
      machineId: "local",
      projectId: "project-1",
      workspaceId: "workspace-1",
      selectedPath: file.path,
      file,
    };
    const baseKey = workspaceFileViewerIdentityKey(base);
    const variants: WorkspaceFileViewerIdentity[] = [
      { ...base, machineId: "remote-1" },
      { ...base, projectId: "project-2" },
      { ...base, workspaceId: "workspace-2" },
      { ...base, selectedPath: "other.html" },
      { ...base, file: { ...file, modifiedAt: "2026-06-25T00:01:00.000Z" } },
      { ...base, file: { ...file, mediaType: "markdown" } },
    ];

    expect(new Set(variants.map(workspaceFileViewerIdentityKey))).toHaveLength(variants.length);
    for (const variant of variants) expect(workspaceFileViewerIdentityKey(variant)).not.toBe(baseKey);
  });
});

interface ViewerPatch {
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  selectedPath?: string | undefined;
  file?: FileContentResponse | undefined;
  loadError?: string | undefined;
  previewUrlBuilder?: WorkspaceFileViewer["previewUrlBuilder"];
}

async function mountViewer(file: FileContentResponse | undefined, patch: ViewerPatch = {}): Promise<WorkspaceFileViewer> {
  const viewer = new WorkspaceFileViewer();
  Object.assign(viewer, {
    machineId: "local",
    projectId: "project-1",
    workspaceId: "workspace-1",
    selectedPath: file?.path,
    file,
    loadError: undefined,
    previewUrlBuilder: inertPreviewUrl,
  }, patch);
  document.body.append(viewer);
  await viewer.updateComplete;
  return viewer;
}

const inertPreviewUrl: WorkspaceFileViewer["previewUrlBuilder"] = (_projectId, _workspaceId, path, options) => {
  const params = new URLSearchParams({ path });
  if (options?.modifiedAt !== undefined) params.set("v", options.modifiedAt);
  if (options?.download === true) params.set("download", "1");
  return `about:blank?${params.toString()}`;
};

function textFile(path: string, content: string, patch: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: content.length,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content,
    truncated: false,
    binary: false,
    ...patch,
  };
}

function binaryFile(path: string, patch: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: 4096,
    modifiedAt: "2026-06-25T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: true,
    ...patch,
  };
}

function modeButton(viewer: WorkspaceFileViewer, text: "Preview" | "Raw"): HTMLButtonElement {
  return buttonWithText(viewer, text);
}

function buttonWithText(viewer: WorkspaceFileViewer, text: string): HTMLButtonElement {
  const button = [...(viewer.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(button, `${text} button`);
}

function anchorWithText(viewer: WorkspaceFileViewer, text: string): HTMLAnchorElement {
  const anchor = [...(viewer.shadowRoot?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(anchor, `${text} link`);
}

function statusMessage(viewer: WorkspaceFileViewer): string {
  return requiredElement(viewer.shadowRoot?.querySelector<HTMLElement>(".viewer-status"), "viewer status").textContent.trim();
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
