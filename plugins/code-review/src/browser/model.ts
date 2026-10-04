import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { sha256 } from "@noble/hashes/sha2.js";
import { isGitSource, isWorkspacePath, record, type ReviewSource } from "../protocol.js";

export interface Anchor {
  path: string;
  source: ReviewSource;
  side: "old" | "new";
  start: number;
  end: number;
}
export interface Comment extends Anchor {
  id: string;
  body: string;
  hash: string;
  createdAt: number;
}
export interface Row {
  text: string;
  kind: "meta" | "context" | "add" | "remove";
  side?: "old" | "new";
  line?: number;
}
export interface Snapshot {
  path: string;
  source: ReviewSource;
  hash: string;
  rows: Row[];
}
export const storagePrefix = "pi-web-code-review:v1:";

export function workspaceKey(context: Pick<WorkspacePanelContext, "machine" | "workspace">): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}
export function validAnchor(anchor: Anchor): boolean {
  return isWorkspacePath(anchor.path) && (anchor.source === "files" || isGitSource(anchor.source))
    && (anchor.side === "new" || anchor.source !== "files")
    && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end) && anchor.start > 0 && anchor.end >= anchor.start;
}
function isComment(value: unknown): value is Comment {
  if (!record(value)) return false;
  const { path, source, side, start, end, id, body, hash, createdAt } = value;
  return typeof path === "string" && (source === "files" || isGitSource(source)) && (side === "old" || side === "new")
    && typeof start === "number" && typeof end === "number" && validAnchor({ path, source, side, start, end })
    && typeof id === "string" && id !== "" && typeof body === "string" && body.trim() !== ""
    && typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash) && typeof createdAt === "number" && Number.isFinite(createdAt);
}

/** Persist before exposing a mutation. Failed/corrupt storage never looks like an empty successful save. */
export class ReviewStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">) {}
  load(key: string): Comment[] {
    const raw = this.storage.getItem(storagePrefix + key);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value["version"] !== 1 || !Array.isArray(value["comments"])) throw new Error("Unrecognized review storage; existing data was retained");
    const comments: unknown[] = value["comments"];
    if (!comments.every(isComment) || new Set(comments.map((comment) => comment.id)).size !== comments.length) {
      throw new Error("Invalid review storage; existing data was retained");
    }
    return comments;
  }
  add(key: string, comment: Comment): Comment[] {
    if (!isComment(comment)) throw new Error("Invalid review comment");
    const comments = this.load(key);
    if (comments.some((item) => item.id === comment.id)) throw new Error("Duplicate review comment");
    return this.save(key, [...comments, comment]);
  }
  update(key: string, comment: Comment): Comment[] {
    if (!isComment(comment)) throw new Error("Invalid review comment");
    const comments = this.load(key);
    if (!comments.some((item) => item.id === comment.id)) throw new Error("This comment was removed in another tab");
    return this.save(key, comments.map((item) => item.id === comment.id ? comment : item));
  }
  remove(key: string, id: string): Comment[] {
    return this.save(key, this.load(key).filter((item) => item.id !== id));
  }
  /** Acknowledgements own a snapshot, not every comment now stored under its ids. */
  removeUnchanged(key: string, submitted: readonly Comment[]): Comment[] {
    const versions = new Map(submitted.map((comment) => [comment.id, commentVersion(comment)]));
    const comments = this.load(key);
    const kept = comments.filter((comment) => versions.get(comment.id) !== commentVersion(comment));
    return kept.length === comments.length ? comments : this.save(key, kept);
  }
  private save(key: string, comments: Comment[]): Comment[] {
    this.storage.setItem(storagePrefix + key, JSON.stringify({ version: 1, comments }));
    return comments;
  }
}

function commentVersion(comment: Comment): string {
  return JSON.stringify([comment.id, comment.path, comment.source, comment.side, comment.start, comment.end, comment.body, comment.hash, comment.createdAt]);
}

export const sourceLabel = (source: ReviewSource): string => source === "files" ? "File" : source === "git-staged" ? "Git staged" : "Git unstaged";
export function anchorLabel(anchor: Anchor): string {
  return `${anchor.path}:${String(anchor.start)}${anchor.end === anchor.start ? "" : `-${String(anchor.end)}`} (${sourceLabel(anchor.source)}${anchor.side === "old" ? ", deleted" : ""})`;
}

/** Same coordinate/body review format as the original UI, now exported explicitly by the plugin. */
export function reviewMarkdown(comments: readonly Comment[]): string {
  if (comments.length === 0) return "";
  const sorted = [...comments].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start || a.createdAt - b.createdAt);
  return [`### Code review comments (${String(sorted.length)})`, ...sorted.map((comment, index) => {
    const id = `C${String(index + 1)}`;
    const label = anchorLabel(comment).replace(/[\\`*_{}[\]<>()#!|]/gu, "\\$&");
    return `---\n\n#### ${id}: ${label}\n\n${comment.body.trim()}\n\n*-- end of ${id} --*`;
  })].join("\n\n");
}

/** getRandomValues works on LAN HTTP, unlike randomUUID and SubtleCrypto. */
export function randomId(): string {
  return [...crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function snapshot(path: string, source: ReviewSource, text: string): Snapshot {
  const hash = [...sha256(new TextEncoder().encode(text))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > 5_000) throw new Error("Source has too many lines to review inline (limit: 5,000)");
  if (source === "files") return { path, source, hash, rows: lines.map((line, i) => ({ text: line, kind: "context", side: "new", line: i + 1 })) };
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  const rows: Row[] = lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (hunk !== null) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
    } else if (oldLine !== undefined && newLine !== undefined) {
      if (text.startsWith("-") && oldRemaining > 0) { oldRemaining--; return { text, kind: "remove", side: "old", line: oldLine++ }; }
      if (text.startsWith("+") && newRemaining > 0) { newRemaining--; return { text, kind: "add", side: "new", line: newLine++ }; }
      if (text.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) { oldRemaining--; newRemaining--; oldLine++; return { text, kind: "context", side: "new", line: newLine++ }; }
      if (!text.startsWith("\\")) { oldLine = undefined; newLine = undefined; }
    }
    return { text, kind: "meta" };
  });
  return { path, source, hash, rows };
}

export function anchorInSnapshot(anchor: Anchor, view: Snapshot): boolean {
  if (!validAnchor(anchor) || anchor.path !== view.path || anchor.source !== view.source) return false;
  const lines = new Set(view.rows.filter((row) => row.side === anchor.side).map((row) => row.line));
  // Bound work for a manually edited range; a range cannot bridge omitted diff context.
  if (anchor.end - anchor.start >= lines.size) return false;
  for (let line = anchor.start; line <= anchor.end; line++) if (!lines.has(line)) return false;
  return true;
}
