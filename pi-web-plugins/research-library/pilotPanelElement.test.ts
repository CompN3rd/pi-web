// @vitest-environment happy-dom

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearResearchLibraryFixtureCache, researchLibraryPanelVisible } from "./fixtureCache.js";
import { RESEARCH_LIBRARY_PILOT_RIGHTS } from "./pilotConfig.js";
import { researchLibraryPdfViewerTagName } from "./pdfViewerElement.js";
import { defineResearchLibraryPanelElement, researchLibraryPanelTagName } from "./researchLibraryPanelElement.js";

const firstDigest = "b".repeat(64);
const pilotText = JSON.stringify({
  version: 1,
  pilot: true,
  libraryId: "pilot-llmwiki-graphics",
  papers: [
    {
      id: "pilot-barron2021",
      bibkey: "Barron2021",
      title: "<img src=x onerror=alert(1)> Mip-NeRF",
      authors: ["Jonathan Barron"],
      year: 2021,
      abstract: "Bounded <script>alert(1)</script> abstract.",
      sourceNotePath: "Thesis/Citations/@Barron2021.md",
      sourceNoteSha256: "a".repeat(64),
      relatedTopics: ["Neural Rendering"],
      metaCategories: ["Inverse Reconstruction"],
      usedBy: ["1_intro/related-work.tex"],
      pdf: {
        path: "raw/research-library-pilot/pdfs/Barron2021.pdf",
        sha256: firstDigest,
        size: 1024 * 1024,
        sourceUrl: "https://openaccess.example.test/Barron2021.pdf",
        sourcePageUrl: "https://openaccess.example.test/Barron2021",
        retrievedAt: "2026-08-08T12:00:00.000Z",
        rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
      },
    },
    {
      id: "pilot-kerbl2023",
      bibkey: "Kerbl2023GaussianSplatting",
      title: "3D Gaussian Splatting",
      authors: ["Bernhard Kerbl"],
      sourceNotePath: "Thesis/Citations/@Kerbl2023GaussianSplatting.md",
      sourceNoteSha256: "c".repeat(64),
      relatedTopics: ["Novel View Synthesis"],
      metaCategories: ["Differentiable Simulation"],
      usedBy: [],
      pdf: {
        path: "raw/research-library-pilot/pdfs/Kerbl2023GaussianSplatting.pdf",
        sha256: "d".repeat(64),
        size: 2048,
        sourceUrl: "https://example.test/Kerbl2023.pdf",
        sourcePageUrl: "https://example.test/Kerbl2023",
        retrievedAt: "2026-08-08T12:00:00.000Z",
        rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
      },
    },
  ],
});

class FakePdfViewer extends HTMLElement {
  sourceUrl: string | undefined;
}

beforeAll(() => {
  if (!customElements.get(researchLibraryPdfViewerTagName)) customElements.define(researchLibraryPdfViewerTagName, FakePdfViewer);
  defineResearchLibraryPanelElement();
});
beforeEach(() => { clearResearchLibraryFixtureCache(); });
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("read-only local research pilot panel", () => {
  it("renders escaped provenance and binds the PDF URL only through the viewer property", async () => {
    const { context, readFile, pdfPreviewUrl, listFiles, writeFile, insertText } = createPilotContext();
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();

    const root = requiredShadowRoot(element);
    expect(root.textContent).toContain("Read-only local pilot");
    expect(root.textContent).toContain("Agent dispatch is disabled pending disclosure approval");
    expect(root.textContent).toContain("Thesis/Citations/@Barron2021.md");
    expect(root.textContent).toContain("Manifest-declared wiki binding");
    expect(root.textContent).toContain("Manifest-declared PDF provenance");
    expect(root.textContent).toContain("the panel does not rehash note/PDF bytes or verify URL ownership at display time");
    expect(root.textContent).not.toContain("Official PDF");
    expect(root.textContent).not.toContain("Official page");
    expect(root.textContent).toContain("Inverse Reconstruction");
    expect(root.textContent).toContain("1_intro/related-work.tex");
    expect(root.textContent).toContain(RESEARCH_LIBRARY_PILOT_RIGHTS);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("button[data-passage-id]")).toBeNull();
    expect(root.querySelector("button[data-refresh-drafts]")).toBeNull();
    expect(readFile.mock.calls.map(([path]) => path).sort()).toEqual([
      ".pi-web/research-library.synthetic.json",
      "raw/_processed/research-library-pilot/library.json",
    ]);
    expect(listFiles).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(insertText).not.toHaveBeenCalled();

    expect(pdfPreviewUrl).toHaveBeenCalledWith("raw/research-library-pilot/pdfs/Barron2021.pdf", { modifiedAt: firstDigest });
    const viewer = root.querySelector<FakePdfViewer>(researchLibraryPdfViewerTagName);
    expect(viewer?.sourceUrl).toContain("paper.pdf?digest=");
    expect(viewer?.hasAttribute("src")).toBe(false);
  });

  it("searches bibkeys, topics, and meta categories without enabling pilot actions", async () => {
    const { context, writeFile, insertText } = createPilotContext();
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();
    const root = requiredShadowRoot(element);
    const input = root.querySelector<HTMLInputElement>("input[data-paper-search]");
    if (input === null) throw new Error("Missing pilot search");

    input.value = "Differentiable Simulation";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(root.textContent).toContain("3D Gaussian Splatting");
    expect(root.textContent).not.toContain("Mip-NeRF");

    const replacement = root.querySelector<HTMLInputElement>("input[data-paper-search]");
    if (replacement === null) throw new Error("Missing replacement pilot search");
    replacement.value = "Barron2021";
    replacement.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(root.textContent).toContain("Mip-NeRF");
    expect(writeFile).not.toHaveBeenCalled();
    expect(insertText).not.toHaveBeenCalled();
  });

  it("keeps the selected viewer connected while retained and no-result searches update only the paper list", async () => {
    const { context, pdfPreviewUrl } = createPilotContext();
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();
    const root = requiredShadowRoot(element);
    const viewer = root.querySelector<FakePdfViewer>(researchLibraryPdfViewerTagName);
    const input = root.querySelector<HTMLInputElement>("input[data-paper-search]");
    if (viewer === null || input === null) throw new Error("Missing initial pilot viewer or search");
    expect(pdfPreviewUrl).toHaveBeenCalledTimes(1);

    input.value = "Barron2021";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(root.querySelector(researchLibraryPdfViewerTagName)).toBe(viewer);
    expect(viewer.isConnected).toBe(true);
    expect(pdfPreviewUrl).toHaveBeenCalledTimes(1);

    input.value = "no such pilot paper";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(root.querySelector(researchLibraryPdfViewerTagName)).toBe(viewer);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("No matching papers");
    expect(root.textContent).toContain("Mip-NeRF");
    expect(pdfPreviewUrl).toHaveBeenCalledTimes(1);

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(root.querySelector(researchLibraryPdfViewerTagName)).toBe(viewer);
    expect(root.querySelector('button[data-paper-id="pilot-barron2021"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(pdfPreviewUrl).toHaveBeenCalledTimes(1);
  });

  it("shows a precise compatibility alert when the selected host lacks pdfPreviewUrl", async () => {
    const { context } = createPilotContext(false);
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();
    const root = requiredShadowRoot(element);
    expect(root.textContent).toContain("does not expose the bounded pdfPreviewUrl helper");
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelector(researchLibraryPdfViewerTagName)).toBeNull();
  });

  it("replaces a throwing pdfPreviewUrl helper with an escaped visible alert without retrying", async () => {
    const { context, pdfPreviewUrl } = createPilotContext();
    pdfPreviewUrl.mockImplementation(() => { throw new Error("bad <preview> & route"); });
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();
    const root = requiredShadowRoot(element);
    const alert = root.querySelector<HTMLElement>('[data-pdf-reader-host] [role="alert"]');
    expect(alert?.textContent).toContain("Unable to create PDF preview URL: bad <preview> & route");
    expect(alert?.querySelector("preview")).toBeNull();
    expect(root.querySelector(researchLibraryPdfViewerTagName)).toBeNull();
    expect(pdfPreviewUrl).toHaveBeenCalledTimes(1);
  });
});

function createPilotContext(withPreview = true) {
  let promptText = "";
  const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>();
  const insertText = vi.fn((text: string) => { promptText += text; });
  const pdfPreviewUrl = vi.fn((path: string, options?: { modifiedAt?: string }) => `https://pi.example.test/api/paper.pdf?digest=${encodeURIComponent(options?.modifiedAt ?? "")}&path=${encodeURIComponent(path)}`);
  const listFiles = vi.fn<WorkspacePanelContext["files"]["listFiles"]>();
  const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>((path) => {
    if (path === "raw/_processed/research-library-pilot/library.json") {
      return Promise.resolve({ path, content: pilotText, encoding: "utf8" as const, size: pilotText.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
    }
    return Promise.reject(new Error("Path does not exist"));
  });
  const files: WorkspacePanelContext["files"] = {
    readFile,
    ...(withPreview ? { pdfPreviewUrl } : {}),
    listFiles,
    writeFile,
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
  };
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true, isGitRepo: false, isGitWorktree: false },
    files,
    prompt: { insertText, getText: () => promptText, getSelection: () => null },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  };
  return { context, readFile, pdfPreviewUrl, listFiles, writeFile, insertText };
}

async function loadVisibility(context: WorkspacePanelContext): Promise<void> {
  expect(researchLibraryPanelVisible(context)).toBe(false);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await flush();
    if (researchLibraryPanelVisible(context)) return;
  }
  throw new Error("Timed out waiting for pilot visibility");
}

function mountPanel(context: WorkspacePanelContext): HTMLElement {
  const element = document.createElement(researchLibraryPanelTagName);
  Object.assign(element, { context });
  document.body.append(element);
  return element;
}

function requiredShadowRoot(element: HTMLElement): ShadowRoot {
  if (element.shadowRoot === null) throw new Error("Research panel has no shadow root");
  return element.shadowRoot;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
