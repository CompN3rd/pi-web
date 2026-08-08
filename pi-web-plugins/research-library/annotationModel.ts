import { RESEARCH_LIBRARY_RUNTIME_ROOT } from "./config.js";

export const RESEARCH_ANNOTATION_VERSION = 1;
export const RESEARCH_ANNOTATIONS_ROOT = `${RESEARCH_LIBRARY_RUNTIME_ROOT}/annotations`;
export const MAX_RESEARCH_ANNOTATION_BYTES = 32 * 1024;
export const MAX_RESEARCH_ANNOTATIONS_PER_PAPER = 500;
export const MAX_RESEARCH_ANNOTATION_BODY = 4_000;
export const MAX_RESEARCH_ANNOTATION_QUOTE = 4_000;
export const MAX_RESEARCH_ANNOTATION_PAGE = 10_000;

const annotationIdPattern = /^ann-[a-f0-9]{32}$/u;
const paperIdPattern = /^pilot-[a-z][a-z0-9.-]{0,62}$/u;
const libraryIdPattern = /^pilot-[a-z][a-z0-9.-]{0,62}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type ResearchAnnotationKind = "question" | "note";
export type ResearchAnnotationStatus = "open" | "resolved";

/** Normalized page-relative rectangle; every value is a 0-1 fraction of the unrotated page box. */
export interface ResearchAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One durable marked region on one immutable pilot PDF revision. The anchor
 * (`paperId`, `pdfSha256`, `page`, `rect`, `quote`) is captured once and never
 * rewritten; only `kind`, `body`, and `status` change, each bumping `revision`.
 */
export interface ResearchAnnotation {
  version: typeof RESEARCH_ANNOTATION_VERSION;
  id: string;
  libraryId: string;
  paperId: string;
  pdfSha256: string;
  page: number;
  rect: ResearchAnnotationRect;
  quote: string;
  kind: ResearchAnnotationKind;
  body: string;
  status: ResearchAnnotationStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface NewResearchAnnotationInput {
  libraryId: string;
  paperId: string;
  pdfSha256: string;
  page: number;
  rect: ResearchAnnotationRect;
  quote: string;
  kind: ResearchAnnotationKind;
  body: string;
}

export interface ResearchAnnotationChanges {
  kind?: ResearchAnnotationKind;
  body?: string;
  status?: ResearchAnnotationStatus;
}

export type ParseResearchAnnotationResult =
  | { ok: true; annotation: ResearchAnnotation }
  | { ok: false; error: string };

export function annotationDirectoryPath(paperId: string): string {
  if (!paperIdPattern.test(paperId)) throw new Error("Annotation paperId is not a safe path segment");
  return `${RESEARCH_ANNOTATIONS_ROOT}/${paperId}`;
}

export function annotationFilePath(paperId: string, annotationId: string): string {
  if (!annotationIdPattern.test(annotationId)) throw new Error("Annotation id is not a safe path segment");
  return `${annotationDirectoryPath(paperId)}/${annotationId}.json`;
}

export function annotationIdFromFileName(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  const id = name.slice(0, -".json".length);
  return annotationIdPattern.test(id) ? id : undefined;
}

export function newAnnotationId(randomBytes: (target: Uint8Array<ArrayBuffer>) => void = defaultRandomBytes): string {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  randomBytes(bytes);
  return `ann-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createAnnotationRecord(
  input: NewResearchAnnotationInput,
  options: { id?: string; now?: Date; randomBytes?: (target: Uint8Array<ArrayBuffer>) => void } = {},
): ResearchAnnotation {
  const createdAt = (options.now ?? new Date()).toISOString();
  const candidate: ResearchAnnotation = {
    version: RESEARCH_ANNOTATION_VERSION,
    id: options.id ?? newAnnotationId(options.randomBytes),
    libraryId: input.libraryId,
    paperId: input.paperId,
    pdfSha256: input.pdfSha256,
    page: input.page,
    rect: normalizedRect(input.rect),
    quote: input.quote,
    kind: input.kind,
    body: input.body,
    status: "open",
    createdAt,
    updatedAt: createdAt,
    revision: 1,
  };
  const parsed = parseResearchAnnotation(candidate);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.annotation;
}

/** Apply a bounded edit, keeping the immutable anchor and advancing `revision`. */
export function applyAnnotationChanges(
  annotation: ResearchAnnotation,
  changes: ResearchAnnotationChanges,
  now: Date = new Date(),
): ResearchAnnotation {
  const candidate: ResearchAnnotation = {
    ...annotation,
    kind: changes.kind ?? annotation.kind,
    body: changes.body ?? annotation.body,
    status: changes.status ?? annotation.status,
    updatedAt: now.toISOString(),
    revision: annotation.revision + 1,
  };
  const parsed = parseResearchAnnotation(candidate);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.annotation;
}

export function serializeAnnotation(annotation: ResearchAnnotation): string {
  return `${JSON.stringify({
    version: annotation.version,
    id: annotation.id,
    libraryId: annotation.libraryId,
    paperId: annotation.paperId,
    pdfSha256: annotation.pdfSha256,
    page: annotation.page,
    rect: {
      x: annotation.rect.x,
      y: annotation.rect.y,
      width: annotation.rect.width,
      height: annotation.rect.height,
    },
    quote: annotation.quote,
    kind: annotation.kind,
    body: annotation.body,
    status: annotation.status,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    revision: annotation.revision,
  }, undefined, 2)}\n`;
}

export function parseAnnotationText(text: string, expectedId?: string): ParseResearchAnnotationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalid(`Invalid annotation JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseResearchAnnotation(value, expectedId);
}

export function parseResearchAnnotation(value: unknown, expectedId?: string): ParseResearchAnnotationResult {
  if (!isRecord(value)) return invalid("Annotation must be an object");
  const keys = ["version", "id", "libraryId", "paperId", "pdfSha256", "page", "rect", "quote", "kind", "body", "status", "createdAt", "updatedAt", "revision"];
  if (!hasExactKeys(value, keys)) return invalid("Annotation contains missing or unknown fields");
  if (value["version"] !== RESEARCH_ANNOTATION_VERSION) return invalid("Annotation version must be 1");

  const id = patternString(value["id"], "Annotation id", annotationIdPattern);
  if (!id.ok) return id;
  if (expectedId !== undefined && id.value !== expectedId) return invalid("Annotation id does not match its file name");
  const libraryId = patternString(value["libraryId"], "Annotation libraryId", libraryIdPattern);
  if (!libraryId.ok) return libraryId;
  const paperId = patternString(value["paperId"], "Annotation paperId", paperIdPattern);
  if (!paperId.ok) return paperId;
  const pdfSha256 = patternString(value["pdfSha256"], "Annotation pdfSha256", sha256Pattern);
  if (!pdfSha256.ok) return pdfSha256;

  const page = value["page"];
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > MAX_RESEARCH_ANNOTATION_PAGE) {
    return invalid(`Annotation page must be an integer between 1 and ${String(MAX_RESEARCH_ANNOTATION_PAGE)}`);
  }
  const rect = parseRect(value["rect"]);
  if (!rect.ok) return rect;

  const quote = boundedString(value["quote"], "Annotation quote", MAX_RESEARCH_ANNOTATION_QUOTE, true);
  if (!quote.ok) return quote;
  const kind = value["kind"];
  if (kind !== "question" && kind !== "note") return invalid("Annotation kind must be question or note");
  const body = boundedString(value["body"], "Annotation body", MAX_RESEARCH_ANNOTATION_BODY, false);
  if (!body.ok) return body;
  const status = value["status"];
  if (status !== "open" && status !== "resolved") return invalid("Annotation status must be open or resolved");

  const createdAt = patternString(value["createdAt"], "Annotation createdAt", timestampPattern);
  if (!createdAt.ok) return createdAt;
  const updatedAt = patternString(value["updatedAt"], "Annotation updatedAt", timestampPattern);
  if (!updatedAt.ok) return updatedAt;
  if (updatedAt.value < createdAt.value) return invalid("Annotation updatedAt precedes createdAt");
  const revision = value["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) {
    return invalid("Annotation revision must be a positive integer");
  }

  return {
    ok: true,
    annotation: {
      version: RESEARCH_ANNOTATION_VERSION,
      id: id.value,
      libraryId: libraryId.value,
      paperId: paperId.value,
      pdfSha256: pdfSha256.value,
      page,
      rect: rect.value,
      quote: quote.value,
      kind,
      body: body.value,
      status,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      revision,
    },
  };
}

/** Clamp a drawn rectangle into the page box and round to stable four-decimal fractions. */
export function normalizedRect(rect: ResearchAnnotationRect): ResearchAnnotationRect {
  const left = clampFraction(Math.min(rect.x, rect.x + rect.width));
  const top = clampFraction(Math.min(rect.y, rect.y + rect.height));
  const right = clampFraction(Math.max(rect.x, rect.x + rect.width));
  const bottom = clampFraction(Math.max(rect.y, rect.y + rect.height));
  return {
    x: round4(left),
    y: round4(top),
    width: round4(Math.max(right - left, 0)),
    height: round4(Math.max(bottom - top, 0)),
  };
}

export function sortAnnotations(annotations: ResearchAnnotation[]): ResearchAnnotation[] {
  return [...annotations].sort((left, right) =>
    left.page - right.page
    || left.rect.y - right.rect.y
    || left.rect.x - right.rect.x
    || left.id.localeCompare(right.id));
}

function parseRect(value: unknown): { ok: true; value: ResearchAnnotationRect } | { ok: false; error: string } {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y", "width", "height"])) return invalid("Annotation rect contains missing or unknown fields");
  const parsed: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"]) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
      return invalid(`Annotation rect ${key} must be a 0-1 fraction`);
    }
    parsed[key] = candidate;
  }
  const rect = { x: parsed["x"] ?? 0, y: parsed["y"] ?? 0, width: parsed["width"] ?? 0, height: parsed["height"] ?? 0 };
  if (rect.x + rect.width > 1.000_001 || rect.y + rect.height > 1.000_001) return invalid("Annotation rect extends past the page");
  if (rect.width <= 0 || rect.height <= 0) return invalid("Annotation rect must have a positive area");
  return { ok: true, value: rect };
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty: boolean): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return invalid(`${label} must be a string`);
  if (!allowEmpty && value.trim() === "") return invalid(`${label} must not be empty`);
  if (value.length > maxLength) return invalid(`${label} exceeds ${String(maxLength)} characters`);
  if (hasControlCharacter(value)) return invalid(`${label} contains control characters`);
  return { ok: true, value };
}

function patternString(value: unknown, label: string, pattern: RegExp): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !pattern.test(value)) return invalid(`${label} is invalid`);
  return { ok: true, value };
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wrapped text may contain tabs and newlines; every other C0/C1 control is rejected. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function defaultRandomBytes(target: Uint8Array<ArrayBuffer>): void {
  crypto.getRandomValues(target);
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
