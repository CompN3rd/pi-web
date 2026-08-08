import { describe, expect, it, vi } from "vitest";
import { RESEARCH_LIBRARY_CONFIG_PATH } from "./config.js";
import { RESEARCH_LIBRARY_PILOT_CONFIG_PATH, RESEARCH_LIBRARY_PILOT_RIGHTS } from "./pilotConfig.js";
import { loadResearchLibrarySource } from "./researchLibrarySourceClient.js";
import type { ResearchLibraryFileReader } from "./researchLibraryClient.js";

const synthetic = JSON.stringify({
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [{ id: "synthetic-paper", title: "Paper", authors: ["Author"], tags: [], collections: [], passages: [], cites: [] }],
});

const pilot = JSON.stringify({
  version: 1,
  pilot: true,
  libraryId: "pilot-llmwiki",
  papers: [{
    id: "pilot-paper",
    bibkey: "Paper2026",
    title: "Pilot Paper",
    authors: ["Author"],
    sourceNotePath: "Thesis/Citations/@Paper2026.md",
    sourceNoteSha256: "a".repeat(64),
    relatedTopics: [],
    metaCategories: [],
    usedBy: [],
    pdf: {
      path: "raw/research-library-pilot/pdfs/Paper2026.pdf",
      sha256: "b".repeat(64),
      size: 1024,
      sourceUrl: "https://example.test/paper.pdf",
      sourcePageUrl: "https://example.test/paper",
      retrievedAt: "2026-08-08T12:00:00.000Z",
      rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
    },
  }],
});

describe("loadResearchLibrarySource", () => {
  it("returns missing only when both fixed paths are absent", async () => {
    const readFile = vi.fn(() => Promise.reject(new Error("Path does not exist")));
    await expect(loadResearchLibrarySource({ readFile })).resolves.toEqual({ kind: "missing" });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("loads the existing synthetic source when the pilot is absent", async () => {
    const result = await loadResearchLibrarySource(reader({ [RESEARCH_LIBRARY_CONFIG_PATH]: synthetic }));
    expect(result).toMatchObject({ kind: "loaded", source: { mode: "synthetic", fixture: { config: { synthetic: true } } } });
  });

  it("loads the independent pilot source when synthetic is absent", async () => {
    const result = await loadResearchLibrarySource(reader({ [RESEARCH_LIBRARY_PILOT_CONFIG_PATH]: pilot }));
    expect(result).toMatchObject({ kind: "loaded", source: { mode: "local-pilot", pilot: { config: { pilot: true } } } });
  });

  it("fails closed when both fixed sources exist", async () => {
    const result = await loadResearchLibrarySource(reader({
      [RESEARCH_LIBRARY_CONFIG_PATH]: synthetic,
      [RESEARCH_LIBRARY_PILOT_CONFIG_PATH]: pilot,
    }));
    expect(result).toMatchObject({ kind: "unavailable" });
    if (result.kind === "unavailable") expect(result.error).toContain("will not choose an implicit precedence");
  });

  it("surfaces a malformed present source even when the other source is valid", async () => {
    const result = await loadResearchLibrarySource(reader({
      [RESEARCH_LIBRARY_CONFIG_PATH]: synthetic,
      [RESEARCH_LIBRARY_PILOT_CONFIG_PATH]: "{}",
    }));
    expect(result).toMatchObject({ kind: "unavailable" });
    if (result.kind === "unavailable") expect(result.error).toContain(RESEARCH_LIBRARY_PILOT_CONFIG_PATH);
  });
});

function reader(files: Record<string, string>): ResearchLibraryFileReader {
  return {
    readFile: vi.fn<ResearchLibraryFileReader["readFile"]>((path) => {
      const content = files[path];
      if (content === undefined) return Promise.reject(new Error("Path does not exist"));
      return Promise.resolve({ content, size: content.length, truncated: false, binary: false });
    }),
  };
}
