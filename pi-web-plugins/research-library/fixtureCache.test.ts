import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearResearchLibraryFixtureCache, researchLibraryPanelVisible } from "./fixtureCache.js";
import { RESEARCH_LIBRARY_PILOT_RIGHTS } from "./pilotConfig.js";

const fixture = JSON.stringify({
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [{ id: "synthetic-paper", title: "Paper", authors: ["Author"], tags: [], collections: [], passages: [], cites: [] }],
});

const pilot = JSON.stringify({
  version: 1,
  pilot: true,
  libraryId: "pilot-library",
  papers: [{
    id: "pilot-paper", bibkey: "Paper2026", title: "Paper", authors: ["Author"],
    sourceNotePath: "Thesis/Citations/@Paper2026.md", sourceNoteSha256: "a".repeat(64), relatedTopics: [], metaCategories: [], usedBy: [],
    pdf: { path: "raw/research-library-pilot/pdfs/Paper2026.pdf", sha256: "b".repeat(64), size: 1000, sourceUrl: "https://example.test/paper.pdf", sourcePageUrl: "https://example.test/paper", retrievedAt: "2026-08-08T12:00:00.000Z", rights: RESEARCH_LIBRARY_PILOT_RIGHTS },
  }],
});

beforeEach(() => { clearResearchLibraryFixtureCache(); });

describe("research library panel visibility", () => {
  it("stays hidden while loading and becomes visible for a valid synthetic fixture", async () => {
    let resolveRead: ((value: Awaited<ReturnType<WorkspacePanelContext["files"]["readFile"]>>) => void) | undefined;
    const readFile = vi.fn<WorkspacePanelContext["files"]["readFile"]>((path) => {
      if (path.includes("pilot")) return Promise.reject(new Error("Path does not exist"));
      return new Promise<Awaited<ReturnType<WorkspacePanelContext["files"]["readFile"]>>>((resolve) => { resolveRead = resolve; });
    });
    const requestRender = vi.fn();
    const context = panelContext(readFile, requestRender);

    expect(researchLibraryPanelVisible(context)).toBe(false);
    expect(researchLibraryPanelVisible(context)).toBe(false);
    expect(readFile).toHaveBeenCalledTimes(2);

    resolveRead?.({ path: ".pi-web/research-library.synthetic.json", content: fixture, encoding: "utf8", size: fixture.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
    await waitFor(() => requestRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(context)).toBe(true);
  });

  it("becomes visible for a valid read-only pilot", async () => {
    const requestRender = vi.fn();
    const context = panelContext(fileReader({ "raw/_processed/research-library-pilot/library.json": pilot }), requestRender);
    expect(researchLibraryPanelVisible(context)).toBe(false);
    await waitFor(() => requestRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(context)).toBe(true);
  });

  it("stays hidden when both sources are absent but surfaces an invalid source panel", async () => {
    const missingRender = vi.fn();
    const missing = panelContext(vi.fn(() => Promise.reject(new Error("Path does not exist"))), missingRender);
    expect(researchLibraryPanelVisible(missing)).toBe(false);
    await waitFor(() => missingRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(missing)).toBe(false);

    clearResearchLibraryFixtureCache();
    const invalidRender = vi.fn();
    const invalid = panelContext(fileReader({ "raw/_processed/research-library-pilot/library.json": "{}" }), invalidRender);
    expect(researchLibraryPanelVisible(invalid)).toBe(false);
    await waitFor(() => invalidRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(invalid)).toBe(true);
  });
});

function fileReader(files: Record<string, string>): WorkspacePanelContext["files"]["readFile"] {
  return vi.fn<WorkspacePanelContext["files"]["readFile"]>((path) => {
    const content = files[path];
    if (content === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve({ path, content, encoding: "utf8" as const, size: content.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for fixture cache");
}

function panelContext(readFile: WorkspacePanelContext["files"]["readFile"], requestRender: () => void): WorkspacePanelContext {
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true, isGitRepo: true, isGitWorktree: false },
    files: { readFile, listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender },
  };
}
