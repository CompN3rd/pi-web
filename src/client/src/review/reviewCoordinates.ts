import type { ReviewAnchor, ReviewLineRange } from "./reviewTypes";

/** Persisted/editor ranges are ordered, positive integer coordinates. */
export function isValidReviewRange(range: Pick<ReviewLineRange, "start" | "end">): boolean {
  return Number.isInteger(range.start) && Number.isInteger(range.end) && range.start > 0 && range.start <= range.end;
}

/** Files has no deleted-side coordinates; legacy unscoped feedback remains valid. */
export function isValidReviewAnchor(anchor: ReviewAnchor): boolean {
  return isValidReviewRange(anchor.range) && (anchor.source !== "files" || anchor.range.side === "new");
}

/** Normalize a range to `[min, max]` regardless of drag direction. */
export function normalizedRange(range: ReviewLineRange): { start: number; end: number } {
  return { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
}

/**
 * Compact coordinate label for a range, e.g. `12`, `12-15`, or `8-9 (deleted)`
 * for old-side (deleted) lines.
 */
export function formatLineRange(range: ReviewLineRange): string {
  const { start, end } = normalizedRange(range);
  const lines = start === end ? String(start) : `${String(start)}-${String(end)}`;
  return range.side === "old" ? `${lines} (deleted)` : lines;
}

/** Full coordinate label, e.g. `src/app.ts:12-15` or `src/app.ts:8-9 (deleted)`. */
export function formatAnchorLabel(anchor: ReviewAnchor): string {
  const source = anchor.source === "files" ? "Files" : anchor.source === "git-staged" ? "Git staged" : anchor.source === "git-unstaged" ? "Git unstaged" : "legacy snapshot";
  return `${anchor.filePath}:${formatLineRange(anchor.range)} (${source})`;
}
