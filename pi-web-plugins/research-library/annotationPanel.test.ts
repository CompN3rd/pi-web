// @vitest-environment happy-dom

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_ANNOTATIONS_ROOT, parseAnnotationText } from "./annotationModel.js";
import { clearResearchLibraryFixtureCache, researchLibraryPanelVisible } from "./fixtureCache.js";
import { researchLibraryPdfViewerTagName, researchPdfSelectionEventName, type ResearchPdfSelectionDetail } from "./pdfViewerElement.js";
import { RESEARCH_LIBRARY_PILOT_RIGHTS } from "./pilotConfig.js";
import { defineResearchLibraryPanelElement, researchLibraryPanelTagName } from "./researchLibraryPanelElement.js";

const manifestPath = "raw/_processed/research-library-pilot/library.json";
const annotationDirectory = `${RESEARCH_ANNOTATIONS_ROOT}/pilot-barron2021`;
const pdfDigest = "b".repeat(64);
const manifestText = JSON.stringify({
  version: 1,
  pilot: true,
  libraryId: "pilot-llmwiki-graphics",
  papers: [{
    id: "pilot-barron2021",
    bibkey: "Barron2021",
    title: "Mip-NeRF",
    authors: ["Jonathan Barron"],
    year: 2021,
    sourceNotePath: "Thesis/Citations/@Barron2021.md",
    sourceNoteSha256: "a".repeat(64),
    relatedTopics: [],
    metaCategories: [],
    usedBy: [],
    pdf: {
      path: "raw/research-library-pilot/pdfs/Barron2021.pdf",
      sha256: pdfDigest,
      size: 1024,
      sourceUrl: "https://example.test/Barron2021.pdf",
      sourcePageUrl: "https://example.test/Barron2021",
      retrievedAt: "2026-08-08T12:00:00.000Z",
      rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
    },
  }],
});

class FakePdfViewer extends HTMLElement {
  sourceUrl: string | undefined;
  annotations: readonly { id: string; page: number; kind: string; status: string; label: string }[] = [];
  activeAnnotationId: string | undefined;
  readonly shownPages: number[] = [];
  showPage(page: number): void { this.shownPages.push(page); }
}

beforeAll(() => {
  if (!customElements.get(researchLibraryPdfViewerTagName)) customElements.define(researchLibraryPdfViewerTagName, FakePdfViewer);
  defineResearchLibraryPanelElement();
});
beforeEach(() => {
  clearResearchLibraryFixtureCache();
  Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: vi.fn(() => false) });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("pilot PDF annotations", () => {
  it("saves a marked region once and lists it against the paper", async () => {
    const workspace = await mountPilotPanel();

    await workspace.markRegion({ page: 2, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, quote: "conical frustums instead of rays" });
    expect(workspace.root.textContent).toContain("New annotation · page 2");
    expect(workspace.root.textContent).toContain("conical frustums instead of rays");

    workspace.type("textarea[data-annotation-body]", "Why frustums and not rays?");
    await workspace.click(`button[data-annotation-action="save"]`);

    const write = workspace.files.writeFile.mock.calls[0];
    if (write === undefined) throw new Error("Expected the annotation to be written");
    const [path, content, options] = write;
    expect(path.startsWith(`${annotationDirectory}/ann-`)).toBe(true);
    expect(options).toEqual({ createDirs: true, overwrite: false });
    const parsed = parseAnnotationText(String(content));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.annotation).toMatchObject({
      libraryId: "pilot-llmwiki-graphics",
      paperId: "pilot-barron2021",
      pdfSha256: pdfDigest,
      page: 2,
      quote: "conical frustums instead of rays",
      kind: "question",
      body: "Why frustums and not rays?",
      status: "open",
      revision: 1,
    });

    expect(workspace.root.textContent).toContain("Saved question on page 2.");
    expect(workspace.root.textContent).toContain("Why frustums and not rays?");
    expect(workspace.root.textContent).toContain("1 total · 1 open");
    expect(workspace.viewer().annotations.map((marker) => marker.id)).toEqual([parsed.annotation.id]);
    expect(workspace.root.querySelector("form[data-annotation-form]")).toBeNull();
  });

  it("refuses an empty annotation without touching the workspace", async () => {
    const workspace = await mountPilotPanel();
    await workspace.markRegion({ page: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, quote: "" });

    await workspace.click(`button[data-annotation-action="save"]`);

    expect(workspace.files.writeFile).not.toHaveBeenCalled();
    expect(workspace.root.textContent).toContain("Write the question or note before saving this region.");
    expect(workspace.root.textContent).toContain("No text was found in that region");
  });

  it("resolves, reopens, and deletes a stored annotation", async () => {
    const workspace = await mountPilotPanel();
    await workspace.markRegion({ page: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, quote: "quoted" });
    workspace.type("textarea[data-annotation-body]", "Check this later");
    await workspace.click(`button[data-annotation-action="save"]`);

    await workspace.click(`button[data-annotation-action="toggle-status"]`);
    expect(workspace.root.textContent).toContain("Marked resolved.");
    expect(workspace.storedAnnotation()).toMatchObject({ status: "resolved", revision: 2 });
    expect(workspace.root.textContent).toContain("1 total · 0 open");

    await workspace.click(`button[data-annotation-action="toggle-status"]`);
    expect(workspace.storedAnnotation()).toMatchObject({ status: "open", revision: 3 });

    vi.mocked(window.confirm).mockReturnValue(true);
    await workspace.click(`button[data-annotation-action="delete"]`);

    expect(workspace.files.deleteFile).toHaveBeenCalledTimes(1);
    expect(workspace.stored.size).toBe(0);
    expect(workspace.root.textContent).toContain("No annotations yet for this paper.");
    expect(workspace.viewer().annotations).toEqual([]);
  });

  it("keeps an annotation when its deletion is declined", async () => {
    const workspace = await mountPilotPanel();
    await workspace.markRegion({ page: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, quote: "quoted" });
    workspace.type("textarea[data-annotation-body]", "Keep me");
    await workspace.click(`button[data-annotation-action="save"]`);

    vi.mocked(window.confirm).mockReturnValue(false);
    await workspace.click(`button[data-annotation-action="delete"]`);

    expect(workspace.files.deleteFile).not.toHaveBeenCalled();
    expect(workspace.stored.size).toBe(1);
  });

  it("edits an annotation body and shows its page in the reader", async () => {
    const workspace = await mountPilotPanel();
    await workspace.markRegion({ page: 3, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, quote: "quoted" });
    workspace.type("textarea[data-annotation-body]", "First wording");
    await workspace.click(`button[data-annotation-action="save"]`);

    await workspace.click(`button[data-annotation-action="edit"]`);
    workspace.type("textarea[data-annotation-edit-body]", "Second wording");
    await workspace.click(`button[data-annotation-action="edit-save"]`);

    expect(workspace.storedAnnotation()).toMatchObject({ body: "Second wording", revision: 2, page: 3 });
    expect(workspace.root.textContent).toContain("Annotation updated.");

    await workspace.click(`button[data-annotation-action="show"]`);
    expect(workspace.viewer().shownPages).toEqual([3]);
  });
});

async function mountPilotPanel() {
  const stored = new Map<string, string>();
  const files = fakeFiles(stored);
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true, isGitRepo: false, isGitWorktree: false },
    files,
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  };

  for (let attempt = 0; attempt < 30 && !researchLibraryPanelVisible(context); attempt += 1) await flush();
  const element = document.createElement(researchLibraryPanelTagName);
  Object.assign(element, { context });
  document.body.append(element);
  await flush();
  const root = element.shadowRoot;
  if (root === null) throw new Error("Research panel has no shadow root");

  const click = async (selector: string): Promise<void> => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`Missing control: ${selector}`);
    button.click();
    await flush();
    await flush();
  };
  return {
    context,
    files,
    stored,
    root,
    click,
    viewer: (): FakePdfViewer => {
      const viewer = root.querySelector(researchLibraryPdfViewerTagName);
      if (!(viewer instanceof FakePdfViewer)) throw new Error("Fake PDF viewer is not mounted");
      return viewer;
    },
    type: (selector: string, value: string): void => {
      const field = root.querySelector<HTMLTextAreaElement>(selector);
      if (field === null) throw new Error(`Missing field: ${selector}`);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
    markRegion: async (detail: ResearchPdfSelectionDetail): Promise<void> => {
      const viewer = root.querySelector(researchLibraryPdfViewerTagName);
      if (viewer === null) throw new Error("Fake PDF viewer is not mounted");
      viewer.dispatchEvent(new CustomEvent<ResearchPdfSelectionDetail>(researchPdfSelectionEventName, { detail, bubbles: true, composed: true }));
      await flush();
    },
    storedAnnotation: (): Record<string, unknown> => {
      const content = [...stored.values()][0];
      if (content === undefined) throw new Error("No annotation is stored");
      const parsed = parseAnnotationText(content);
      if (!parsed.ok) throw new Error(parsed.error);
      return { ...parsed.annotation };
    },
  };
}

function fakeFiles(stored: Map<string, string>) {
  const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>((path) => {
    const content = path === manifestPath ? manifestText : stored.get(path);
    if (content === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve({ path, content, encoding: "utf8" as const, size: content.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
  });
  const listFiles = vi.fn<WorkspacePanelContext["files"]["listFiles"]>((path) => Promise.resolve({
    path,
    entries: [...stored.keys()]
      .filter((candidate) => candidate.startsWith(`${path}/`))
      .map((candidate) => ({ name: candidate.slice(path.length + 1), path: candidate, type: "file" as const })),
    scannedAt: new Date(0).toISOString(),
    truncated: false,
  }));
  const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((path, content, options) => {
    if (options?.overwrite === false && stored.has(path)) return Promise.reject(new Error("File already exists"));
    const created = !stored.has(path);
    stored.set(path, String(content));
    return Promise.resolve({ path, size: String(content).length, modifiedAt: new Date(0).toISOString(), created });
  });
  const deleteFile = vi.fn<WorkspacePanelContext["files"]["deleteFile"]>((path) => {
    const existed = stored.delete(path);
    return Promise.resolve({ path, existed });
  });
  return {
    readFile,
    listFiles,
    writeFile,
    deleteFile,
    moveFile: vi.fn<WorkspacePanelContext["files"]["moveFile"]>(),
    pdfPreviewUrl: (path: string) => `https://pi.example.test/${path}`,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
