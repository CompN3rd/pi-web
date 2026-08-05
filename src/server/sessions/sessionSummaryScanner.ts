import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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
  let fileNames: string[];
  try {
    fileNames = await readdir(sessionDir);
  } catch {
    // Matches the SDK listing behavior: an unreadable directory lists nothing.
    return [];
  }
  const files = fileNames.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
  const summaries = await scanSessionFilesWithBoundedConcurrency(files, scanSessionFileSummary);
  const sessions = summaries.filter((summary): summary is PiSessionListEntry => summary !== undefined);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

interface ScanState {
  header: Record<string, unknown> | undefined;
  rejected: boolean;
  messageCount: number;
  firstMessageText: string | undefined;
  name: string | undefined;
  /** Reused across files scanned by the same worker; never escapes a scan. */
  chunkBuffer: Buffer;
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
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    return undefined;
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(filePath, "r");
  } catch {
    return undefined;
  }

  const state: ScanState = {
    header: undefined,
    rejected: false,
    messageCount: 0,
    firstMessageText: undefined,
    name: undefined,
    chunkBuffer: chunkBuffer ?? Buffer.allocUnsafe(SCAN_CHUNK_BYTES),
  };
  try {
    let pendingChunks: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await file.read(state.chunkBuffer, 0, state.chunkBuffer.length, null);
      const reachedEnd = bytesRead === 0;
      const data = state.chunkBuffer.subarray(0, bytesRead);
      let lineStart = 0;
      let newlineAt = data.indexOf(NEWLINE);
      while (newlineAt !== -1) {
        if (pendingChunks.length > 0) {
          // A line longer than one chunk: join the saved pieces and finish it.
          pendingChunks.push(Buffer.from(data.subarray(lineStart, newlineAt)));
          const whole = Buffer.concat(pendingChunks);
          pendingChunks = [];
          processLineBytes(whole, 0, whole.length, state);
        } else {
          processLineBytes(data, lineStart, newlineAt, state);
        }
        if (state.rejected) break;
        lineStart = newlineAt + 1;
        newlineAt = data.indexOf(NEWLINE, lineStart);
      }
      if (state.rejected) break;
      if (reachedEnd) {
        // Final line without a trailing newline (foreign writers, or a line
        // still being written when we read).
        if (pendingChunks.length > 0) {
          pendingChunks.push(Buffer.from(data.subarray(lineStart)));
          const whole = Buffer.concat(pendingChunks);
          processLineBytes(whole, 0, whole.length, state);
        } else if (lineStart < data.length) {
          processLineBytes(data, lineStart, data.length, state);
        }
        break;
      }
      if (lineStart < data.length) pendingChunks.push(Buffer.from(data.subarray(lineStart)));
    }
  } catch {
    // One unreadable/corrupt file must not break the listing; the SDK skips
    // such files too.
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }

  if (state.rejected || state.header === undefined) return undefined;
  const id = state.header["id"];
  // The SDK would list a header without a usable id; downstream lookups then
  // call `.startsWith` on it and crash. Skip such files instead.
  if (typeof id !== "string" || id === "") return undefined;

  const headerCwd = state.header["cwd"];
  const parentSessionPath = state.header["parentSession"];
  const headerTimestamp = state.header["timestamp"];
  return {
    path: filePath,
    id,
    cwd: typeof headerCwd === "string" ? headerCwd : "",
    created: typeof headerTimestamp === "string" || typeof headerTimestamp === "number" ? new Date(headerTimestamp) : new Date(Number.NaN),
    modified: stats.mtime,
    messageCount: state.messageCount,
    firstMessage: state.firstMessageText ?? "(no messages)",
    // Never built: see the directory-level doc comment. Kept because SDK-built
    // entries (cleanup listing) still carry the field.
    allMessagesText: "",
    ...(state.name === undefined ? {} : { name: state.name }),
    ...(typeof parentSessionPath === "string" ? { parentSessionPath } : {}),
  };
}

/** Classify and fold one line, addressed as bytes inside `data`. */
function processLineBytes(data: Buffer, start: number, end: number, state: ScanState): void {
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
