import { machineSessionKey } from "../machineKeys";
import {
  clearComments as defaultClearComments,
  loadComments as defaultLoadComments,
  moveComments as defaultMoveComments,
  saveComments as defaultSaveComments,
} from "../review/reviewCommentStorage";
import { hashSource as defaultHashSource } from "../review/reviewHash";
import { buildReviewMarkdown } from "../review/reviewMarkdown";
import { isValidReviewAnchor } from "../review/reviewCoordinates";
import type { ReviewAnchor, ReviewComment, ReviewLineRef, ReviewSide, ReviewSource } from "../review/reviewTypes";
import { selectedMachineId, type GetState, type SetState } from "./types";

interface ReviewCommentStorage {
  loadComments: typeof defaultLoadComments;
  saveComments: typeof defaultSaveComments;
  clearComments: typeof defaultClearComments;
  moveComments: typeof defaultMoveComments;
}

export interface ReviewControllerDependencies {
  storage?: ReviewCommentStorage;
  now?: () => number;
  idFactory?: () => string;
  hashSource?: (text: string) => string;
  /** Surfaces a transient human-readable notice, e.g. on staleness drop. No-op by default. */
  notify?: (message: string) => void;
}

/**
 * Result of {@link ReviewController.beginSend}: the ids present at send time
 * plus the markdown built from them. {@link ReviewController.completeSend}
 * removes exactly these ids from the originating owner on confirmed success.
 * Pass the same snapshot object back to settle it. Its owner is tracked by the
 * controller, including across navigation and temporary-session replacement.
 */
export interface ReviewSendSnapshot {
  ids: string[];
  markdown: string;
}

/**
 * Owns the selected session's pending review comments plus the single active
 * selection/draft, with independent send locks per machine/session. Every mutation persists to
 * `reviewCommentStorage` (localStorage) AND replaces the relevant `AppState`
 * fields immutably via `setState`.
 */
export class ReviewController {
  private readonly storage: ReviewCommentStorage;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly hashSource: (text: string) => string;
  private readonly notify: (message: string) => void;
  private readonly pendingSends = new Map<string, ReviewSendSnapshot>();
  private activeSessionKey: string | undefined;
  /**
   * `submitDraft()` creates the comment with a `sourceHash`, but
   * `AppState.reviewDraft` only carries `{ anchor, body }` -- there's no
   * field for it there. `commitSelection` takes a required `sourceHash`
   * parameter (the hash of the content the selection was made against) and
   * keeps it here, as controller-private bookkeeping for the *current* draft
   * only, rather than widening the public `ReviewDraft` shape. It is
   * cleared whenever the draft is cleared (submit/cancel/replace/adopt/
   * rename/forget).
   */
  private draftSourceHash: string | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: ReviewControllerDependencies = {},
  ) {
    this.activeSessionKey = this.currentSessionKey();
    this.storage = deps.storage ?? {
      loadComments: defaultLoadComments,
      saveComments: defaultSaveComments,
      clearComments: defaultClearComments,
      moveComments: defaultMoveComments,
    };
    this.now = deps.now ?? (() => Date.now());
    this.idFactory = deps.idFactory ?? (() => `review-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`);
    this.hashSource = deps.hashSource ?? defaultHashSource;
    this.notify = deps.notify ?? (() => { /* no-op by default */ });
  }

  // --- Data / query ---------------------------------------------------

  list(): readonly ReviewComment[] {
    return this.getState().reviewComments;
  }

  forFile(path: string): readonly ReviewComment[] {
    return this.list().filter((comment) => comment.anchor.filePath === path);
  }

  countForFile(path: string): number {
    return this.forFile(path).length;
  }

  total(): number {
    return this.list().length;
  }

  commentsForLine(path: string, ref: ReviewLineRef): readonly ReviewComment[] {
    return this.forFile(path).filter((comment) => comment.anchor.source === ref.source && (ref.sourceHash === undefined || comment.sourceHash === ref.sourceHash) && lineRefInRange(comment.anchor.range, ref));
  }

  lineState(path: string, ref: ReviewLineRef): { selected: boolean; commented: boolean } {
    const selection = this.getState().reviewSelection;
    const selected = selection?.filePath === path
      && selection.side === ref.side && selection.source === ref.source
      && ref.line >= Math.min(selection.anchorLine, selection.currentLine)
      && ref.line <= Math.max(selection.anchorLine, selection.currentLine);
    // "commented" covers both saved comments AND an open (not yet submitted)
    // draft overlapping this line: while a draft's form is showing, the live
    // `reviewSelection` has already been cleared by `commitSelection`, so
    // without this the range would go dark for the entire authoring window.
    const commented = this.commentsForLine(path, ref).length > 0 || this.draftForLine(path, ref) !== undefined;
    return { selected, commented };
  }

  // --- Authoring --------------------------------------------------------

  canAuthor(): boolean {
    const state = this.getState();
    const key = this.currentSessionKey();
    return key !== undefined && !state.reviewSendLocked && !this.pendingSends.has(key);
  }

  beginSelection(path: string, ref: ReviewLineRef): void {
    if (!this.canAuthor() || (ref.source === "files" && ref.side !== "new")) return;
    this.setState({ reviewSelection: { filePath: path, side: ref.side, anchorLine: ref.line, currentLine: ref.line, ...(ref.source === undefined ? {} : { source: ref.source }), ...(ref.sourceHash === undefined ? {} : { sourceHash: ref.sourceHash }) } });
  }

  /** Ignore refs from a different side, source, or known snapshot. */
  extendSelection(ref: ReviewLineRef): void {
    const selection = this.getState().reviewSelection;
    if (!this.canAuthor() || selection?.side !== ref.side || selection.source !== ref.source || (ref.sourceHash !== undefined && selection.sourceHash !== ref.sourceHash)) return;
    this.setState({ reviewSelection: { ...selection, currentLine: ref.line } });
  }

  cancelSelection(): void {
    this.setState({ reviewSelection: undefined });
  }

  /**
   * Opens the draft at the current selection. `sourceHash` is the fingerprint
   * of the content the selection was made against (raw file-text hash
   * for Files, or a diff-text hash for staged/unstaged Git); the caller (the
   * Files/Git surface) computes it since only it has the content at commit
   * time. Overwrites any already-open draft: UI-level confirm-before-discard
   * is the caller's responsibility, not this pure controller's. No-ops when
   * there is no active selection or authoring is not allowed.
   */
  commitSelection(sourceHash: string): void {
    const selection = this.getState().reviewSelection;
    if (selection === undefined || !this.canAuthor()) return;
    if (selection.sourceHash !== undefined && selection.sourceHash !== sourceHash) {
      this.cancelSelection();
      return;
    }
    const start = Math.min(selection.anchorLine, selection.currentLine);
    const end = Math.max(selection.anchorLine, selection.currentLine);
    this.draftSourceHash = sourceHash;
    this.setState({
      reviewSelection: undefined,
      reviewDraft: {
        anchor: { filePath: selection.filePath, range: { side: selection.side, start, end }, ...(selection.source === undefined ? {} : { source: selection.source }) },
        body: "",
      },
    });
  }

  draft(): { anchor: ReviewComment["anchor"]; body: string } | undefined {
    return this.getState().reviewDraft;
  }

  draftForLine(path: string, ref: ReviewLineRef): { anchor: ReviewComment["anchor"]; body: string } | undefined {
    const draft = this.draft();
    if (draft?.anchor.filePath !== path || draft.anchor.source !== ref.source) return undefined;
    return (ref.sourceHash === undefined || this.draftSourceHash === ref.sourceHash) && lineRefInRange(draft.anchor.range, ref) ? draft : undefined;
  }

  setDraftBody(text: string): void {
    const draft = this.getState().reviewDraft;
    if (draft === undefined || !this.canAuthor()) return;
    this.setState({ reviewDraft: { ...draft, body: text } });
  }

  /** Creates the comment from the current draft and persists it. No-ops without an open draft. */
  submitDraft(anchor?: ReviewAnchor): void {
    const draft = this.getState().reviewDraft;
    if (draft === undefined || !this.canAuthor() || !isValidReviewAnchor(anchor ?? draft.anchor)) return;
    const timestamp = this.now();
    const comment: ReviewComment = {
      id: this.idFactory(),
      anchor: anchor ?? draft.anchor,
      body: draft.body,
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceHash: this.draftSourceHash ?? "",
    };
    this.persistComments([...this.getState().reviewComments, comment]);
    this.draftSourceHash = undefined;
    this.setState({ reviewDraft: undefined });
  }

  cancelDraft(): void {
    this.draftSourceHash = undefined;
    this.setState({ reviewDraft: undefined });
  }

  update(id: string, body: string, anchor: ReviewAnchor): void {
    if (!this.canAuthor() || !isValidReviewAnchor(anchor)) return;
    const timestamp = this.now();
    this.persistComments(this.getState().reviewComments.map((comment) => (comment.id === id ? { ...comment, body, anchor, updatedAt: timestamp } : comment)));
  }

  remove(id: string): void {
    if (!this.canAuthor()) return;
    this.persistComments(this.getState().reviewComments.filter((comment) => comment.id !== id));
  }

  // --- Staleness -----------------------------------------------------------

  invalidateFile(path: string, currentHash: string, source?: ReviewSource): void {
    // Legacy anchors have no trustworthy source domain; keep them available in the prompt.
    if (source === undefined) return;
    const selection = this.getState().reviewSelection;
    if (selection?.filePath === path && selection.source === source && selection.sourceHash !== currentHash) this.cancelSelection();
    const draft = this.getState().reviewDraft;
    if (draft?.anchor.filePath === path && draft.anchor.source === source && this.draftSourceHash !== currentHash) this.cancelDraft();
    const comments = this.getState().reviewComments;
    const kept = comments.filter((comment) => comment.anchor.filePath !== path || comment.anchor.source !== source || comment.sourceHash === currentHash);
    const droppedCount = comments.length - kept.length;
    if (droppedCount === 0) return;
    this.persistComments(kept);
    this.notify(`Discarded ${String(droppedCount)} stale review ${droppedCount === 1 ? "comment" : "comments"} on ${path}: the content changed.`);
  }

  // --- Send lifecycle -------------------------------------------------------

  beginSend(): ReviewSendSnapshot | undefined {
    const key = this.currentSessionKey();
    if (key === undefined || this.pendingSends.has(key)) return undefined;
    this.cancelDraft();
    const comments = this.getState().reviewComments;
    const snapshot = { ids: comments.map((comment) => comment.id), markdown: buildReviewMarkdown(comments) };
    this.pendingSends.set(key, snapshot);
    this.setState({ reviewSendLocked: true });
    return snapshot;
  }

  completeSend(snapshot: ReviewSendSnapshot): void {
    this.settleSend(snapshot, true);
  }

  abortSend(snapshot: ReviewSendSnapshot): void {
    this.settleSend(snapshot, false);
  }

  private settleSend(snapshot: ReviewSendSnapshot, successful: boolean): void {
    // Object identity is the send token; IDs alone cannot identify a session or a send.
    const entry = [...this.pendingSends].find(([, pending]) => pending === snapshot);
    if (entry === undefined) return;
    const [key] = entry;
    const isSelected = key === this.currentSessionKey() && key === this.activeSessionKey;
    if (successful) {
      const sent = new Set(snapshot.ids);
      const comments = isSelected ? this.getState().reviewComments : this.storage.loadComments(key);
      const kept = comments.filter((comment) => !sent.has(comment.id));
      this.storage.saveComments(key, kept);
      if (isSelected) this.setState({ reviewComments: kept });
    }
    this.pendingSends.delete(key);
    if (isSelected) this.setState({ reviewSendLocked: false });
  }

  // --- Session lifecycle ---------------------------------------------------

  adoptSession(machineId: string, sessionId: string): void {
    this.draftSourceHash = undefined;
    this.activeSessionKey = machineSessionKey(machineId, sessionId);
    const comments = this.storage.loadComments(this.activeSessionKey);
    this.setState({ reviewComments: comments, reviewDraft: undefined, reviewSelection: undefined, reviewSendLocked: this.pendingSends.has(machineSessionKey(machineId, sessionId)) });
  }

  /** No session selected: reset in-memory review state only -- storage is untouched, so a reselected session's comments reload via `adoptSession`. */
  clearActiveSession(): void {
    this.activeSessionKey = undefined;
    this.draftSourceHash = undefined;
    this.setState({ reviewComments: [], reviewDraft: undefined, reviewSelection: undefined, reviewSendLocked: false });
  }

  /**
   * Moves the store from one session key to another. Mirrors
   * `moveDraft`/`moveStagedAttachments`, which `sessionController` already
   * calls with pre-built `machineSessionKey(machineId, sessionId)` keys at
   * its rename call sites (temp-id -> real id, cached-new -> replacement).
   */
  renameSession(oldSessionKey: string, newSessionKey: string): void {
    this.storage.moveComments(oldSessionKey, newSessionKey);
    const pending = this.pendingSends.get(oldSessionKey);
    if (pending !== undefined) {
      this.pendingSends.delete(oldSessionKey);
      this.pendingSends.set(newSessionKey, pending);
    }
  }

  forgetSession(machineId: string, sessionId: string): void {
    this.storage.clearComments(machineSessionKey(machineId, sessionId));
  }

  private currentSessionKey(): string | undefined {
    const state = this.getState();
    return state.selectedSession === undefined ? undefined : machineSessionKey(selectedMachineId(state), state.selectedSession.id);
  }

  private persistComments(comments: readonly ReviewComment[]): void {
    const machineId = selectedMachineId(this.getState());
    const sessionId = this.getState().selectedSession?.id;
    this.activeSessionKey = sessionId === undefined ? undefined : machineSessionKey(machineId, sessionId);
    this.setState({ reviewComments: comments });
    if (sessionId === undefined) return;
    this.storage.saveComments(machineSessionKey(machineId, sessionId), comments);
  }
}

function lineRefInRange(range: { side: ReviewSide; start: number; end: number }, ref: ReviewLineRef): boolean {
  return range.side === ref.side && ref.line >= Math.min(range.start, range.end) && ref.line <= Math.max(range.start, range.end);
}
