import { describe, expect, it } from "vitest";
import {
  MAX_RESEARCH_LIBRARY_PILOT_PAPERS,
  parseLocalPilotConfig,
  RESEARCH_LIBRARY_PILOT_RIGHTS,
} from "./pilotConfig.js";

const sha = "a".repeat(64);

export function validPilotConfig(): Record<string, unknown> {
  return {
    version: 1,
    pilot: true,
    libraryId: "pilot-llmwiki-graphics",
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

describe("parseLocalPilotConfig", () => {
  it("parses the strict pilot contract without citation edges", () => {
    const parsed = parseLocalPilotConfig(validPilotConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.papers[0]).toMatchObject({ id: "pilot-barron2021", relatedTopics: ["Neural Rendering"] });
    expect(parsed.config.papers[0]).not.toHaveProperty("cites");
  });

  it.each([
    ["synthetic marker", { pilot: undefined, synthetic: true }],
    ["unknown root field", { extra: true }],
    ["wrong pilot id", { libraryId: "synthetic-library" }],
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
    "raw/research-library-pilot/paper:stream.pdf",
    "raw/research-library-pilot/paper\u0085.pdf",
    "raw/research-library-pilot/paper\u202Efdp.pdf",
    "raw/other/paper.pdf",
    "raw/research-library-pilot/paper.txt",
  ])("rejects unsafe PDF path %s", (path) => {
    const value = validPilotConfig();
    const paper = firstPaper(value);
    paper["pdf"] = { ...record(paper["pdf"]), path };
    expect(parseLocalPilotConfig(value).ok).toBe(false);
  });

  it.each([
    ["upper digest", { sha256: "A".repeat(64) }],
    ["oversized PDF", { size: 128 * 1024 * 1024 + 1 }],
    ["non-integer PDF", { size: 5.5 }],
    ["URL credentials", { sourceUrl: "https://user:secret@example.test/paper.pdf" }],
    ["URL fragment", { sourcePageUrl: "https://example.test/paper#section" }],
    ["noncanonical timestamp", { retrievedAt: "2026-08-08T12:00:00Z" }],
    ["weak rights", { rights: "public" }],
    ["unknown PDF field", { extra: true }],
  ])("rejects invalid PDF descriptor: %s", (_label, patch) => {
    const value = validPilotConfig();
    const paper = firstPaper(value);
    paper["pdf"] = { ...record(paper["pdf"]), ...patch };
    expect(parseLocalPilotConfig(value).ok).toBe(false);
  });

  it.each([
    ["source note traversal", "sourceNotePath", "Thesis/Citations/../secret.md"],
    ["source note ADS", "sourceNotePath", "Thesis/Citations/@Barron2021:stream.md"],
    ["source note C1 control", "sourceNotePath", "Thesis/Citations/@Barron2021\u0085.md"],
    ["usedBy ADS", "usedBy", ["1_intro/related-work.tex:stream"]],
    ["usedBy C1 control", "usedBy", ["1_intro/related\u009F-work.tex"]],
  ] as const)("rejects unsafe %s", (_label, field, fieldValue) => {
    const value = validPilotConfig();
    firstPaper(value)[field] = fieldValue;
    expect(parseLocalPilotConfig(value).ok).toBe(false);
  });

  it("rejects C0 and C1 controls in displayed metadata", () => {
    for (const title of ["bad\u0000title", "bad\u0085title", "bad\u009Ftitle"]) {
      const value = validPilotConfig();
      firstPaper(value)["title"] = title;
      expect(parseLocalPilotConfig(value).ok).toBe(false);
    }
  });

  it("rejects duplicate source-note bindings even when other identities are unique", () => {
    const value = validPilotConfig();
    const paper = structuredClone(firstPaper(value));
    paper["id"] = "pilot-second-paper";
    paper["bibkey"] = "SecondPaper";
    paper["pdf"] = { ...record(paper["pdf"]), path: "raw/research-library-pilot/pdfs/SecondPaper.pdf" };
    recordArray(value, "papers").push(paper);
    expect(parseLocalPilotConfig(value)).toMatchObject({ ok: false, error: "Duplicate pilot source-note path: Thesis/Citations/@Barron2021.md" });
  });

  it("rejects duplicate identities and excessive paper count", () => {
    const duplicates = validPilotConfig();
    const paper = structuredClone(firstPaper(duplicates));
    recordArray(duplicates, "papers").push(paper);
    expect(parseLocalPilotConfig(duplicates).ok).toBe(false);

    const excessive = validPilotConfig();
    excessive["papers"] = Array.from({ length: MAX_RESEARCH_LIBRARY_PILOT_PAPERS + 1 }, (_, index) => {
      const next = structuredClone(firstPaper(validPilotConfig()));
      next["id"] = `pilot-paper-${String(index)}`;
      next["bibkey"] = `Paper${String(index)}`;
      next["pdf"] = { ...record(next["pdf"]), path: `raw/research-library-pilot/pdfs/${String(index)}.pdf` };
      return next;
    });
    expect(parseLocalPilotConfig(excessive).ok).toBe(false);
  });
});

function firstPaper(value: Record<string, unknown>): Record<string, unknown> {
  const paper = recordArray(value, "papers")[0];
  if (!isRecord(paper)) throw new Error("Missing pilot paper");
  return paper;
}

function recordArray(value: Record<string, unknown>, key: string): unknown[] {
  const result = value[key];
  if (!Array.isArray(result)) throw new Error(`Missing ${key}`);
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
