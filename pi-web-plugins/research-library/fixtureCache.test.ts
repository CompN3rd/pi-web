import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearResearchLibraryFixtureCache, researchLibraryPanelVisible } from "./fixtureCache.js";

const fixture = JSON.stringify({
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [{ id: "synthetic-paper", title: "Paper", authors: ["Author"], tags: [], collections: [], passages: [], cites: [] }],
});

beforeEach(() => { clearResearchLibraryFixtureCache(); });

describe("research library panel visibility", () => {
  it("stays hidden while loading and becomes visible for a valid fixture", async () => {
    let resolveRead: ((value: Awaited<ReturnType<WorkspacePanelContext["files"]["readFile"]>>) => void) | undefined;
    const readFile = vi.fn((path: string) => {
      expect(path).toBe(".pi-web/research-library.synthetic.json");
      return new Promise<Awaited<ReturnType<WorkspacePanelContext["files"]["readFile"]>>>((resolve) => { resolveRead = resolve; });
    });
    const requestRender = vi.fn();
    const context = panelContext(readFile, requestRender);

    expect(researchLibraryPanelVisible(context)).toBe(false);
    expect(researchLibraryPanelVisible(context)).toBe(false);
    expect(readFile).toHaveBeenCalledTimes(1);

    resolveRead?.({ path: ".pi-web/research-library.synthetic.json", content: fixture, encoding: "utf8", size: fixture.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
    await waitFor(() => requestRender.mock.calls.length === 1);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(researchLibraryPanelVisible(context)).toBe(true);
  });

  it("stays hidden when the optional fixture is absent but surfaces an invalid fixture panel", async () => {
    const missingRender = vi.fn();
    const missing = panelContext(vi.fn(() => Promise.reject(new Error("Path does not exist"))), missingRender);
    expect(researchLibraryPanelVisible(missing)).toBe(false);
    await waitFor(() => missingRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(missing)).toBe(false);

    clearResearchLibraryFixtureCache();
    const invalidRender = vi.fn();
    const invalidRead: WorkspacePanelContext["files"]["readFile"] = (path) => Promise.resolve({ path, content: "{}", encoding: "utf8", size: 2, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
    const invalid = panelContext(vi.fn(invalidRead), invalidRender);
    expect(researchLibraryPanelVisible(invalid)).toBe(false);
    await waitFor(() => invalidRender.mock.calls.length === 1);
    expect(researchLibraryPanelVisible(invalid)).toBe(true);
  });
});

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
    files: {
      readFile,
      listFiles: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      moveFile: vi.fn(),
    },
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender },
  };
}
