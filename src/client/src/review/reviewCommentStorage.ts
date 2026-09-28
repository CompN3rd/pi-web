import type { ReviewComment } from "./reviewTypes";

const storagePrefix = "pi-web:review-comments:";
const STORAGE_VERSION = 1;

function storageKey(sessionKey: string): string {
  return `${storagePrefix}${sessionKey}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseComment(value: unknown): ReviewComment[] {
  if (!isRecord(value)) return [];
  const id = value["id"];
  const body = value["body"];
  const sourceHash = value["sourceHash"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  const anchor = value["anchor"];
  if (typeof id !== "string" || typeof body !== "string" || typeof sourceHash !== "string") return [];
  if (typeof createdAt !== "number" || typeof updatedAt !== "number") return [];
  if (!isRecord(anchor)) return [];
  const filePath = anchor["filePath"];
  const range = anchor["range"];
  const source = anchor["source"];
  if (typeof filePath !== "string" || !isRecord(range)) return [];
  const side = range["side"];
  const start = range["start"];
  const end = range["end"];
  if (side !== "new" && side !== "old") return [];
  if (typeof start !== "number" || typeof end !== "number") return [];
  return [{
    id,
    body,
    sourceHash,
    createdAt,
    updatedAt,
    anchor: { filePath, range: { side, start, end }, ...(source === "files" || source === "git-staged" || source === "git-unstaged" ? { source } : {}) },
  }];
}

/** Repair older stores with duplicate IDs without dropping either comment. */
function uniqueCommentIds(comments: ReviewComment[]): ReviewComment[] {
  const reserved = new Set(comments.map((comment) => comment.id));
  const seen = new Set<string>();
  return comments.map((comment) => {
    let id = comment.id;
    let suffix = 1;
    while (seen.has(id)) {
      id = `${comment.id}-duplicate-${String(suffix++)}`;
      while (reserved.has(id)) id = `${comment.id}-duplicate-${String(suffix++)}`;
    }
    seen.add(id);
    return id === comment.id ? comment : { ...comment, id };
  });
}

export function loadComments(sessionKey: string, storage = browserStorage()): ReviewComment[] {
  try {
    const raw = storage?.getItem(storageKey(sessionKey));
    if (raw === null || raw === undefined || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== STORAGE_VERSION || !Array.isArray(parsed["comments"])) return [];
    return uniqueCommentIds(parsed["comments"].flatMap((candidate) => parseComment(candidate)));
  } catch {
    return [];
  }
}

export function saveComments(sessionKey: string, comments: readonly ReviewComment[], storage = browserStorage()): void {
  try {
    if (comments.length === 0) {
      storage?.removeItem(storageKey(sessionKey));
      return;
    }
    storage?.setItem(storageKey(sessionKey), JSON.stringify({ version: STORAGE_VERSION, comments: [...comments] }));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function clearComments(sessionKey: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(storageKey(sessionKey));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function moveComments(fromSessionKey: string, toSessionKey: string, storage = browserStorage()): void {
  if (fromSessionKey === toSessionKey) return;
  const comments = loadComments(fromSessionKey, storage);
  if (comments.length === 0) return;
  const merged = uniqueCommentIds([...comments, ...loadComments(toSessionKey, storage)]);
  // Unlike best-effort edits, migration must confirm the write before retiring its owner.
  try {
    storage?.setItem(storageKey(toSessionKey), JSON.stringify({ version: STORAGE_VERSION, comments: merged }));
  } catch (cause) {
    throw new Error("Could not move review comments to the replacement session; original feedback was retained.", { cause });
  }
  clearComments(fromSessionKey, storage);
}
