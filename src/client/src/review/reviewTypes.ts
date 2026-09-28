/**
 * Side the anchor refers to. The Files raw view is always "new" (current file
 * lines). Git context/added lines are "new"; git deleted lines are "old".
 * A single comment is single-side.
 */
export type ReviewSide = "new" | "old";

/** Coordinate and fingerprint domain. Missing source denotes legacy, unscoped feedback. */
export type ReviewSource = "files" | "git-staged" | "git-unstaged";

export interface ReviewLineRange {
  side: ReviewSide;
  /** 1-based inclusive line number on the given side. */
  start: number;
  end: number;
}

export interface ReviewAnchor {
  source?: ReviewSource;
  /** Workspace-relative path. */
  filePath: string;
  /** Single side, contiguous range. */
  range: ReviewLineRange;
}

export interface ReviewComment {
  /** Stable local id, unique across reloads. */
  id: string;
  anchor: ReviewAnchor;
  /** User text (markdown allowed). */
  body: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Fingerprint of the underlying content at creation, for staleness
   * invalidation within its source domain: raw file text for Files, or the
   * corresponding staged/unstaged diff text for either Git side.
   */
  sourceHash: string;
}

/** A line reference used by the selection/render APIs. */
export interface ReviewLineRef {
  source?: ReviewSource;
  /** Current snapshot fingerprint; queries omit comments from older content. */
  sourceHash?: string;
  side: ReviewSide;
  line: number;
}

/** An in-progress, not-yet-saved comment. */
export interface ReviewDraft {
  anchor: ReviewAnchor;
  body: string;
}
