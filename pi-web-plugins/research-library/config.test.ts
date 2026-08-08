import { describe, expect, it } from "vitest";
import { citedByPaperIds, parseResearchLibraryConfig, parseResearchLibraryConfigText, type ParseResearchLibraryConfigResult, type SyntheticResearchLibraryConfig } from "./config.js";

function validSyntheticResearchLibrary(): SyntheticResearchLibraryConfig {
  return {
    version: 1,
    synthetic: true,
    libraryId: "synthetic-library",
    papers: [
      {
        id: "synthetic-paper-a",
        title: "Synthetic Paper A",
        authors: ["Ada Example"],
        year: 2024,
        abstract: "A generated abstract.",
        tags: ["synthetic"],
        collections: ["Demo"],
        passages: [{ id: "synthetic-passage-a", page: 2, quote: "Generated evidence.", question: "What follows?" }],
        cites: ["synthetic-paper-b"],
      },
      {
        id: "synthetic-paper-b",
        title: "Synthetic Paper B",
        authors: ["Ben Example"],
        tags: [],
        collections: [],
        passages: [],
        cites: [],
      },
    ],
  };
}

describe("parseResearchLibraryConfig", () => {
  it("parses a strict synthetic fixture and derives backlinks", () => {
    const result = parseResearchLibraryConfig(validSyntheticResearchLibrary());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Valid fixture did not parse");
    expect(result.config.libraryId).toBe("synthetic-library");
    expect(citedByPaperIds(result.config, "synthetic-paper-b")).toEqual(["synthetic-paper-a"]);
  });

  it("rejects malformed JSON, unknown fields, and non-synthetic identifiers", () => {
    expectFailure(parseResearchLibraryConfigText("{"), "Invalid JSON");
    expectFailure(parseResearchLibraryConfig({ ...validSyntheticResearchLibrary(), extra: true }), "unknown fields");
    expectFailure(parseResearchLibraryConfig({ ...validSyntheticResearchLibrary(), libraryId: "real-library" }), "libraryId");
  });

  it("rejects duplicate ids and citations to unknown papers", () => {
    const duplicate = validSyntheticResearchLibrary();
    const firstPaper = duplicate.papers[0];
    if (firstPaper === undefined) throw new Error("Test fixture is incomplete");
    duplicate.papers[1] = { ...firstPaper };
    expectFailure(parseResearchLibraryConfig(duplicate), "Duplicate paper id: synthetic-paper-a");

    const unknown = validSyntheticResearchLibrary();
    const citingPaper = unknown.papers[0];
    if (citingPaper === undefined) throw new Error("Test fixture is incomplete");
    citingPaper.cites = ["synthetic-missing"];
    expectFailure(parseResearchLibraryConfig(unknown), "cites unknown paper");
  });

  it("rejects duplicate passage ids and unsafe extra passage fields", () => {
    const duplicate = validSyntheticResearchLibrary();
    const duplicatePaper = duplicate.papers[0];
    const duplicatePassage = duplicatePaper?.passages[0];
    if (duplicatePaper === undefined || duplicatePassage === undefined) throw new Error("Test fixture is incomplete");
    duplicatePaper.passages.push({ ...duplicatePassage });
    expectFailure(parseResearchLibraryConfig(duplicate), "duplicate passage id");

    const fixture = validSyntheticResearchLibrary();
    const paper = fixture.papers[0];
    const passage = paper?.passages[0];
    if (paper === undefined || passage === undefined) throw new Error("Test fixture is incomplete");
    const withExtraPassageField = {
      ...fixture,
      papers: [{ ...paper, passages: [{ ...passage, url: "https://example.test" }] }, ...fixture.papers.slice(1)],
    };
    expectFailure(parseResearchLibraryConfig(withExtraPassageField), "unknown fields");
  });
});

function expectFailure(result: ParseResearchLibraryConfigResult, message: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Parser unexpectedly accepted invalid fixture");
  expect(result.error).toContain(message);
}
