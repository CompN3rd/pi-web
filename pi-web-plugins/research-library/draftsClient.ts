import { RESEARCH_LIBRARY_RUNTIME_ROOT } from "./config.js";
import { sha256Hex, tokenIdFromDispatchToken } from "./researchLibraryClient.js";

export const RESEARCH_LIBRARY_DRAFT_VERSION = 1;
const DRAFTS_PATH = `${RESEARCH_LIBRARY_RUNTIME_ROOT}/drafts`;
const MAX_DRAFT_FILES = 100;
const MAX_DRAFT_BYTES = 32 * 1024;
const tokenIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const syntheticIdPattern = /^synthetic-[a-z][a-z0-9.-]{0,62}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export interface SyntheticAnswerDraft {
  version: typeof RESEARCH_LIBRARY_DRAFT_VERSION;
  synthetic: true;
  status: "draft";
  token: string;
  libraryId: string;
  paperId: string;
  passageId: string;
  question: string;
  answer: string;
  evidenceIds: string[];
  idempotencyKey: string;
  createdAt: string;
  contentSha256: string;
}

interface DraftsFileAccess {
  listFiles(path: string): Promise<{ entries: { name: string; path: string; type: "file" | "directory" | "symlink" }[]; truncated: boolean }>;
  readFile(path: string): Promise<{ content: string; size: number; truncated: boolean; binary: boolean }>;
}

export type SyntheticDraftsLoadResult =
  | { kind: "loaded"; drafts: SyntheticAnswerDraft[]; warnings: string[] }
  | { kind: "unavailable"; error: string };

export async function loadSyntheticAnswerDrafts(files: DraftsFileAccess, libraryId: string): Promise<SyntheticDraftsLoadResult> {
  let listing: Awaited<ReturnType<DraftsFileAccess["listFiles"]>>;
  try {
    listing = await files.listFiles(DRAFTS_PATH);
  } catch (error) {
    if (error instanceof Error && error.message === "Path does not exist") return { kind: "loaded", drafts: [], warnings: [] };
    return { kind: "unavailable", error: `Unable to list synthetic drafts: ${formatUnknownError(error)}` };
  }
  if (listing.truncated || listing.entries.length > MAX_DRAFT_FILES) return { kind: "unavailable", error: "Synthetic draft listing is too large or truncated" };

  const candidates = listing.entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".json") && tokenIdPattern.test(entry.name.slice(0, -5)))
    .sort((left, right) => left.name.localeCompare(right.name));
  const drafts: SyntheticAnswerDraft[] = [];
  const warnings: string[] = [];
  for (const entry of candidates) {
    try {
      const file = await files.readFile(entry.path);
      if (file.binary || file.truncated || file.size > MAX_DRAFT_BYTES) throw new Error("draft is binary, truncated, or oversized");
      const draft = await verifySyntheticAnswerDraft(JSON.parse(file.content), entry.name.slice(0, -5));
      if (draft.libraryId === libraryId) drafts.push(draft);
    } catch (error) {
      warnings.push(`${entry.name}: ${formatUnknownError(error)}`);
    }
  }
  drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.token.localeCompare(right.token));
  return { kind: "loaded", drafts, warnings };
}

export async function verifySyntheticAnswerDraft(value: unknown, expectedTokenId: string): Promise<SyntheticAnswerDraft> {
  const draft = parseSyntheticAnswerDraft(value);
  if (tokenIdFromDispatchToken(draft.token) !== expectedTokenId) throw new Error("Draft filename does not match its token");
  const stableContent = {
    token: draft.token,
    libraryId: draft.libraryId,
    paperId: draft.paperId,
    passageId: draft.passageId,
    question: draft.question,
    answer: draft.answer,
    evidenceIds: draft.evidenceIds,
    idempotencyKey: draft.idempotencyKey,
  };
  if (draft.contentSha256 !== await sha256Hex(JSON.stringify(stableContent))) throw new Error("Draft content digest mismatch");
  return draft;
}

function parseSyntheticAnswerDraft(value: unknown): SyntheticAnswerDraft {
  if (!isRecord(value)) throw new Error("Draft must be an object");
  const keys = ["version", "synthetic", "status", "token", "libraryId", "paperId", "passageId", "question", "answer", "evidenceIds", "idempotencyKey", "createdAt", "contentSha256"];
  if (!hasOnlyKeys(value, keys)) throw new Error("Draft contains unknown fields");
  if (value["version"] !== RESEARCH_LIBRARY_DRAFT_VERSION || value["synthetic"] !== true || value["status"] !== "draft") throw new Error("Draft version, synthetic marker, or status is invalid");
  const token = requireString(value, "token", 100);
  if (!/^research-library:v1:[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("Draft token is invalid");
  const libraryId = requireSyntheticId(value, "libraryId");
  const paperId = requireSyntheticId(value, "paperId");
  const passageId = requireSyntheticId(value, "passageId");
  const question = requireString(value, "question", 8_192);
  const answer = requireString(value, "answer", 8_192);
  const idempotencyKey = requireString(value, "idempotencyKey", 128);
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(idempotencyKey)) throw new Error("Draft idempotencyKey is invalid");
  const createdAt = requireString(value, "createdAt", 40);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Draft createdAt is invalid");
  const contentSha256 = requireString(value, "contentSha256", 64);
  if (!digestPattern.test(contentSha256)) throw new Error("Draft contentSha256 is invalid");
  const evidenceValue = value["evidenceIds"];
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 20) throw new Error("Draft evidenceIds are invalid");
  const evidenceIds: string[] = [];
  for (const item of evidenceValue) {
    if (typeof item !== "string" || item.trim() === "" || item.length > 200) throw new Error("Draft evidenceIds are invalid");
    evidenceIds.push(item);
  }
  const sortedEvidenceIds = [...evidenceIds].sort();
  if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some((item, index) => item !== sortedEvidenceIds[index])) {
    throw new Error("Draft evidenceIds must be unique and sorted");
  }
  return { version: RESEARCH_LIBRARY_DRAFT_VERSION, synthetic: true, status: "draft", token, libraryId, paperId, passageId, question, answer, evidenceIds, idempotencyKey, createdAt, contentSha256 };
}

function requireString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) throw new Error(`Draft ${key} is invalid`);
  return value;
}

function requireSyntheticId(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key, 72);
  if (!syntheticIdPattern.test(value)) throw new Error(`Draft ${key} is invalid`);
  return value;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
