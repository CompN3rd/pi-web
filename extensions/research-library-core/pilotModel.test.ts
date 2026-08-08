import { describe, expect, it } from "vitest";
import {
  parseLocalPilotConfig,
  RESEARCH_LIBRARY_PILOT_RIGHTS,
  type LocalResearchLibraryPilotConfig,
} from "./pilotModel.js";

const sha = "a".repeat(64);

function validPilotConfig(): LocalResearchLibraryPilotConfig {
  return {
    version: 1,
    pilot: true,
    libraryId: "pilot-llmwiki-graphics-three",
    papers: [{
      id: "pilot-barron2021",
      bibkey: "Barron2021",
      title: "Mip-NeRF",
      authors: ["Jonathan Barron"],
      year: 2021,
      abstract: "A public-paper pilot abstract.",
      sourceNotePath: "Thesis/Citations/@Barron2021.md",
      sourceNoteSha256: sha,
      relatedTopics: ["Neural Rendering"],
      metaCategories: ["Inverse Reconstruction"],
      usedBy: ["1_intro/related-work.tex"],
      pdf: {
        path: "raw/research-library-pilot/pdfs/Barron2021.pdf",
        sha256: "b".repeat(64),
        size: 4096,
        sourceUrl: "https://openaccess.example.test/paper.pdf",
        sourcePageUrl: "https://openaccess.example.test/paper",
        retrievedAt: "2026-08-08T12:00:00.000Z",
        rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
      },
    }],
  };
}

describe("local pilot manifest contract", () => {
  it("parses the strict pilot contract independently of browser code", () => {
    const parsed = parseLocalPilotConfig(validPilotConfig());
    expect(parsed).toMatchObject({ ok: true, config: { libraryId: "pilot-llmwiki-graphics-three" } });
  });

  it.each([
    ["synthetic marker", { pilot: undefined, synthetic: true }],
    ["unknown root field", { extra: true }],
    ["wrong library id", { libraryId: "synthetic-library" }],
  ])("rejects %s", (_label, patch) => {
    expect(parseLocalPilotConfig({ ...validPilotConfig(), ...patch }).ok).toBe(false);
  });

  it.each([
    "../paper.pdf",
    "/raw/research-library-pilot/paper.pdf",
    "C:/raw/research-library-pilot/paper.pdf",
    "raw\\research-library-pilot\\paper.pdf",
    "raw/research-library-pilot/../paper.pdf",
    "raw/research-library-pilot/paper.pdf?download=1",
    "raw/research-library-pilot/paper.pdf#page=2",
    "raw/other/paper.pdf",
    "raw/research-library-pilot/paper.txt",
  ])("rejects unsafe PDF path %s", (path) => {
    const value = validPilotConfig();
    const paper = value.papers[0];
    if (paper === undefined) throw new Error("Missing test paper");
    paper.pdf.path = path;
    expect(parseLocalPilotConfig(value).ok).toBe(false);
  });

  it("rejects source-note traversal and unsafe metadata controls", () => {
    const value = validPilotConfig();
    const paper = value.papers[0];
    if (paper === undefined) throw new Error("Missing test paper");
    paper.sourceNotePath = "Thesis/Citations/../secret.md";
    expect(parseLocalPilotConfig(value).ok).toBe(false);

    const second = validPilotConfig();
    const secondPaper = second.papers[0];
    if (secondPaper === undefined) throw new Error("Missing test paper");
    secondPaper.title = "bad\u0000title";
    expect(parseLocalPilotConfig(second).ok).toBe(false);
  });

  it("rejects duplicate paper, PDF, and source-note identities", () => {
    const value = validPilotConfig();
    const paper = value.papers[0];
    if (paper === undefined) throw new Error("Missing test paper");
    value.papers.push({ ...paper });
    expect(parseLocalPilotConfig(value).ok).toBe(false);

    const distinctPaper: LocalResearchLibraryPilotConfig = {
      ...validPilotConfig(),
      papers: [{ ...paper, id: "pilot-second", bibkey: "Second", pdf: { ...paper.pdf, path: "raw/research-library-pilot/pdfs/Second.pdf" } }],
    };
    const basePaper = distinctPaper.papers[0];
    if (basePaper === undefined) throw new Error("Missing distinct test paper");
    distinctPaper.papers.push({ ...basePaper, id: "pilot-third", bibkey: "Third", pdf: { ...basePaper.pdf, path: "raw/research-library-pilot/pdfs/Third.pdf" } });
    expect(parseLocalPilotConfig(distinctPaper).ok).toBe(false);
  });
});
