import { createHash } from "node:crypto";
import {
  annotationDirectoryComponents,
  annotationFileName,
  annotationIdFromFileName,
  MAX_RESEARCH_LIBRARY_ANNOTATION_BYTES,
  MAX_RESEARCH_LIBRARY_ANNOTATIONS_PER_PAPER,
  parseResearchPilotAnnotationText,
  type ResearchPilotAnnotation,
  type ResearchPilotAnnotationKind,
  type ResearchPilotAnnotationStatus,
} from "./pilotAnnotation.js";
import {
  MAX_RESEARCH_LIBRARY_PILOT_BYTES,
  parseLocalPilotConfigText,
  pilotPaperById,
  RESEARCH_LIBRARY_PILOT_CONFIG_PATH,
  type LocalPilotPaper,
  type LocalResearchLibraryPilotConfig,
} from "./pilotModel.js";
import { listRegularJsonFileNames, readWorkspaceRegularText } from "./storage.js";

export const MAX_RESEARCH_LIBRARY_PAPER_RESULTS = 20;
export const MAX_RESEARCH_LIBRARY_ANNOTATION_RESULTS = 20;
export const MAX_RESEARCH_LIBRARY_TOOL_CHARACTERS = 24_000;
export const MAX_RESEARCH_LIBRARY_ANNOTATION_PREVIEW_CHARACTERS = 1_000;

const PILOT_CONFIG_COMPONENTS = RESEARCH_LIBRARY_PILOT_CONFIG_PATH.split("/");
const PILOT_ANNOTATION_MAX_FILES = MAX_RESEARCH_LIBRARY_ANNOTATIONS_PER_PAPER;
const PILOT_ID_PATTERN = /^pilot-[a-z][a-z0-9.-]{0,62}$/u;
const ANNOTATION_ID_PATTERN = /^ann-[a-f0-9]{32}$/u;

export interface LoadedLocalPilotLibrary {
  config: LocalResearchLibraryPilotConfig;
  manifestSha256: string;
}

export interface LocalPilotPaperView {
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
  pdf: {
    path: string;
    sha256: string;
    size: number;
    sourceUrl: string;
    sourcePageUrl: string;
    retrievedAt: string;
    rights: string;
  };
}

export interface LocalPilotPaperListItem extends LocalPilotPaperView {
  annotationCount: number;
  openAnnotationCount: number;
}

export interface LocalPilotAnnotationSummary {
  id: string;
  paperId: string;
  bibkey: string;
  title: string;
  page: number;
  rect: ResearchPilotAnnotation["rect"];
  kind: ResearchPilotAnnotationKind;
  status: ResearchPilotAnnotationStatus;
  quote: string;
  quoteTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface LocalPilotAnnotationContext {
  libraryId: string;
  paper: LocalPilotPaperView;
  annotation: ResearchPilotAnnotation;
}

export interface LocalPilotWarnings {
  warnings: string[];
}

export interface LocalPilotPaperListResponse extends LocalPilotWarnings {
  libraryId: string;
  manifestSha256: string;
  papers: LocalPilotPaperListItem[];
  matchedPaperCount: number;
  returnedPaperCount: number;
  truncated: boolean;
}

export interface LocalPilotAnnotationListResponse extends LocalPilotWarnings {
  libraryId: string;
  annotations: LocalPilotAnnotationSummary[];
  matchedAnnotationCount: number;
  returnedAnnotationCount: number;
  truncated: boolean;
}

export async function pilotLibraryIsAvailable(cwd: string): Promise<boolean> {
  try {
    await loadLocalPilotLibrary(cwd);
    return true;
  } catch {
    return false;
  }
}

export async function loadLocalPilotLibrary(cwd: string): Promise<LoadedLocalPilotLibrary> {
  const text = await readWorkspaceRegularText(cwd, PILOT_CONFIG_COMPONENTS, MAX_RESEARCH_LIBRARY_PILOT_BYTES);
  const parsed = parseLocalPilotConfigText(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { config: parsed.config, manifestSha256: sha256Hex(text) };
}

export async function listLocalPilotPapers(
  cwd: string,
  options: { query?: string; limit?: number } = {},
): Promise<LocalPilotPaperListResponse> {
  const library = await loadLocalPilotLibrary(cwd);
  const query = normalizeOptionalQuery(options.query);
  const limit = boundedLimit(options.limit, MAX_RESEARCH_LIBRARY_PAPER_RESULTS, "paper");
  const matching = library.config.papers.filter((paper) => query === undefined || searchablePaper(paper).includes(query));
  const warnings: string[] = [];
  const papers: LocalPilotPaperListItem[] = [];
  for (const paper of matching.slice(0, limit)) {
    const loaded = await loadPaperAnnotations(cwd, library.config, paper);
    warnings.push(...loaded.warnings);
    papers.push({
      ...paperView(paper),
      annotationCount: loaded.annotations.length,
      openAnnotationCount: loaded.annotations.filter((annotation) => annotation.status === "open").length,
    });
  }
  return {
    libraryId: library.config.libraryId,
    manifestSha256: library.manifestSha256,
    papers,
    matchedPaperCount: matching.length,
    returnedPaperCount: papers.length,
    truncated: matching.length > papers.length,
    warnings: boundedWarnings(warnings),
  };
}

export async function listLocalPilotAnnotations(
  cwd: string,
  options: { paperId?: string; kind?: ResearchPilotAnnotationKind; status?: ResearchPilotAnnotationStatus; limit?: number } = {},
): Promise<LocalPilotAnnotationListResponse> {
  const library = await loadLocalPilotLibrary(cwd);
  const limit = boundedLimit(options.limit, MAX_RESEARCH_LIBRARY_ANNOTATION_RESULTS, "annotation");
  const papers = options.paperId === undefined
    ? library.config.papers
    : [requirePilotPaper(library.config, options.paperId)];
  const warnings: string[] = [];
  const matches: { paper: LocalPilotPaper; annotation: ResearchPilotAnnotation }[] = [];
  for (const paper of papers) {
    const loaded = await loadPaperAnnotations(cwd, library.config, paper);
    warnings.push(...loaded.warnings);
    for (const annotation of loaded.annotations) {
      if (options.kind !== undefined && annotation.kind !== options.kind) continue;
      if (options.status !== undefined && annotation.status !== options.status) continue;
      matches.push({ paper, annotation });
    }
  }
  matches.sort(compareAnnotations);
  const selected = matches.slice(0, limit);
  const annotations = selected.map(({ paper, annotation }) => annotationSummary(paper, annotation));
  return {
    libraryId: library.config.libraryId,
    annotations,
    matchedAnnotationCount: matches.length,
    returnedAnnotationCount: annotations.length,
    truncated: matches.length > annotations.length,
    warnings: boundedWarnings(warnings),
  };
}

export async function getLocalPilotAnnotation(cwd: string, paperId: string, annotationId: string): Promise<LocalPilotAnnotationContext> {
  if (!PILOT_ID_PATTERN.test(paperId)) throw new Error("Pilot paperId is invalid");
  if (!ANNOTATION_ID_PATTERN.test(annotationId)) throw new Error("Pilot annotation id is invalid");
  const library = await loadLocalPilotLibrary(cwd);
  const paper = requirePilotPaper(library.config, paperId);
  const components = annotationDirectoryComponents(paper.id);
  const fileName = annotationFileName(annotationId);
  const names = await listRegularJsonFileNames(cwd, components, PILOT_ANNOTATION_MAX_FILES);
  if (!names.includes(fileName)) throw new Error("Pilot annotation does not exist");
  const annotation = await readAnnotation(cwd, components, fileName, library.config, paper);
  return { libraryId: library.config.libraryId, paper: paperView(paper), annotation };
}

async function loadPaperAnnotations(
  cwd: string,
  config: LocalResearchLibraryPilotConfig,
  paper: LocalPilotPaper,
): Promise<{ annotations: ResearchPilotAnnotation[]; warnings: string[] }> {
  const components = annotationDirectoryComponents(paper.id);
  let names: string[];
  try {
    names = await listRegularJsonFileNames(cwd, components, PILOT_ANNOTATION_MAX_FILES);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { annotations: [], warnings: [] };
    throw error;
  }

  const annotations: ResearchPilotAnnotation[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const id = annotationIdFromFileName(name);
    if (id === undefined) {
      warnings.push(`${paper.id}/${name}: invalid annotation filename`);
      continue;
    }
    try {
      annotations.push(await readAnnotation(cwd, components, name, config, paper));
    } catch (error) {
      warnings.push(`${paper.id}/${name}: ${formatUnknownError(error)}`);
    }
  }
  annotations.sort(compareAnnotationRecords);
  return { annotations, warnings };
}

async function readAnnotation(
  cwd: string,
  components: readonly string[],
  fileName: string,
  config: LocalResearchLibraryPilotConfig,
  paper: LocalPilotPaper,
): Promise<ResearchPilotAnnotation> {
  const text = await readWorkspaceRegularText(cwd, [...components, fileName], MAX_RESEARCH_LIBRARY_ANNOTATION_BYTES);
  const id = annotationIdFromFileName(fileName);
  if (id === undefined) throw new Error("annotation filename is invalid");
  const annotation = parseResearchPilotAnnotationText(text, id);
  if (annotation.libraryId !== config.libraryId) throw new Error("annotation belongs to a different library");
  if (annotation.paperId !== paper.id) throw new Error("annotation is stored under a different paper");
  if (annotation.pdfSha256 !== paper.pdf.sha256) throw new Error("annotation is bound to a different PDF revision");
  return annotation;
}

function requirePilotPaper(config: LocalResearchLibraryPilotConfig, paperId: string): LocalPilotPaper {
  if (!PILOT_ID_PATTERN.test(paperId)) throw new Error("Pilot paperId is invalid");
  const paper = pilotPaperById(config, paperId);
  if (paper === undefined) throw new Error(`Pilot paper does not exist: ${paperId}`);
  return paper;
}

function paperView(paper: LocalPilotPaper): LocalPilotPaperView {
  return {
    id: paper.id,
    bibkey: paper.bibkey,
    title: paper.title,
    authors: paper.authors,
    ...(paper.year === undefined ? {} : { year: paper.year }),
    ...(paper.abstract === undefined ? {} : { abstract: paper.abstract }),
    sourceNotePath: paper.sourceNotePath,
    sourceNoteSha256: paper.sourceNoteSha256,
    relatedTopics: paper.relatedTopics,
    metaCategories: paper.metaCategories,
    usedBy: paper.usedBy,
    pdf: {
      path: paper.pdf.path,
      sha256: paper.pdf.sha256,
      size: paper.pdf.size,
      sourceUrl: paper.pdf.sourceUrl,
      sourcePageUrl: paper.pdf.sourcePageUrl,
      retrievedAt: paper.pdf.retrievedAt,
      rights: paper.pdf.rights,
    },
  };
}

function annotationSummary(paper: LocalPilotPaper, annotation: ResearchPilotAnnotation): LocalPilotAnnotationSummary {
  const quote = preview(annotation.quote);
  const body = preview(annotation.body);
  return {
    id: annotation.id,
    paperId: paper.id,
    bibkey: paper.bibkey,
    title: paper.title,
    page: annotation.page,
    rect: annotation.rect,
    kind: annotation.kind,
    status: annotation.status,
    quote: quote.value,
    quoteTruncated: quote.truncated,
    body: body.value,
    bodyTruncated: body.truncated,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    revision: annotation.revision,
  };
}

function searchablePaper(paper: LocalPilotPaper): string {
  return [paper.id, paper.bibkey, paper.title, ...paper.authors, paper.abstract ?? "", paper.sourceNotePath, ...paper.relatedTopics, ...paper.metaCategories, ...paper.usedBy].join("\n").toLowerCase();
}

function normalizeOptionalQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.length > 200) throw new Error("Pilot paper query must contain 1-200 characters");
  return normalized;
}

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error(`Pilot ${label} limit must be an integer from 1 to ${String(maximum)}`);
  return limit;
}

function compareAnnotations(left: { paper: LocalPilotPaper; annotation: ResearchPilotAnnotation }, right: { paper: LocalPilotPaper; annotation: ResearchPilotAnnotation }): number {
  return left.annotation.page - right.annotation.page
    || left.paper.id.localeCompare(right.paper.id)
    || left.annotation.rect.y - right.annotation.rect.y
    || left.annotation.rect.x - right.annotation.rect.x
    || left.annotation.id.localeCompare(right.annotation.id);
}

function compareAnnotationRecords(left: ResearchPilotAnnotation, right: ResearchPilotAnnotation): number {
  return left.page - right.page || left.rect.y - right.rect.y || left.rect.x - right.rect.x || left.id.localeCompare(right.id);
}

function preview(value: string): { value: string; truncated: boolean } {
  if (value.length <= MAX_RESEARCH_LIBRARY_ANNOTATION_PREVIEW_CHARACTERS) return { value, truncated: false };
  return { value: `${value.slice(0, MAX_RESEARCH_LIBRARY_ANNOTATION_PREVIEW_CHARACTERS)}…`, truncated: true };
}

function boundedWarnings(warnings: string[]): string[] {
  return warnings.slice(0, 100);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
