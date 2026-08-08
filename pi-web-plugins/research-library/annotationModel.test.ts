import { describe, expect, it } from "vitest";
import {
  annotationDirectoryPath,
  annotationFilePath,
  annotationIdFromFileName,
  applyAnnotationChanges,
  createAnnotationRecord,
  MAX_RESEARCH_ANNOTATION_BODY,
  newAnnotationId,
  normalizedRect,
  parseAnnotationText,
  parseResearchAnnotation,
  RESEARCH_ANNOTATIONS_ROOT,
  serializeAnnotation,
  sortAnnotations,
  type ResearchAnnotation,
} from "./annotationModel.js";

describe("research annotation records", () => {
  it("creates a bounded open record that round-trips through its serialized form", () => {
    const annotation = createRecord();

    expect(annotation).toMatchObject({
      version: 1,
      id: "ann-01010101010101010101010101010101",
      paperId: "pilot-barron2021",
      page: 3,
      status: "open",
      kind: "question",
      revision: 1,
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    });

    const serialized = serializeAnnotation(annotation);
    expect(serialized.endsWith("}\n")).toBe(true);
    const parsed = parseAnnotationText(serialized, annotation.id);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.annotation).toEqual(annotation);
    expect(serializeAnnotation(parsed.annotation)).toBe(serialized);
  });

  it("advances the revision on edit while keeping the immutable anchor", () => {
    const annotation = createRecord();

    const updated = applyAnnotationChanges(annotation, { body: "Rewritten question", status: "resolved" }, new Date("2026-08-08T13:30:00.000Z"));

    expect(updated).toMatchObject({ body: "Rewritten question", status: "resolved", revision: 2, updatedAt: "2026-08-08T13:30:00.000Z" });
    expect({ page: updated.page, rect: updated.rect, quote: updated.quote, pdfSha256: updated.pdfSha256, createdAt: updated.createdAt })
      .toEqual({ page: annotation.page, rect: annotation.rect, quote: annotation.quote, pdfSha256: annotation.pdfSha256, createdAt: annotation.createdAt });
  });

  it("refuses records that are malformed, unbounded, or inconsistent", () => {
    const valid: Record<string, unknown> = { ...createRecord() };
    const mutate = (changes: Record<string, unknown>): string | undefined => {
      const result = parseResearchAnnotation({ ...valid, ...changes });
      return result.ok ? undefined : result.error;
    };

    expect(mutate({ version: 2 })).toContain("version must be 1");
    expect(mutate({ id: "ann-not-hex" })).toContain("id is invalid");
    expect(mutate({ paperId: "../escape" })).toContain("paperId is invalid");
    expect(mutate({ pdfSha256: "AB" })).toContain("pdfSha256 is invalid");
    expect(mutate({ page: 0 })).toContain("page must be an integer");
    expect(mutate({ page: 1.5 })).toContain("page must be an integer");
    expect(mutate({ rect: { x: 0.9, y: 0.1, width: 0.5, height: 0.1 } })).toContain("extends past the page");
    expect(mutate({ rect: { x: 0.1, y: 0.1, width: 0, height: 0.1 } })).toContain("positive area");
    expect(mutate({ rect: { x: 0.1, y: 0.1, width: 0.1 } })).toContain("missing or unknown fields");
    expect(mutate({ body: "" })).toContain("body must not be empty");
    expect(mutate({ body: "bell\u0007" })).toContain("control characters");
    expect(mutate({ body: "line one\nline two\tindented" })).toBeUndefined();
    expect(mutate({ body: "x".repeat(MAX_RESEARCH_ANNOTATION_BODY + 1) })).toContain("exceeds");
    expect(mutate({ kind: "highlight" })).toContain("kind must be question or note");
    expect(mutate({ status: "archived" })).toContain("status must be open or resolved");
    expect(mutate({ updatedAt: "2020-01-01T00:00:00.000Z" })).toContain("precedes createdAt");
    expect(mutate({ createdAt: "2026-08-08" })).toContain("createdAt is invalid");
    expect(mutate({ revision: 0 })).toContain("revision must be a positive integer");
    expect(mutate({ extra: true })).toContain("missing or unknown fields");
    expect(parseAnnotationText("{", "ann-01010101010101010101010101010101").ok).toBe(false);
  });

  it("binds a record to the file name it was read from", () => {
    const annotation = createRecord();
    const parsed = parseAnnotationText(serializeAnnotation(annotation), "ann-02020202020202020202020202020202");

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("mismatched id unexpectedly parsed");
    expect(parsed.error).toContain("does not match its file name");
  });

  it("builds paths only from validated identifier segments", () => {
    expect(annotationDirectoryPath("pilot-barron2021")).toBe(`${RESEARCH_ANNOTATIONS_ROOT}/pilot-barron2021`);
    expect(annotationFilePath("pilot-barron2021", "ann-01010101010101010101010101010101"))
      .toBe(`${RESEARCH_ANNOTATIONS_ROOT}/pilot-barron2021/ann-01010101010101010101010101010101.json`);
    expect(() => annotationDirectoryPath("../etc")).toThrow("safe path segment");
    expect(() => annotationFilePath("pilot-barron2021", "../../secret")).toThrow("safe path segment");
    expect(annotationIdFromFileName("ann-01010101010101010101010101010101.json")).toBe("ann-01010101010101010101010101010101");
    expect(annotationIdFromFileName("notes.json")).toBeUndefined();
    expect(annotationIdFromFileName("ann-01010101010101010101010101010101.txt")).toBeUndefined();
  });

  it("normalizes rectangles drawn in any direction and clamps them to the page", () => {
    expect(normalizedRect({ x: 0.6, y: 0.8, width: -0.2, height: -0.3 })).toEqual({ x: 0.4, y: 0.5, width: 0.2, height: 0.3 });
    expect(normalizedRect({ x: -0.5, y: 0.5, width: 2, height: 2 })).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(normalizedRect({ x: 0.123_456, y: 0, width: 0.1, height: 0.1 }).x).toBe(0.1235);
  });

  it("generates distinct ids and orders annotations for reading", () => {
    expect(newAnnotationId((target) => target.fill(255))).toBe("ann-ffffffffffffffffffffffffffffffff");
    expect(newAnnotationId()).not.toBe(newAnnotationId());

    const first = createRecord({ id: "ann-01010101010101010101010101010101", page: 2, rect: { x: 0.1, y: 0.4, width: 0.2, height: 0.1 } });
    const second = createRecord({ id: "ann-02020202020202020202020202020202", page: 1, rect: { x: 0.5, y: 0.2, width: 0.2, height: 0.1 } });
    const third = createRecord({ id: "ann-03030303030303030303030303030303", page: 1, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } });

    expect(sortAnnotations([first, second, third]).map((annotation) => annotation.id)).toEqual([third.id, second.id, first.id]);
  });
});

function createRecord(overrides: { id?: string; page?: number; rect?: ResearchAnnotation["rect"] } = {}): ResearchAnnotation {
  return createAnnotationRecord({
    libraryId: "pilot-llmwiki-graphics-three",
    paperId: "pilot-barron2021",
    pdfSha256: "a".repeat(64),
    page: overrides.page ?? 3,
    rect: overrides.rect ?? { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
    quote: "Mip-NeRF reduces objectionable aliasing artifacts.",
    kind: "question",
    body: "Why does the conical frustum help here?",
  }, { id: overrides.id ?? "ann-01010101010101010101010101010101", now: new Date("2026-08-08T12:00:00.000Z") });
}
