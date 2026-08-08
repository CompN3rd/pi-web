export const RESEARCH_LIBRARY_ANNOTATIONS_ROOT = ".pi-web/research-library-runtime/annotations";
export const MAX_RESEARCH_LIBRARY_ANNOTATION_BYTES = 32 * 1024;
export const MAX_RESEARCH_LIBRARY_ANNOTATIONS_PER_PAPER = 500;
export const MAX_RESEARCH_LIBRARY_ANNOTATION_BODY = 4_000;
export const MAX_RESEARCH_LIBRARY_ANNOTATION_QUOTE = 4_000;
export const MAX_RESEARCH_LIBRARY_ANNOTATION_PAGE = 10_000;

const annotationIdPattern = /^ann-[a-f0-9]{32}$/u;
const pilotIdPattern = /^pilot-[a-z][a-z0-9.-]{0,62}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type ResearchPilotAnnotationKind = "question" | "note";
export type ResearchPilotAnnotationStatus = "open" | "resolved";

export interface ResearchPilotAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResearchPilotAnnotation {
  version: 1;
  id: string;
  libraryId: string;
  paperId: string;
  pdfSha256: string;
  page: number;
  rect: ResearchPilotAnnotationRect;
  quote: string;
  kind: ResearchPilotAnnotationKind;
  body: string;
  status: ResearchPilotAnnotationStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export function annotationDirectoryComponents(paperId: string): string[] {
  if (!pilotIdPattern.test(paperId)) throw new Error("Pilot annotation paperId is invalid");
  return [...RESEARCH_LIBRARY_ANNOTATIONS_ROOT.split("/"), paperId];
}

export function annotationFileName(annotationId: string): string {
  if (!annotationIdPattern.test(annotationId)) throw new Error("Pilot annotation id is invalid");
  return `${annotationId}.json`;
}

export function annotationIdFromFileName(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  const id = name.slice(0, -".json".length);
  return annotationIdPattern.test(id) ? id : undefined;
}

export function parseResearchPilotAnnotationText(text: string, expectedId?: string): ResearchPilotAnnotation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Pilot annotation JSON is malformed");
  }
  return parseResearchPilotAnnotation(value, expectedId);
}

export function parseResearchPilotAnnotation(value: unknown, expectedId?: string): ResearchPilotAnnotation {
  if (!isRecord(value)) throw new Error("Pilot annotation must be an object");
  const keys = ["version", "id", "libraryId", "paperId", "pdfSha256", "page", "rect", "quote", "kind", "body", "status", "createdAt", "updatedAt", "revision"];
  if (!hasExactKeys(value, keys)) throw new Error("Pilot annotation contains missing or unknown fields");
  if (value["version"] !== 1) throw new Error("Pilot annotation version must be 1");

  const id = patternString(value["id"], "Pilot annotation id", annotationIdPattern);
  if (expectedId !== undefined && id !== expectedId) throw new Error("Pilot annotation id does not match its file name");
  const libraryId = patternString(value["libraryId"], "Pilot annotation libraryId", pilotIdPattern);
  const paperId = patternString(value["paperId"], "Pilot annotation paperId", pilotIdPattern);
  const pdfSha256 = patternString(value["pdfSha256"], "Pilot annotation pdfSha256", sha256Pattern);

  const page = value["page"];
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > MAX_RESEARCH_LIBRARY_ANNOTATION_PAGE) {
    throw new Error(`Pilot annotation page must be an integer between 1 and ${String(MAX_RESEARCH_LIBRARY_ANNOTATION_PAGE)}`);
  }
  const rect = parseRect(value["rect"]);
  const quote = boundedText(value["quote"], "Pilot annotation quote", MAX_RESEARCH_LIBRARY_ANNOTATION_QUOTE, true);
  const kind = value["kind"];
  if (kind !== "question" && kind !== "note") throw new Error("Pilot annotation kind must be question or note");
  const body = boundedText(value["body"], "Pilot annotation body", MAX_RESEARCH_LIBRARY_ANNOTATION_BODY, false);
  const status = value["status"];
  if (status !== "open" && status !== "resolved") throw new Error("Pilot annotation status must be open or resolved");
  const createdAt = canonicalTimestamp(value["createdAt"], "Pilot annotation createdAt");
  const updatedAt = canonicalTimestamp(value["updatedAt"], "Pilot annotation updatedAt");
  if (updatedAt < createdAt) throw new Error("Pilot annotation updatedAt precedes createdAt");
  const revision = value["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000) throw new Error("Pilot annotation revision must be a positive integer");

  return {
    version: 1,
    id,
    libraryId,
    paperId,
    pdfSha256,
    page,
    rect,
    quote,
    kind,
    body,
    status,
    createdAt,
    updatedAt,
    revision,
  };
}

function parseRect(value: unknown): ResearchPilotAnnotationRect {
  if (!isRecord(value) || !hasExactKeys(value, ["x", "y", "width", "height"])) throw new Error("Pilot annotation rect contains missing or unknown fields");
  const values: number[] = [];
  for (const key of ["x", "y", "width", "height"]) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 1) throw new Error(`Pilot annotation rect ${key} must be a 0-1 fraction`);
    values.push(candidate);
  }
  const x = values[0] ?? 0;
  const y = values[1] ?? 0;
  const width = values[2] ?? 0;
  const height = values[3] ?? 0;
  if (x + width > 1.000_001 || y + height > 1.000_001) throw new Error("Pilot annotation rect extends past the page");
  if (width <= 0 || height <= 0) throw new Error("Pilot annotation rect must have a positive area");
  return { x, y, width, height };
}

function boundedText(value: unknown, label: string, limit: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!allowEmpty && value.trim() === "") throw new Error(`${label} must not be empty`);
  if (value.length > limit) throw new Error(`${label} exceeds ${String(limit)} characters`);
  if (hasControlCharacter(value)) throw new Error(`${label} contains control characters`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value) || new Date(value).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return value;
}

function patternString(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
