/**
 * Bounded memo for idle-session transcript snapshots.
 *
 * The session daemon lives indefinitely and clients poll their selected idle
 * session's transcript from disk. Memoizing the parsed branch per file makes
 * an unchanged poll cheap, but an unbounded memo would retain every session
 * ever polled — transcripts included — for the daemon's lifetime. This cache
 * keeps the memo bounded: entries are keyed by session file path, validated
 * by the file signature the caller computed, and evicted least-recently-used
 * first once the limit is reached.
 *
 * Eviction is self-contained on purpose: it needs no hook into session
 * close/archive/delete flows, and an evicted entry simply means the next read
 * re-parses the file.
 */

/**
 * Default snapshot bound. Snapshot reads come from clients polling their
 * selected idle session, so the hot set is the distinct sessions polled
 * concurrently; 16 sits far above realistic client counts while capping how
 * many parsed transcripts the daemon retains.
 */
export const DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT = 16;

/** Construction options for {@link TranscriptBranchCache}. */
export interface TranscriptBranchCacheOptions {
  /**
   * Maximum memoized snapshots. Defaults to
   * {@link DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT}; tests pass a small limit to
   * exercise eviction directly.
   */
  readonly limit?: number;
}

interface TranscriptBranchSnapshot {
  signature: string;
  branch: unknown[];
}

/**
 * A small LRU memo of transcript branches keyed by session file path.
 * Backed by a `Map` whose insertion order doubles as recency order: reads
 * and writes refresh the entry, and the oldest entry is evicted past the
 * limit.
 */
export class TranscriptBranchCache {
  private readonly limit: number;
  private readonly snapshots = new Map<string, TranscriptBranchSnapshot>();

  constructor(options: TranscriptBranchCacheOptions = {}) {
    this.limit = options.limit ?? DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT;
  }

  /**
   * The memoized branch for `path`, or `undefined` when nothing is memoized
   * or the memoized signature no longer matches. A hit refreshes recency so
   * an actively polled session outlives one-off reads churning the bound.
   */
  get(path: string, signature: string): unknown[] | undefined {
    const snapshot = this.snapshots.get(path);
    if (snapshot === undefined) return undefined;
    if (snapshot.signature !== signature) return undefined;
    this.snapshots.delete(path);
    this.snapshots.set(path, snapshot);
    return snapshot.branch;
  }

  /** Memoize `branch` for `path`, evicting the least recently used entry at the bound. */
  set(path: string, signature: string, branch: unknown[]): void {
    this.snapshots.delete(path);
    this.snapshots.set(path, { signature, branch });
    // One set adds at most one entry, so a single eviction restores the bound.
    if (this.snapshots.size > this.limit) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done !== true) this.snapshots.delete(oldest.value);
    }
  }
}
