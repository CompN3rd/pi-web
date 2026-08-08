export const RESEARCH_LIBRARY_PILOT_CONFIG_PATH = "raw/_processed/research-library-pilot/library.json";
export const RESEARCH_LIBRARY_PILOT_VERSION = 1;
export const MAX_RESEARCH_LIBRARY_PILOT_BYTES = 256 * 1024;
export const MAX_RESEARCH_LIBRARY_PILOT_PAPERS = 20;
export const MAX_RESEARCH_LIBRARY_PILOT_PDF_BYTES = 128 * 1024 * 1024;
export const RESEARCH_LIBRARY_PILOT_RIGHTS = "local-research-copy; redistribution-not-asserted";

const MAX_SHORT_STRING_LENGTH = 256;
const MAX_LONG_STRING_LENGTH = 8_192;
const MAX_URL_LENGTH = 2_048;
const pilotIdPattern = /^pilot-[a-z][a-z0-9.-]{0,62}$/u;
const bibkeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface LocalResearchLibraryPilotConfig {
  version: typeof RESEARCH_LIBRARY_PILOT_VERSION;
  pilot: true;
  libraryId: string;
  papers: LocalPilotPaper[];
}

export interface LocalPilotPaper {
  id: string;
  bibkey: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  sourceNotePath: string;
  sourceNoteSha256: string;
  relatedTopics: string[];
  metaCategories: string[];
  usedBy: string[];
  pdf: LocalPilotPdf;
}

export interface LocalPilotPdf {
  path: string;
  sha256: string;
  size: number;
  sourceUrl: string;
  sourcePageUrl: string;
  retrievedAt: string;
  rights: typeof RESEARCH_LIBRARY_PILOT_RIGHTS;
}

export type ParseLocalPilotConfigResult =
  | { ok: true; config: LocalResearchLibraryPilotConfig }
  | { ok: false; error: string };

export function parseLocalPilotConfigText(text: string): ParseLocalPilotConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalid(`Invalid pilot JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseLocalPilotConfig(value);
}

export function parseLocalPilotConfig(value: unknown): ParseLocalPilotConfigResult {
  if (!isRecord(value)) return invalid("Pilot config must be an object");
  if (!hasExactKeys(value, ["version", "pilot", "libraryId", "papers"])) return invalid("Pilot config contains missing or unknown fields");
  if (value["version"] !== RESEARCH_LIBRARY_PILOT_VERSION) return invalid("Pilot config version must be 1");
  if (value["pilot"] !== true) return invalid("Pilot config pilot must be true");

  const libraryId = patternString(value["libraryId"], "Pilot libraryId", pilotIdPattern);
  if (!libraryId.ok) return libraryId;
  const paperValues = value["papers"];
  if (!Array.isArray(paperValues) || paperValues.length === 0 || paperValues.length > MAX_RESEARCH_LIBRARY_PILOT_PAPERS) {
    return invalid(`Pilot papers must contain 1-${String(MAX_RESEARCH_LIBRARY_PILOT_PAPERS)} entries`);
  }

  const ids = new Set<string>();
  const bibkeys = new Set<string>();
  const pdfPaths = new Set<string>();
  const sourceNotePaths = new Set<string>();
  const papers: LocalPilotPaper[] = [];
  for (const [index, paperValue] of paperValues.entries()) {
    const result = parsePilotPaper(paperValue, index);
    if (!result.ok) return result;
    const paper = result.paper;
    if (ids.has(paper.id)) return invalid(`Duplicate pilot paper id: ${paper.id}`);
    if (bibkeys.has(paper.bibkey)) return invalid(`Duplicate pilot bibkey: ${paper.bibkey}`);
    if (pdfPaths.has(paper.pdf.path)) return invalid(`Duplicate pilot PDF path: ${paper.pdf.path}`);
    if (sourceNotePaths.has(paper.sourceNotePath)) return invalid(`Duplicate pilot source-note path: ${paper.sourceNotePath}`);
    ids.add(paper.id);
    bibkeys.add(paper.bibkey);
    pdfPaths.add(paper.pdf.path);
    sourceNotePaths.add(paper.sourceNotePath);
    papers.push(paper);
  }

  return { ok: true, config: { version: 1, pilot: true, libraryId: libraryId.value, papers } };
}

export function pilotPaperById(config: LocalResearchLibraryPilotConfig, paperId: string): LocalPilotPaper | undefined {
  return config.papers.find((paper) => paper.id === paperId);
}

function parsePilotPaper(value: unknown, index: number): { ok: true; paper: LocalPilotPaper } | { ok: false; error: string } {
  const label = `Pilot paper ${String(index + 1)}`;
  const required = ["id", "bibkey", "title", "authors", "sourceNotePath", "sourceNoteSha256", "relatedTopics", "metaCategories", "usedBy", "pdf"];
  const optional = ["year", "abstract"];
  if (!isRecord(value)) return invalid(`${label} must be an object`);
  if (!hasExactKeys(value, required, optional)) return invalid(`${label} contains missing or unknown fields`);

  const id = patternString(value["id"], `${label} id`, pilotIdPattern);
  if (!id.ok) return id;
  const bibkey = patternString(value["bibkey"], `${label} bibkey`, bibkeyPattern);
  if (!bibkey.ok) return bibkey;
  const title = boundedString(value["title"], `${label} title`, MAX_SHORT_STRING_LENGTH);
  if (!title.ok) return title;
  const authors = boundedStringArray(value["authors"], `${label} authors`, 20, false);
  if (!authors.ok) return authors;
  const year = optionalYear(value["year"], label);
  if (!year.ok) return year;
  const abstract = optionalBoundedString(value["abstract"], `${label} abstract`, MAX_LONG_STRING_LENGTH);
  if (!abstract.ok) return abstract;
  const parsedSourceNotePath = parseSourceNotePath(value["sourceNotePath"], `${label} sourceNotePath`);
  if (!parsedSourceNotePath.ok) return parsedSourceNotePath;
  const sourceNoteSha256 = patternString(value["sourceNoteSha256"], `${label} sourceNoteSha256`, sha256Pattern);
  if (!sourceNoteSha256.ok) return sourceNoteSha256;
  const relatedTopics = boundedStringArray(value["relatedTopics"], `${label} relatedTopics`, 50, true);
  if (!relatedTopics.ok) return relatedTopics;
  const metaCategories = boundedStringArray(value["metaCategories"], `${label} metaCategories`, 50, true);
  if (!metaCategories.ok) return metaCategories;
  const usedBy = relativePathArray(value["usedBy"], `${label} usedBy`, 100);
  if (!usedBy.ok) return usedBy;
  const pdf = parsePilotPdf(value["pdf"], label);
  if (!pdf.ok) return pdf;

  return {
    ok: true,
    paper: {
      id: id.value,
      bibkey: bibkey.value,
      title: title.value,
      authors: authors.value,
      ...(year.value === undefined ? {} : { year: year.value }),
      ...(abstract.value === undefined ? {} : { abstract: abstract.value }),
      sourceNotePath: parsedSourceNotePath.value,
      sourceNoteSha256: sourceNoteSha256.value,
      relatedTopics: relatedTopics.value,
      metaCategories: metaCategories.value,
      usedBy: usedBy.value,
      pdf: pdf.pdf,
    },
  };
}

function parsePilotPdf(value: unknown, paperLabel: string): { ok: true; pdf: LocalPilotPdf } | { ok: false; error: string } {
  const label = `${paperLabel} PDF`;
  if (!isRecord(value)) return invalid(`${label} must be an object`);
  if (!hasExactKeys(value, ["path", "sha256", "size", "sourceUrl", "sourcePageUrl", "retrievedAt", "rights"])) {
    return invalid(`${label} contains missing or unknown fields`);
  }
  const path = pilotPdfPath(value["path"], `${label} path`);
  if (!path.ok) return path;
  const sha256 = patternString(value["sha256"], `${label} sha256`, sha256Pattern);
  if (!sha256.ok) return sha256;
  const size = value["size"];
  if (!Number.isSafeInteger(size) || typeof size !== "number" || size < 5 || size > MAX_RESEARCH_LIBRARY_PILOT_PDF_BYTES) {
    return invalid(`${label} size must be an integer from 5 to ${String(MAX_RESEARCH_LIBRARY_PILOT_PDF_BYTES)}`);
  }
  const sourceUrl = httpUrl(value["sourceUrl"], `${label} sourceUrl`);
  if (!sourceUrl.ok) return sourceUrl;
  const sourcePageUrl = httpUrl(value["sourcePageUrl"], `${label} sourcePageUrl`);
  if (!sourcePageUrl.ok) return sourcePageUrl;
  const retrievedAt = timestamp(value["retrievedAt"], `${label} retrievedAt`);
  if (!retrievedAt.ok) return retrievedAt;
  if (value["rights"] !== RESEARCH_LIBRARY_PILOT_RIGHTS) return invalid(`${label} rights must explicitly state ${RESEARCH_LIBRARY_PILOT_RIGHTS}`);
  return {
    ok: true,
    pdf: {
      path: path.value,
      sha256: sha256.value,
      size,
      sourceUrl: sourceUrl.value,
      sourcePageUrl: sourcePageUrl.value,
      retrievedAt: retrievedAt.value,
      rights: RESEARCH_LIBRARY_PILOT_RIGHTS,
    },
  };
}

function pilotPdfPath(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  const result = normalizedRelativePath(value, label);
  if (!result.ok) return result;
  if (!result.value.startsWith("raw/research-library-pilot/") || !result.value.toLowerCase().endsWith(".pdf")) {
    return invalid(`${label} must be a .pdf beneath raw/research-library-pilot/`);
  }
  return result;
}

function parseSourceNotePath(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  const result = normalizedRelativePath(value, label);
  if (!result.ok) return result;
  if (!result.value.startsWith("Thesis/Citations/") || !result.value.endsWith(".md")) {
    return invalid(`${label} must be a Markdown note beneath Thesis/Citations/`);
  }
  return result;
}

function relativePathArray(value: unknown, label: string, limit: number): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > limit) return invalid(`${label} must be an array with at most ${String(limit)} entries`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const path = normalizedRelativePath(entry, `${label} entry`);
    if (!path.ok) return path;
    if (seen.has(path.value)) return invalid(`${label} contains a duplicate entry`);
    seen.add(path.value);
    result.push(path.value);
  }
  return { ok: true, value: result };
}

function normalizedRelativePath(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value === "" || value.length > 1_024 || containsControl(value)) return invalid(`${label} must be a bounded relative path`);
  if (value.includes("\\") || value.includes(":") || value.startsWith("/") || value.includes("?") || value.includes("#")) {
    return invalid(`${label} must be a normalized forward-slash relative path without an alternate data stream`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return invalid(`${label} contains an unsafe path segment`);
  return { ok: true, value };
}

function httpUrl(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || containsControl(value)) return invalid(`${label} must be a bounded absolute HTTP(S) URL`);
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.hash !== "") throw new Error("unsafe URL");
    return { ok: true, value: url.href };
  } catch {
    return invalid(`${label} must be a bounded absolute HTTP(S) URL without credentials or a fragment`);
  }
}

function timestamp(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return invalid(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return invalid(`${label} must be a canonical ISO timestamp`);
  return { ok: true, value };
}

function patternString(value: unknown, label: string, pattern: RegExp): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !pattern.test(value)) return invalid(`${label} must match ${pattern.source}`);
  return { ok: true, value };
}

function boundedStringArray(value: unknown, label: string, limit: number, emptyAllowed: boolean): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > limit || (!emptyAllowed && value.length === 0)) {
    return invalid(`${label} must be ${emptyAllowed ? "an" : "a non-empty"} array with at most ${String(limit)} entries`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = boundedString(entry, `${label} entry`, MAX_SHORT_STRING_LENGTH);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value)) return invalid(`${label} contains a duplicate entry`);
    seen.add(parsed.value);
    result.push(parsed.value);
  }
  return { ok: true, value: result };
}

function boundedString(value: unknown, label: string, limit: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "" || value.length > limit || containsControl(value)) {
    return invalid(`${label} must be a non-empty string of at most ${String(limit)} characters without control characters`);
  }
  return { ok: true, value };
}

function optionalBoundedString(value: unknown, label: string, limit: number): { ok: true; value: string | undefined } | { ok: false; error: string } {
  return value === undefined ? { ok: true, value: undefined } : boundedString(value, label, limit);
}

function optionalYear(value: unknown, label: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1000 || value > 9999) return invalid(`${label} year must be a four-digit integer`);
  return { ok: true, value };
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))) return true;
  }
  return false;
}

function hasExactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) && keys.every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
