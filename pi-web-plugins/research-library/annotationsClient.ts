import {
  annotationDirectoryPath,
  annotationFilePath,
  annotationIdFromFileName,
  applyAnnotationChanges,
  createAnnotationRecord,
  MAX_RESEARCH_ANNOTATION_BYTES,
  MAX_RESEARCH_ANNOTATIONS_PER_PAPER,
  parseAnnotationText,
  serializeAnnotation,
  sortAnnotations,
  type NewResearchAnnotationInput,
  type ResearchAnnotation,
  type ResearchAnnotationChanges,
} from "./annotationModel.js";

const missingWorkspaceFileError = "Path does not exist";

export interface AnnotationFileAccess {
  listFiles(path: string): Promise<{ entries: { name: string; path: string; type: "file" | "directory" | "symlink" }[]; truncated: boolean }>;
  readFile(path: string): Promise<{ content: string; size: number; truncated: boolean; binary: boolean }>;
  writeFile(path: string, content: string | Uint8Array, options?: { createDirs?: boolean; overwrite?: boolean }): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
}

export type PaperAnnotationsLoadResult =
  | { kind: "loaded"; annotations: ResearchAnnotation[]; warnings: string[] }
  | { kind: "unavailable"; error: string };

export interface AnnotationWriteOptions {
  now?: Date;
  randomBytes?: (target: Uint8Array<ArrayBuffer>) => void;
}

/** Read every stored annotation for one pilot paper, skipping unreadable records. */
export async function loadPaperAnnotations(
  files: Pick<AnnotationFileAccess, "listFiles" | "readFile">,
  scope: { libraryId: string; paperId: string },
): Promise<PaperAnnotationsLoadResult> {
  const directory = annotationDirectoryPath(scope.paperId);
  let listing: Awaited<ReturnType<AnnotationFileAccess["listFiles"]>>;
  try {
    listing = await files.listFiles(directory);
  } catch (error) {
    if (isMissingPath(error)) return { kind: "loaded", annotations: [], warnings: [] };
    return { kind: "unavailable", error: `Unable to list annotations: ${formatUnknownError(error)}` };
  }
  if (listing.truncated || listing.entries.length > MAX_RESEARCH_ANNOTATIONS_PER_PAPER) {
    return { kind: "unavailable", error: `More than ${String(MAX_RESEARCH_ANNOTATIONS_PER_PAPER)} annotation files are stored for this paper` };
  }

  const candidates = listing.entries
    .flatMap((entry) => {
      const id = entry.type === "file" ? annotationIdFromFileName(entry.name) : undefined;
      return id === undefined ? [] : [{ id, path: entry.path }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const annotations: ResearchAnnotation[] = [];
  const warnings: string[] = [];
  for (const candidate of candidates) {
    try {
      annotations.push(await readAnnotationFile(files, candidate.path, candidate.id, scope));
    } catch (error) {
      warnings.push(`${candidate.id}: ${formatUnknownError(error)}`);
    }
  }
  return { kind: "loaded", annotations: sortAnnotations(annotations), warnings };
}

/** Publish a new annotation without ever replacing an existing record. */
export async function createPaperAnnotation(
  files: Pick<AnnotationFileAccess, "writeFile">,
  input: NewResearchAnnotationInput,
  options: AnnotationWriteOptions = {},
): Promise<ResearchAnnotation> {
  const annotation = createAnnotationRecord(input, options);
  await files.writeFile(annotationFilePath(annotation.paperId, annotation.id), serializeAnnotation(annotation), { createDirs: true, overwrite: false });
  return annotation;
}

/**
 * Apply an edit only when the stored record still has the revision the caller
 * read. This is optimistic concurrency, not a lock: it detects a competing
 * writer rather than preventing one.
 */
export async function saveAnnotationChanges(
  files: Pick<AnnotationFileAccess, "readFile" | "writeFile">,
  annotation: ResearchAnnotation,
  changes: ResearchAnnotationChanges,
  options: AnnotationWriteOptions = {},
): Promise<ResearchAnnotation> {
  const path = annotationFilePath(annotation.paperId, annotation.id);
  const stored = await readAnnotationFile(files, path, annotation.id, annotation);
  if (stored.revision !== annotation.revision) throw new Error("This annotation changed elsewhere. Refresh before editing it again.");
  const updated = applyAnnotationChanges(stored, changes, options.now ?? new Date());
  await files.writeFile(path, serializeAnnotation(updated), { createDirs: false, overwrite: true });
  return updated;
}

export async function deleteAnnotationRecord(files: Pick<AnnotationFileAccess, "deleteFile">, annotation: ResearchAnnotation): Promise<void> {
  await files.deleteFile(annotationFilePath(annotation.paperId, annotation.id));
}

async function readAnnotationFile(
  files: Pick<AnnotationFileAccess, "readFile">,
  path: string,
  id: string,
  scope: { libraryId: string; paperId: string },
): Promise<ResearchAnnotation> {
  const file = await files.readFile(path);
  if (file.binary || file.truncated || file.size > MAX_RESEARCH_ANNOTATION_BYTES) throw new Error("annotation file is binary, truncated, or oversized");
  const parsed = parseAnnotationText(file.content, id);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.annotation.libraryId !== scope.libraryId) throw new Error("annotation belongs to a different library");
  if (parsed.annotation.paperId !== scope.paperId) throw new Error("annotation is stored under a different paper");
  return parsed.annotation;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && error.message === missingWorkspaceFileError;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
