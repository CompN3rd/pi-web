export const RESEARCH_LIBRARY_CONFIG_PATH = ".pi-web/research-library.synthetic.json";
export const RESEARCH_LIBRARY_RUNTIME_ROOT = ".pi-web/research-library-runtime";
export const RESEARCH_LIBRARY_CONFIG_VERSION = 1;
export const MAX_RESEARCH_LIBRARY_CONFIG_BYTES = 256 * 1024;

const MAX_PAPERS = 50;
const MAX_PASSAGES_PER_PAPER = 20;
const MAX_CITATIONS_PER_PAPER = 50;
const MAX_STRING_LENGTH = 8_192;
const MAX_SHORT_STRING_LENGTH = 256;
const syntheticIdPattern = /^synthetic-[a-z][a-z0-9.-]{0,62}$/u;

export interface SyntheticResearchLibraryConfig {
  version: typeof RESEARCH_LIBRARY_CONFIG_VERSION;
  synthetic: true;
  libraryId: string;
  papers: SyntheticPaper[];
}

export interface SyntheticPaper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  tags: string[];
  collections: string[];
  passages: SyntheticPassage[];
  cites: string[];
}

export interface SyntheticPassage {
  id: string;
  page: number;
  quote: string;
  question: string;
}

export type ParseResearchLibraryConfigResult =
  | { ok: true; config: SyntheticResearchLibraryConfig }
  | { ok: false; error: string };

export function parseResearchLibraryConfigText(text: string): ParseResearchLibraryConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalid(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseResearchLibraryConfig(value);
}

export function parseResearchLibraryConfig(value: unknown): ParseResearchLibraryConfigResult {
  if (!isRecord(value)) return invalid("Config must be an object");
  if (!hasOnlyKeys(value, ["version", "synthetic", "libraryId", "papers"])) return invalid("Config contains unknown fields");
  if (value["version"] !== RESEARCH_LIBRARY_CONFIG_VERSION) return invalid("Config version must be 1");
  if (value["synthetic"] !== true) return invalid("Config synthetic must be true");

  const libraryId = syntheticId(value["libraryId"], "Config libraryId");
  if (!libraryId.ok) return libraryId;

  const papersValue = value["papers"];
  if (!Array.isArray(papersValue)) return invalid("Config papers must be an array");
  if (papersValue.length === 0 || papersValue.length > MAX_PAPERS) return invalid(`Config papers must contain 1-${String(MAX_PAPERS)} entries`);

  const papers: SyntheticPaper[] = [];
  const paperIds = new Set<string>();
  for (const [index, paperValue] of papersValue.entries()) {
    const paper = parsePaper(paperValue, index);
    if (!paper.ok) return paper;
    if (paperIds.has(paper.paper.id)) return invalid(`Duplicate paper id: ${paper.paper.id}`);
    paperIds.add(paper.paper.id);
    papers.push(paper.paper);
  }

  for (const paper of papers) {
    for (const targetId of paper.cites) {
      if (!paperIds.has(targetId)) return invalid(`Paper ${paper.id} cites unknown paper: ${targetId}`);
    }
  }

  return {
    ok: true,
    config: {
      version: RESEARCH_LIBRARY_CONFIG_VERSION,
      synthetic: true,
      libraryId: libraryId.value,
      papers,
    },
  };
}

export function citedByPaperIds(config: SyntheticResearchLibraryConfig, paperId: string): string[] {
  return config.papers.filter((paper) => paper.cites.includes(paperId)).map((paper) => paper.id).sort();
}

export function paperById(config: SyntheticResearchLibraryConfig, paperId: string): SyntheticPaper | undefined {
  return config.papers.find((paper) => paper.id === paperId);
}

interface ParsePaperResult {
  ok: true;
  paper: SyntheticPaper;
}

function parsePaper(value: unknown, index: number): ParsePaperResult | { ok: false; error: string } {
  const label = `Paper ${String(index + 1)}`;
  if (!isRecord(value)) return invalid(`${label} must be an object`);
  if (!hasOnlyKeys(value, ["id", "title", "authors", "year", "abstract", "tags", "collections", "passages", "cites"])) {
    return invalid(`${label} contains unknown fields`);
  }

  const id = syntheticId(value["id"], `${label} id`);
  if (!id.ok) return id;
  const title = boundedString(value["title"], `${label} title`, MAX_SHORT_STRING_LENGTH);
  if (!title.ok) return title;
  const authors = boundedStringArray(value["authors"], `${label} authors`, 20);
  if (!authors.ok) return authors;
  if (authors.value.length === 0) return invalid(`${label} authors must not be empty`);
  const year = optionalYear(value["year"], label);
  if (!year.ok) return year;
  const abstract = optionalBoundedString(value["abstract"], `${label} abstract`, MAX_STRING_LENGTH);
  if (!abstract.ok) return abstract;
  const tags = boundedStringArray(value["tags"], `${label} tags`, 50);
  if (!tags.ok) return tags;
  const collections = boundedStringArray(value["collections"], `${label} collections`, 50);
  if (!collections.ok) return collections;

  const passagesValue = value["passages"];
  if (!Array.isArray(passagesValue) || passagesValue.length > MAX_PASSAGES_PER_PAPER) {
    return invalid(`${label} passages must be an array with at most ${String(MAX_PASSAGES_PER_PAPER)} entries`);
  }
  const passageIds = new Set<string>();
  const passages: SyntheticPassage[] = [];
  for (const [passageIndex, passageValue] of passagesValue.entries()) {
    const passage = parsePassage(passageValue, label, passageIndex);
    if (!passage.ok) return passage;
    if (passageIds.has(passage.passage.id)) return invalid(`${label} has duplicate passage id: ${passage.passage.id}`);
    passageIds.add(passage.passage.id);
    passages.push(passage.passage);
  }

  const cites = syntheticIdArray(value["cites"], `${label} cites`, MAX_CITATIONS_PER_PAPER);
  if (!cites.ok) return cites;

  return {
    ok: true,
    paper: {
      id: id.value,
      title: title.value,
      authors: authors.value,
      ...(year.value === undefined ? {} : { year: year.value }),
      ...(abstract.value === undefined ? {} : { abstract: abstract.value }),
      tags: tags.value,
      collections: collections.value,
      passages,
      cites: cites.value,
    },
  };
}

function parsePassage(value: unknown, paperLabel: string, index: number): { ok: true; passage: SyntheticPassage } | { ok: false; error: string } {
  const label = `${paperLabel} passage ${String(index + 1)}`;
  if (!isRecord(value)) return invalid(`${label} must be an object`);
  if (!hasOnlyKeys(value, ["id", "page", "quote", "question"])) return invalid(`${label} contains unknown fields`);

  const id = syntheticId(value["id"], `${label} id`);
  if (!id.ok) return id;
  const page = value["page"];
  if (!Number.isInteger(page) || typeof page !== "number" || page < 1 || page > 100_000) return invalid(`${label} page must be an integer from 1 to 100000`);
  const quote = boundedString(value["quote"], `${label} quote`, MAX_STRING_LENGTH);
  if (!quote.ok) return quote;
  const question = boundedString(value["question"], `${label} question`, MAX_STRING_LENGTH);
  if (!question.ok) return question;
  return { ok: true, passage: { id: id.value, page, quote: quote.value, question: question.value } };
}

function syntheticId(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !syntheticIdPattern.test(value)) return invalid(`${label} must match ${syntheticIdPattern.source}`);
  return { ok: true, value };
}

function syntheticIdArray(value: unknown, label: string, limit: number): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > limit) return invalid(`${label} must be an array with at most ${String(limit)} entries`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = syntheticId(item, `${label} entry`);
    if (!id.ok) return id;
    if (seen.has(id.value)) return invalid(`${label} contains duplicate id: ${id.value}`);
    seen.add(id.value);
    ids.push(id.value);
  }
  return { ok: true, value: ids };
}

function boundedStringArray(value: unknown, label: string, limit: number): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > limit) return invalid(`${label} must be an array with at most ${String(limit)} entries`);
  const strings: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = boundedString(item, `${label} entry`, MAX_SHORT_STRING_LENGTH);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value)) return invalid(`${label} contains a duplicate entry`);
    seen.add(parsed.value);
    strings.push(parsed.value);
  }
  return { ok: true, value: strings };
}

function boundedString(value: unknown, label: string, limit: number): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "" || value.length > limit) return invalid(`${label} must be a non-empty string of at most ${String(limit)} characters`);
  return { ok: true, value };
}

function optionalBoundedString(value: unknown, label: string, limit: number): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  return boundedString(value, label, limit);
}

function optionalYear(value: unknown, label: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1000 || value > 9999) return invalid(`${label} year must be a four-digit integer`);
  return { ok: true, value };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
