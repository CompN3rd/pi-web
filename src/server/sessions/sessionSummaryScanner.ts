import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PiSessionListEntry } from "./piSessionService.js";

/**
 * Fast-path classification prefix of a session file line, as raw bytes.
 *
 * The Pi SDK writes every entry with `type` as the first JSON key, so the
 * entry type can normally be read directly from the line's first bytes without
 * decoding or parsing it. This is what lets a listing skip the (potentially
 * huge) message bodies entirely: only lines whose type actually matters for
 * the summary are ever decoded to strings and JSON-parsed.
 */
const ENTRY_TYPE_PREFIX = Buffer.from('{"type":"');
const TYPE_QUOTE = 0x22; // `"`
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const CLOSING_BRACE = 0x7d; // `}`

/** Same bound the SDK uses for its concurrent session-info builds. */
const MAX_CONCURRENT_SESSION_SUMMARY_SCANS = 10;

/** Read chunk size for the streaming pass. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Types longer than this fall back to a full parse instead of byte classification. */
const MAX_CLASSIFIED_TYPE_LENGTH = 64;

/**
 * List the sessions in one session directory with one lightweight streaming
 * pass per file, instead of the SDK's full-transcript listing.
 *
 * Stateless: every call re-reads every file. Daemon listings should use
 * {@link SessionSummaryScanner}, which memoizes these summaries across calls.
 *
 * The summary fields mirror the SDK listing (`SessionManager.listAll`):
 * `messageCount` counts every `message` entry, `firstMessage` is the first
 * user message with non-empty text content, `name` is the latest `session_info`
 * name (an empty or missing name clears it), and `created`/`id`/`cwd`/
 * `parentSessionPath` come from the header line. Two deliberate differences:
 *
 * - `modified` is the file mtime rather than the last message timestamp.
 *   Session files are append-only, so the mtime is a faithful "last activity"
 *   for listing order, the only thing `modified` is used for.
 * - `allMessagesText` is always empty. Building it required parsing every
 *   message body — the cost this scanner exists to remove — and PI WEB never
 *   consumes it.
 *
 * Files whose header is missing, unreadable, or not a session header are
 * skipped, like the SDK does. Results are sorted by `modified` descending.
 */
export async function scanSessionSummariesInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  const files = await listSessionFilesInDir(sessionDir);
  const summaries = await scanSessionFilesWithBoundedConcurrency(files, scanSessionFileSummary);
  return sortedSessionSummaries(summaries);
}

/**
 * Summarize one session file in a single streaming pass.
 *
 * Per-line work is minimal: lines are classified from their leading
 * `{"type":"..."` bytes without ever decoding them, and lines are only turned
 * into strings and JSON-parsed when they matter — the header, `session_info`
 * lines (rare, one per rename), and message lines until the first user text
 * message has been found. Message bodies after that point (which hold the huge
 * tool results and assistant replies) are neither decoded nor parsed.
 *
 * Returns undefined when the file is not a usable session (unreadable, empty,
 * or first parseable entry is not a session header), matching the SDK.
 */
export async function scanSessionFileSummary(filePath: string, chunkBuffer?: Buffer): Promise<PiSessionListEntry | undefined> {
  const fold = createEmptyFold();
  const outcome = await foldSessionFileRange(filePath, fold, 0, chunkBuffer ?? Buffer.allocUnsafe(SCAN_CHUNK_BYTES));
  if (outcome === undefined) return undefined;
  return buildSummaryFromFold(fold, filePath, outcome.mtime);
}

/**
 * Session summary scanner with a per-file memo, so repeated listings of the
 * same session directory do not re-read transcripts that did not change.
 *
 * The memo is a last resort on top of the lightweight streaming scan and is
 * deliberately trivial to invalidate — it never holds anything the file
 * itself cannot re-derive:
 *
 * - Key: absolute file path. Trusted value: file identity (dev/ino) plus the
 *   size already parsed.
 * - Identity and size unchanged → cached summary. The mtime is re-read from
 *   the same stat, so `modified` stays faithful even on a cache hit.
 * - Identity unchanged and the file grew → session files are append-only, so
 *   only the appended tail is read and folded into the cached summary state.
 *   A trailing line that was still being written when it was cached is
 *   re-folded from its start, so completed lines are never counted twice.
 * - Identity changed or the file shrunk → cached state is dropped and the
 *   file is fully re-parsed.
 * - File gone (ENOENT) → its entry is dropped; entries for files that no
 *   longer appear in the directory listing are pruned on each scan.
 * - {@link clear} drops every entry. There are no TTLs and nothing is
 *   persisted: the memo is an in-process speedup, and a daemon restart starts
 *   cold but correct.
 *
 * The one thing the key cannot detect is an in-place rewrite that keeps the
 * inode and never shrinks the file. The SDK never rewrites session files, but
 * PI WEB's detach does (it clears the header), so callers that rewrite a file
 * in place must call {@link invalidate} for it; {@link clear} remains the
 * escape hatch for unknown external rewrites.
 */
export class SessionSummaryScanner {
  private readonly memo = new Map<string, MemoizedSessionSummary>();

  /** Drop every cached summary, forcing full re-parses on the next listing. */
  clear(): void {
    this.memo.clear();
  }

  /**
   * Drop the cached summary for one file, forcing a full re-parse of it on
   * the next listing. Callers that rewrite a session file in place (keeping
   * the inode) must invalidate it, since identity + size checks cannot detect
   * such rewrites. Dropping a path that is not memoized is a no-op.
   */
  invalidate(filePath: string): void {
    this.memo.delete(filePath);
  }

  /**
   * The memoized equivalent of {@link scanSessionSummariesInDir}: same fields,
   * same order, same skip rules, but files that have not changed since the
   * previous scan of their directory are answered from the memo (one stat
   * each), and grown files only parse their appended tail.
   */
  async scanSessionSummariesInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
    const files = await listSessionFilesInDir(sessionDir);
    this.pruneEntriesRemovedFrom(sessionDir, files);
    const summaries = await scanSessionFilesWithBoundedConcurrency(files, (file, chunkBuffer) => this.scanFileWithMemo(file, chunkBuffer));
    return sortedSessionSummaries(summaries);
  }

  private pruneEntriesRemovedFrom(sessionDir: string, existingFiles: readonly string[]): void {
    const dirPrefix = sessionDir.endsWith(sep) ? sessionDir : sessionDir + sep;
    const existing = new Set(existingFiles);
    for (const path of this.memo.keys()) {
      // Deletion invalidates automatically: entries for the scanned directory
      // whose file no longer exists are dropped, keeping the memo bounded.
      if (path.startsWith(dirPrefix) && !existing.has(path)) this.memo.delete(path);
    }
  }

  private async scanFileWithMemo(filePath: string, chunkBuffer: Buffer): Promise<PiSessionListEntry | undefined> {
    const memoized = this.memo.get(filePath);
    if (memoized === undefined) return this.fullScan(filePath, chunkBuffer);

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(filePath);
    } catch {
      // Went away between readdir and stat: drop it and skip, like the SDK.
      this.memo.delete(filePath);
      return undefined;
    }

    if (stats.dev !== memoized.dev || stats.ino !== memoized.ino || stats.size < memoized.size) {
      // Replaced or shrunk: the cached prefix is no longer trustworthy.
      return this.fullScan(filePath, chunkBuffer);
    }
    if (stats.size === memoized.size) {
      return buildSummaryFromFold(memoized.completeFold, filePath, stats.mtime);
    }

    // Growth on the same identity: append-only session files can only have
    // gained a tail, so fold just the new bytes into the cached state.
    const fold = { ...memoized.resumeFold };
    const outcome = await foldSessionFileRange(filePath, fold, memoized.resumeOffset, chunkBuffer);
    if (outcome === undefined) {
      // Became unreadable mid-scan: skip it (like the SDK) and forget it.
      this.memo.delete(filePath);
      return undefined;
    }
    this.memo.set(filePath, {
      dev: outcome.dev,
      ino: outcome.ino,
      size: outcome.size,
      resumeOffset: outcome.resumeOffset,
      resumeFold: outcome.resumeFold,
      completeFold: fold,
    });
    return buildSummaryFromFold(fold, filePath, outcome.mtime);
  }

  private async fullScan(filePath: string, chunkBuffer: Buffer): Promise<PiSessionListEntry | undefined> {
    const fold = createEmptyFold();
    const outcome = await foldSessionFileRange(filePath, fold, 0, chunkBuffer);
    if (outcome === undefined) {
      this.memo.delete(filePath);
      return undefined;
    }
    this.memo.set(filePath, {
      dev: outcome.dev,
      ino: outcome.ino,
      size: outcome.size,
      resumeOffset: outcome.resumeOffset,
      resumeFold: outcome.resumeFold,
      completeFold: fold,
    });
    return buildSummaryFromFold(fold, filePath, outcome.mtime);
  }
}

/** One memoized file: its identity, how far it was parsed, and the summary state. */
interface MemoizedSessionSummary {
  dev: number;
  ino: number;
  /** Observed end-of-file offset when the fold below was completed. */
  size: number;
  /** First byte not covered by `resumeFold`; always a line boundary. */
  resumeOffset: number;
  /** Summary state folded up to `resumeOffset` (safe tail-parse start). */
  resumeFold: SummaryFoldState;
  /** Summary state for the whole file, including any unterminated trailing line. */
  completeFold: SummaryFoldState;
}

/** The summary-relevant state accumulated while folding a file's lines. */
interface SummaryFoldState {
  header: Record<string, unknown> | undefined;
  rejected: boolean;
  messageCount: number;
  firstMessageText: string | undefined;
  name: string | undefined;
}

function createEmptyFold(): SummaryFoldState {
  return { header: undefined, rejected: false, messageCount: 0, firstMessageText: undefined, name: undefined };
}

/** Identity and resume bookkeeping from one folded range of a session file. */
interface RangeFoldOutcome {
  dev: number;
  ino: number;
  /** Observed end-of-file offset after the read. */
  size: number;
  mtime: Date;
  /** First byte not covered by `resumeFold`; always a line boundary. */
  resumeOffset: number;
  /** Fold state excluding any unterminated trailing line. */
  resumeFold: SummaryFoldState;
}

/**
 * Fold the lines of `filePath` from `startOffset` to end-of-file into `fold`.
 *
 * On return, `fold` holds the state for the whole range including any
 * unterminated trailing line, while the returned `resumeFold`/`resumeOffset`
 * describe the range up to the last safe line boundary — the starting point
 * for an incremental tail parse once the file grows.
 *
 * Returns undefined when the file cannot be stat'ed, opened, or read
 * (missing, unreadable, or vanished mid-scan).
 */
async function foldSessionFileRange(filePath: string, fold: SummaryFoldState, startOffset: number, chunkBuffer: Buffer): Promise<RangeFoldOutcome | undefined> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    return undefined;
  }

  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
  } catch {
    return undefined;
  }

  try {
    const outcome = await foldFileLines(file, fold, startOffset, chunkBuffer);
    return { dev: stats.dev, ino: stats.ino, size: outcome.endOffset, mtime: stats.mtime, resumeOffset: outcome.resumeOffset, resumeFold: outcome.resumeFold };
  } catch {
    // One unreadable/corrupt file must not break the listing; the SDK skips
    // such files too.
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** The streaming line fold over an open file range; see foldSessionFileRange. */
async function foldFileLines(file: FileHandle, fold: SummaryFoldState, startOffset: number, chunkBuffer: Buffer): Promise<{ resumeOffset: number; endOffset: number; resumeFold: SummaryFoldState }> {
  let position = startOffset;
  let pendingChunks: Buffer[] = [];
  let pendingLineStart = startOffset;
  for (;;) {
    const { bytesRead } = await file.read(chunkBuffer, 0, chunkBuffer.length, position);
    const reachedEnd = bytesRead === 0;
    const data = chunkBuffer.subarray(0, bytesRead);
    let lineStart = 0;
    let newlineAt = data.indexOf(NEWLINE);
    while (newlineAt !== -1) {
      if (pendingChunks.length > 0) {
        // A line longer than one chunk: join the saved pieces and finish it.
        pendingChunks.push(Buffer.from(data.subarray(lineStart, newlineAt)));
        const whole = Buffer.concat(pendingChunks);
        pendingChunks = [];
        processLineBytes(whole, 0, whole.length, fold);
      } else {
        processLineBytes(data, lineStart, newlineAt, fold);
      }
      if (fold.rejected) break;
      lineStart = newlineAt + 1;
      newlineAt = data.indexOf(NEWLINE, lineStart);
    }
    if (fold.rejected) {
      const endOffset = position + data.length;
      return { resumeOffset: endOffset, endOffset, resumeFold: fold };
    }
    if (reachedEnd) {
      const endOffset = position + data.length;
      if (pendingChunks.length === 0 && lineStart >= data.length) {
        return { resumeOffset: endOffset, endOffset, resumeFold: fold };
      }
      // Final line without a trailing newline (foreign writers, or a line
      // still being written when we read): fold it for this listing's result,
      // but keep an un-folded copy and the line's start offset — appended
      // bytes may complete this line, and it must then be re-folded whole.
      const resumeOffset = pendingChunks.length > 0 ? pendingLineStart : position + lineStart;
      const resumeFold = { ...fold };
      if (pendingChunks.length > 0) {
        pendingChunks.push(Buffer.from(data.subarray(lineStart)));
        const whole = Buffer.concat(pendingChunks);
        processLineBytes(whole, 0, whole.length, fold);
      } else {
        processLineBytes(data, lineStart, data.length, fold);
      }
      return { resumeOffset, endOffset, resumeFold };
    }
    if (lineStart < data.length) {
      if (pendingChunks.length === 0) pendingLineStart = position + lineStart;
      pendingChunks.push(Buffer.from(data.subarray(lineStart)));
    }
    position += bytesRead;
  }
}

/** The listing entry for a fold, or undefined when the file is not a usable session. */
function buildSummaryFromFold(fold: SummaryFoldState, filePath: string, mtime: Date): PiSessionListEntry | undefined {
  if (fold.rejected || fold.header === undefined) return undefined;
  const id = fold.header["id"];
  // The SDK would list a header without a usable id; downstream lookups then
  // call `.startsWith` on it and crash. Skip such files instead.
  if (typeof id !== "string" || id === "") return undefined;

  const headerCwd = fold.header["cwd"];
  const parentSessionPath = fold.header["parentSession"];
  const headerTimestamp = fold.header["timestamp"];
  return {
    path: filePath,
    id,
    cwd: typeof headerCwd === "string" ? headerCwd : "",
    created: typeof headerTimestamp === "string" || typeof headerTimestamp === "number" ? new Date(headerTimestamp) : new Date(Number.NaN),
    modified: mtime,
    messageCount: fold.messageCount,
    firstMessage: fold.firstMessageText ?? "(no messages)",
    // Never built: see the directory-level doc comment. Kept because SDK-built
    // entries (cleanup listing) still carry the field.
    allMessagesText: "",
    ...(fold.name === undefined ? {} : { name: fold.name }),
    ...(typeof parentSessionPath === "string" ? { parentSessionPath } : {}),
  };
}

/** Classify and fold one line, addressed as bytes inside `data`. */
function processLineBytes(data: Buffer, start: number, end: number, state: SummaryFoldState): void {
  // Readline parity: a CRLF file yields lines without their trailing `\r`.
  if (end > start && data[end - 1] === CARRIAGE_RETURN) end -= 1;

  if (state.header === undefined) {
    const outcome = classifyPreHeaderLine(data.toString("utf8", start, end));
    if (outcome === "skip") return;
    if (outcome === "reject") {
      state.rejected = true;
      return;
    }
    state.header = outcome;
    return;
  }

  const entryType = classifyLineType(data, start, end);
  if (entryType === "session_info") {
    const entry = tryParseEntry(data.toString("utf8", start, end));
    if (entry !== undefined) state.name = sessionInfoName(entry);
    return;
  }
  if (entryType === "message") {
    // A line still being written can be complete JSON only if it ends with
    // `}`; treating anything else as malformed matches the SDK, which skips
    // unparseable lines.
    if (end === start || data[end - 1] !== CLOSING_BRACE) return;
    state.messageCount += 1;
    // The expensive part of a listing was parsing message bodies; decode and
    // parse only until the first user text message is known.
    if (state.firstMessageText !== undefined) return;
    const entry = tryParseEntry(data.toString("utf8", start, end));
    if (entry !== undefined) {
      const userText = firstUserMessageText(entry);
      if (userText !== undefined) state.firstMessageText = userText;
    }
    return;
  }
  if (entryType !== undefined) return;

  // Lines that do not start with the SDK-style `{"type":"..."}` prefix
  // (foreign writers, garbage) fall back to a parse so they are classified
  // exactly like the SDK would.
  const entry = tryParseEntry(data.toString("utf8", start, end));
  if (entry === undefined) return;
  if (entry["type"] === "session_info") state.name = sessionInfoName(entry);
  else if (entry["type"] === "message") {
    state.messageCount += 1;
    if (state.firstMessageText === undefined) {
      const userText = firstUserMessageText(entry);
      if (userText !== undefined) state.firstMessageText = userText;
    }
  }
}

/**
 * The entry type from a line's leading bytes, without decoding it. Returns
 * undefined when the line does not carry the SDK-style prefix (or the type is
 * unreasonably long), leaving classification to the parse fallback.
 */
function classifyLineType(data: Buffer, start: number, end: number): string | undefined {
  const prefixLength = ENTRY_TYPE_PREFIX.length;
  if (end - start < prefixLength + 1) return undefined;
  for (let i = 0; i < prefixLength; i += 1) {
    if (data[start + i] !== ENTRY_TYPE_PREFIX[i]) return undefined;
  }
  const searchLimit = Math.min(end, start + prefixLength + MAX_CLASSIFIED_TYPE_LENGTH);
  const closeAt = data.indexOf(TYPE_QUOTE, start + prefixLength);
  if (closeAt === -1 || closeAt > searchLimit) return undefined;
  // Entry types are ASCII identifiers; ASCII decoding never fabricates a
  // match for a non-ASCII byte.
  return data.toString("ascii", start + prefixLength, closeAt);
}

/**
 * First parseable entry of a session file must be its session header —
 * exactly the SDK's rule: unparseable lines are skipped until one parses, and
 * a parseable non-session entry disqualifies the file.
 */
function classifyPreHeaderLine(line: string): Record<string, unknown> | "skip" | "reject" {
  const entry = tryParseEntry(line);
  if (entry === undefined) return "skip";
  if (entry["type"] !== "session") return "reject";
  return entry;
}

/** The SDK's name rule: latest `session_info` wins, and empty/missing names clear. */
function sessionInfoName(entry: Record<string, unknown>): string | undefined {
  const value = entry["name"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The first user message with non-empty text content, mirroring the SDK's
 * `firstMessage` extraction (role/content shape checks and text-block join).
 */
function firstUserMessageText(entry: Record<string, unknown>): string | undefined {
  const message = entry["message"];
  if (!isRecord(message)) return undefined;
  if (message["role"] !== "user" || !("content" in message)) return undefined;
  const text = extractTextContent(message["content"]);
  return text === "" ? undefined : text;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string") texts.push(text);
  }
  return texts.join(" ");
}

function tryParseEntry(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function listSessionFilesInDir(sessionDir: string): Promise<string[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(sessionDir);
  } catch {
    // Matches the SDK listing behavior: an unreadable directory lists nothing.
    return [];
  }
  return fileNames.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
}

function sortedSessionSummaries(summaries: readonly (PiSessionListEntry | undefined)[]): PiSessionListEntry[] {
  const sessions = summaries.filter((summary): summary is PiSessionListEntry => summary !== undefined);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

async function scanSessionFilesWithBoundedConcurrency(
  files: readonly string[],
  scan: (file: string, chunkBuffer: Buffer) => Promise<PiSessionListEntry | undefined>,
): Promise<(PiSessionListEntry | undefined)[]> {
  const results: (PiSessionListEntry | undefined)[] = Array.from({ length: files.length }, () => undefined);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_CONCURRENT_SESSION_SUMMARY_SCANS, files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    // One reusable read buffer per worker instead of one per file: large
    // per-file allocations churn the heap on directories with many sessions.
    const chunkBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    for (;;) {
      const index = nextIndex++;
      const file = files[index];
      if (file === undefined) return;
      results[index] = await scan(file, chunkBuffer).catch(() => undefined);
    }
  });
  await Promise.all(workers);
  return results;
}
