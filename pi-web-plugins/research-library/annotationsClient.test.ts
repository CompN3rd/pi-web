import { describe, expect, it, vi } from "vitest";
import {
  annotationFilePath,
  createAnnotationRecord,
  RESEARCH_ANNOTATIONS_ROOT,
  serializeAnnotation,
  type ResearchAnnotation,
} from "./annotationModel.js";
import {
  createPaperAnnotation,
  deleteAnnotationRecord,
  loadPaperAnnotations,
  saveAnnotationChanges,
  type AnnotationFileAccess,
} from "./annotationsClient.js";

const libraryId = "pilot-llmwiki-graphics-three";
const paperId = "pilot-barron2021";
const directory = `${RESEARCH_ANNOTATIONS_ROOT}/${paperId}`;

describe("loadPaperAnnotations", () => {
  it("returns an empty list before any annotation exists", async () => {
    const files = fakeFiles({});
    files.listFiles.mockRejectedValueOnce(new Error("Path does not exist"));

    await expect(loadPaperAnnotations(files, { libraryId, paperId })).resolves.toEqual({ kind: "loaded", annotations: [], warnings: [] });
  });

  it("reads valid records in reading order and reports unusable ones", async () => {
    const first = record({ id: "ann-01".padEnd(36, "1"), page: 2 });
    const second = record({ id: "ann-02".padEnd(36, "2"), page: 1 });
    const foreign = record({ id: "ann-03".padEnd(36, "3"), page: 1, paperId: "pilot-muller2022instantngp" });
    const files = fakeFiles({
      [pathOf(first)]: serializeAnnotation(first),
      [pathOf(second)]: serializeAnnotation(second),
      [`${directory}/${foreign.id}.json`]: serializeAnnotation(foreign),
      [`${directory}/ann-04${"4".repeat(30)}.json`]: "{ not json",
      [`${directory}/notes.md`]: "ignored",
    });

    const result = await loadPaperAnnotations(files, { libraryId, paperId });

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") throw new Error(result.error);
    expect(result.annotations.map((annotation) => annotation.id)).toEqual([second.id, first.id]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).toContain("stored under a different paper");
  });

  it("refuses a truncated or oversized listing rather than showing a partial library", async () => {
    const files = fakeFiles({});
    files.listFiles.mockResolvedValueOnce({ entries: [], truncated: true });

    await expect(loadPaperAnnotations(files, { libraryId, paperId })).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("rejects a record that belongs to another library", async () => {
    const other = record({ id: "ann-05".padEnd(36, "5"), libraryId: "pilot-other-library" });
    const files = fakeFiles({ [pathOf(other)]: serializeAnnotation(other) });

    const result = await loadPaperAnnotations(files, { libraryId, paperId });

    if (result.kind !== "loaded") throw new Error(result.error);
    expect(result.annotations).toEqual([]);
    expect(result.warnings.join(" ")).toContain("different library");
  });

  it("rejects a record whose bytes are truncated or binary", async () => {
    const stored = record({ id: "ann-06".padEnd(36, "6") });
    const files = fakeFiles({ [pathOf(stored)]: serializeAnnotation(stored) });
    files.readFile.mockImplementationOnce(() => Promise.resolve({ content: serializeAnnotation(stored), size: 10, truncated: true, binary: false }));

    const result = await loadPaperAnnotations(files, { libraryId, paperId });

    if (result.kind !== "loaded") throw new Error(result.error);
    expect(result.warnings.join(" ")).toContain("truncated");
  });
});

describe("annotation writes", () => {
  it("publishes a new annotation without replacing an existing file", async () => {
    const files = fakeFiles({});

    const annotation = await createPaperAnnotation(files, {
      libraryId,
      paperId,
      pdfSha256: "a".repeat(64),
      page: 4,
      rect: { x: 0.7, y: 0.2, width: -0.2, height: 0.1 },
      quote: "Selected sentence.",
      kind: "question",
      body: "What does this mean?",
    }, { now: new Date("2026-08-08T12:00:00.000Z"), randomBytes: (target) => target.fill(7) });

    expect(annotation.rect).toEqual({ x: 0.5, y: 0.2, width: 0.2, height: 0.1 });
    expect(files.writeFile).toHaveBeenCalledExactlyOnceWith(pathOf(annotation), serializeAnnotation(annotation), { createDirs: true, overwrite: false });
  });

  it("saves an edit only against the revision the caller last read", async () => {
    const stored = record({ id: "ann-07".padEnd(36, "7") });
    const files = fakeFiles({ [pathOf(stored)]: serializeAnnotation(stored) });

    const updated = await saveAnnotationChanges(files, stored, { status: "resolved" }, { now: new Date("2026-08-08T14:00:00.000Z") });

    expect(updated.revision).toBe(2);
    expect(files.writeFile).toHaveBeenCalledExactlyOnceWith(pathOf(stored), serializeAnnotation(updated), { createDirs: false, overwrite: true });
  });

  it("refuses to overwrite an annotation that changed elsewhere", async () => {
    const stored = record({ id: "ann-08".padEnd(36, "8") });
    const advanced = { ...stored, revision: 5, body: "Edited in another tab" };
    const files = fakeFiles({ [pathOf(stored)]: serializeAnnotation(advanced) });

    await expect(saveAnnotationChanges(files, stored, { body: "Local edit" })).rejects.toThrow("changed elsewhere");
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("deletes exactly the annotation's own file", async () => {
    const stored = record({ id: "ann-09".padEnd(36, "9") });
    const files = fakeFiles({});

    await deleteAnnotationRecord(files, stored);

    expect(files.deleteFile).toHaveBeenCalledExactlyOnceWith(pathOf(stored));
  });
});

function pathOf(annotation: ResearchAnnotation): string {
  return annotationFilePath(annotation.paperId, annotation.id);
}

function record(overrides: { id: string; page?: number; paperId?: string; libraryId?: string }): ResearchAnnotation {
  return createAnnotationRecord({
    libraryId: overrides.libraryId ?? libraryId,
    paperId: overrides.paperId ?? paperId,
    pdfSha256: "b".repeat(64),
    page: overrides.page ?? 1,
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    quote: "Stored quote.",
    kind: "question",
    body: "Stored question?",
  }, { id: overrides.id, now: new Date("2026-08-08T12:00:00.000Z") });
}

function fakeFiles(stored: Record<string, string>) {
  const listFiles = vi.fn<AnnotationFileAccess["listFiles"]>(() => Promise.resolve({
    entries: Object.keys(stored).map((path) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, type: "file" as const })),
    truncated: false,
  }));
  const readFile = vi.fn<AnnotationFileAccess["readFile"]>((path) => {
    const content = stored[path];
    if (content === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve({ content, size: content.length, truncated: false, binary: false });
  });
  return {
    listFiles,
    readFile,
    writeFile: vi.fn<AnnotationFileAccess["writeFile"]>(() => Promise.resolve(undefined)),
    deleteFile: vi.fn<AnnotationFileAccess["deleteFile"]>(() => Promise.resolve(undefined)),
  };
}
