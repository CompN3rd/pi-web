import { describe, expect, it } from "vitest";
import {
  annotationFileName,
  annotationIdFromFileName,
  parseResearchPilotAnnotation,
  parseResearchPilotAnnotationText,
  type ResearchPilotAnnotation,
} from "./pilotAnnotation.js";

const valid: ResearchPilotAnnotation = {
  version: 1,
  id: "ann-0123456789abcdef0123456789abcdef",
  libraryId: "pilot-llmwiki-graphics-three",
  paperId: "pilot-barron2021",
  pdfSha256: "a".repeat(64),
  page: 2,
  rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
  quote: "A selected passage.",
  kind: "question",
  body: "What does this imply?",
  status: "open",
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:00.000Z",
  revision: 1,
};

describe("local pilot annotation contract", () => {
  it("parses a strict annotation and binds its filename id", () => {
    expect(parseResearchPilotAnnotation(valid, valid.id)).toEqual(valid);
    expect(parseResearchPilotAnnotationText(JSON.stringify(valid), valid.id)).toEqual(valid);
    expect(annotationFileName(valid.id)).toBe(`${valid.id}.json`);
    expect(annotationIdFromFileName(`${valid.id}.json`)).toBe(valid.id);
    expect(annotationIdFromFileName("notes.json")).toBeUndefined();
  });

  it.each([
    ["wrong filename id", { expectedId: "ann-ffffffffffffffffffffffffffffffff" }],
    ["unknown field", { value: { ...valid, extra: true } }],
    ["invalid page", { value: { ...valid, page: 0 } }],
    ["oversized rect", { value: { ...valid, rect: { x: 0.8, y: 0, width: 0.3, height: 0.1 } } }],
    ["empty body", { value: { ...valid, body: "   " } }],
    ["noncanonical timestamp", { value: { ...valid, createdAt: "2026-08-08T12:00:00Z" } }],
    ["foreign revision digest", { value: { ...valid, pdfSha256: "A".repeat(64) } }],
  ])("rejects %s", (_label, patch) => {
    if ("expectedId" in patch) {
      expect(() => parseResearchPilotAnnotation(valid, patch.expectedId)).toThrow("file name");
    } else {
      expect(() => parseResearchPilotAnnotation(patch.value)).toThrow();
    }
  });

  it("allows wrapped text but rejects other control characters", () => {
    expect(parseResearchPilotAnnotation({ ...valid, quote: "line 1\nline 2\t" }).quote).toContain("line 2");
    expect(() => parseResearchPilotAnnotation({ ...valid, body: "bad\u0000text" })).toThrow("control");
  });
});
