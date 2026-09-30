import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo } from "../api";
import * as reviewCommentStorage from "../review/reviewCommentStorage";
import type { ReviewComment } from "../review/reviewTypes";
import { ReviewController, type ReviewControllerDependencies } from "./reviewController";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const session: SessionInfo = {
  id: "session-1",
  path: "/tmp/session-1.jsonl",
  cwd: "/repo",
  created: "2026-05-15T00:00:00.000Z",
  modified: "2026-05-15T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

function createHarness(statePatch: Partial<AppState> = {}, deps: ReviewControllerDependencies = {}) {
  let state: AppState = { ...initialAppState(), selectedSession: session, ...statePatch };
  const backing = new MemoryStorage();
  let sequence = 0;
  let clock = 1000;
  const notify = vi.fn();
  const controller = new ReviewController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    {
      storage: {
        loadComments: (key) => reviewCommentStorage.loadComments(key, backing),
        saveComments: (key, comments) => { reviewCommentStorage.saveComments(key, comments, backing); },
        clearComments: (key) => { reviewCommentStorage.clearComments(key, backing); },
        moveComments: (from, to) => { reviewCommentStorage.moveComments(from, to, backing); },
      },
      now: deps.now ?? (() => { clock += 1; return clock; }),
      idFactory: deps.idFactory ?? (() => { sequence += 1; return `review-${String(sequence)}`; }),
      notify,
      ...deps,
    },
  );
  return {
    controller,
    notify,
    backing,
    get state() { return state; },
    /** Simulates `sessionController.selectSession` updating `selectedSession` -- production always does this alongside `adoptSession`, whereas this harness otherwise pins it to a fixed session. */
    setMachineId(id: string) { state = { ...state, selectedMachine: { id, name: id, kind: "remote", baseUrl: "http://localhost", createdAt: "", updatedAt: "" } }; },
    setSelectedSessionId(id: string) { state = { ...state, selectedSession: { ...session, id } }; },
  };
}

function commitAndFillDraft(harness: ReturnType<typeof createHarness>, body: string, hash = "hash-a"): void {
  harness.controller.beginSelection("a.ts", { side: "new", line: 3 });
  harness.controller.extendSelection({ side: "new", line: 5 });
  harness.controller.commitSelection(hash);
  harness.controller.setDraftBody(body);
}

describe("ReviewController authoring + queries", () => {
  it("rejects Files deleted-side anchors at selection, draft, and edit boundaries", () => {
    const harness = createHarness();
    const { controller } = harness;
    const invalid = { source: "files" as const, filePath: "a.ts", range: { side: "old" as const, start: 1, end: 1 } };
    controller.beginSelection("a.ts", { source: "files", side: "old", line: 1 });
    expect(harness.state.reviewSelection).toBeUndefined();
    controller.beginSelection("a.ts", { source: "files", side: "new", line: 1 });
    controller.commitSelection("hash");
    controller.setDraftBody("valid feedback");
    controller.submitDraft(invalid);
    expect(controller.list()).toEqual([]);
    expect(controller.draft()?.body).toBe("valid feedback");
    controller.submitDraft();
    const saved = controller.list()[0];
    if (saved === undefined) throw new Error("Expected saved feedback");
    controller.update(saved.id, "invalid edit", invalid);
    expect(controller.list()[0]).toEqual(saved);
  });

  it.each([
    { start: -1, end: -1 }, { start: 0, end: 2 }, { start: 3, end: 2 },
    { start: 1.5, end: 2 }, { start: 1, end: Infinity }, { start: NaN, end: 2 },
  ])("rejects invalid ranges without persisting a draft or changing an existing comment: %j", (range) => {
    const harness = createHarness();
    commitAndFillDraft(harness, "saved note");
    harness.controller.submitDraft();
    const saved = harness.controller.list()[0];
    if (saved === undefined) throw new Error("Expected saved comment");
    commitAndFillDraft(harness, "pending note");
    const invalidAnchor = { ...saved.anchor, range: { ...saved.anchor.range, ...range } };
    harness.controller.submitDraft(invalidAnchor);
    expect(harness.controller.list()).toEqual([saved]);
    expect(harness.controller.draft()?.body).toBe("pending note");
    harness.controller.update(saved.id, "invalid edit", invalidAnchor);
    expect(harness.controller.list()).toEqual([saved]);
    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toEqual([saved]);
  });

  it("also rejects an invalid stored draft anchor when no override is supplied", () => {
    const harness = createHarness({ reviewDraft: { anchor: { filePath: "a.ts", source: "files", range: { side: "new", start: 2, end: 1 } }, body: "pending" } });
    harness.controller.submitDraft();
    expect(harness.controller.list()).toEqual([]);
    expect(harness.controller.draft()?.body).toBe("pending");
    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toEqual([]);
  });

  it("adds a comment through the draft flow and lists/queries it", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "looks off");
    harness.controller.submitDraft();

    expect(harness.state.reviewDraft).toBeUndefined();
    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.controller.total()).toBe(1);
    expect(harness.controller.forFile("a.ts")).toHaveLength(1);
    expect(harness.controller.countForFile("a.ts")).toBe(1);
    expect(harness.controller.countForFile("b.ts")).toBe(0);
    expect(harness.controller.commentsForLine("a.ts", { side: "new", line: 4 })).toHaveLength(1);
    expect(harness.controller.commentsForLine("a.ts", { side: "new", line: 9 })).toHaveLength(0);
    expect(harness.controller.commentsForLine("a.ts", { side: "old", line: 4 })).toHaveLength(0);

    const [comment] = harness.controller.list();
    expect(comment).toMatchObject({ id: "review-1", body: "looks off", sourceHash: "hash-a" });
    expect(comment?.anchor.range).toEqual({ side: "new", start: 3, end: 5 });
  });

  it("persists comments to storage keyed by machine + session", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");
    harness.controller.submitDraft();

    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toHaveLength(1);
  });

  it("updates and removes a comment", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");
    harness.controller.submitDraft();
    const id = harness.controller.list()[0]?.id;
    if (id === undefined) throw new Error("expected a comment");

    const comment = harness.controller.list()[0];
    if (comment === undefined) throw new Error("expected a comment");
    harness.controller.update(id, "revised note", comment.anchor);
    expect(harness.controller.list()[0]?.body).toBe("revised note");

    harness.controller.remove(id);
    expect(harness.controller.list()).toHaveLength(0);
  });

  it("keeps a single active draft: committing a new selection replaces the open draft", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "first draft");
    expect(harness.controller.draft()?.body).toBe("first draft");

    harness.controller.beginSelection("b.ts", { side: "new", line: 1 });
    harness.controller.commitSelection("hash-b");

    expect(harness.controller.draft()?.anchor.filePath).toBe("b.ts");
    expect(harness.controller.draft()?.body).toBe("");
  });

  it("draftForLine returns the draft only for its own file + line range", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");

    expect(harness.controller.draftForLine("a.ts", { side: "new", line: 4 })).toBeDefined();
    expect(harness.controller.draftForLine("a.ts", { side: "new", line: 9 })).toBeUndefined();
    expect(harness.controller.draftForLine("b.ts", { side: "new", line: 4 })).toBeUndefined();
  });

  it("cancelDraft clears the draft without creating a comment", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");

    harness.controller.cancelDraft();

    expect(harness.controller.draft()).toBeUndefined();
    expect(harness.controller.list()).toHaveLength(0);
  });
});

describe("ReviewController selection state machine", () => {
  it("begins, extends, and reflects selection in lineState", () => {
    const harness = createHarness();
    harness.controller.beginSelection("a.ts", { side: "new", line: 2 });
    harness.controller.extendSelection({ side: "new", line: 4 });

    expect(harness.controller.lineState("a.ts", { side: "new", line: 3 })).toEqual({ selected: true, commented: false });
    expect(harness.controller.lineState("a.ts", { side: "new", line: 5 })).toEqual({ selected: false, commented: false });
  });

  it("reports commented:true for every line of an open draft's range, before it is saved", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");

    // Draft covers lines 3-5 (see `commitAndFillDraft`); every line in range
    // should read as "commented" (highlight-worthy) even though nothing has
    // been submitted yet, and the live selection is already cleared.
    expect(harness.controller.lineState("a.ts", { side: "new", line: 3 })).toEqual({ selected: false, commented: true });
    expect(harness.controller.lineState("a.ts", { side: "new", line: 4 })).toEqual({ selected: false, commented: true });
    expect(harness.controller.lineState("a.ts", { side: "new", line: 5 })).toEqual({ selected: false, commented: true });
    expect(harness.controller.lineState("a.ts", { side: "new", line: 6 })).toEqual({ selected: false, commented: false });
    expect(harness.controller.lineState("b.ts", { side: "new", line: 3 })).toEqual({ selected: false, commented: false });
  });

  it("reports commented:true for every line of a saved comment's range", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");
    harness.controller.submitDraft();

    expect(harness.controller.lineState("a.ts", { side: "new", line: 3 }).commented).toBe(true);
    expect(harness.controller.lineState("a.ts", { side: "new", line: 4 }).commented).toBe(true);
    expect(harness.controller.lineState("a.ts", { side: "new", line: 5 }).commented).toBe(true);
    expect(harness.controller.lineState("a.ts", { side: "new", line: 6 }).commented).toBe(false);
  });

  it("ignores extendSelection calls for a different side than the anchor (single-side clamp)", () => {
    const harness = createHarness();
    harness.controller.beginSelection("a.ts", { side: "new", line: 2 });
    harness.controller.extendSelection({ side: "old", line: 10 });

    expect(harness.state.reviewSelection).toEqual({ filePath: "a.ts", side: "new", anchorLine: 2, currentLine: 2 });
  });

  it("cancelSelection clears the transient selection", () => {
    const harness = createHarness();
    harness.controller.beginSelection("a.ts", { side: "new", line: 2 });

    harness.controller.cancelSelection();

    expect(harness.state.reviewSelection).toBeUndefined();
  });

  it("beginSelection is a no-op when authoring is not allowed (no session)", () => {
    const harness = createHarness({ selectedSession: undefined });

    harness.controller.beginSelection("a.ts", { side: "new", line: 2 });

    expect(harness.state.reviewSelection).toBeUndefined();
  });
});

describe("ReviewController staleness", () => {
  it("invalidateFile drops only mismatched-hash comments for that path and notifies", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "stale note", "old-hash");
    harness.controller.submitDraft();
    harness.controller.beginSelection("a.ts", { side: "new", line: 8 });
    harness.controller.commitSelection("fresh-hash");
    harness.controller.setDraftBody("fresh note");
    harness.controller.submitDraft();
    harness.controller.beginSelection("b.ts", { side: "new", line: 1 });
    harness.controller.commitSelection("old-hash");
    harness.controller.setDraftBody("other file");
    harness.controller.submitDraft();

    // The surface explicitly owns the source domain of these comments.
    for (const comment of harness.controller.list()) harness.controller.update(comment.id, comment.body, { ...comment.anchor, source: "files" });
    harness.controller.invalidateFile("a.ts", "fresh-hash", "files");

    const remainingBodies = harness.controller.list().map((comment) => comment.body).sort();
    expect(remainingBodies).toEqual(["fresh note", "other file"]);
    expect(harness.notify).toHaveBeenCalledTimes(1);
  });

  it("is a no-op and does not notify when nothing is stale", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note", "hash-a");
    harness.controller.submitDraft();

    harness.controller.invalidateFile("a.ts", "hash-a");

    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.notify).not.toHaveBeenCalled();
  });
});

describe("ReviewController canAuthor", () => {
  it("is false when no session is selected", () => {
    const harness = createHarness({ selectedSession: undefined });
    expect(harness.controller.canAuthor()).toBe(false);
  });

  it("is false while reviewSendLocked", () => {
    const harness = createHarness({ reviewSendLocked: true });
    expect(harness.controller.canAuthor()).toBe(false);
  });

  it("is true with a session and no lock", () => {
    const harness = createHarness();
    expect(harness.controller.canAuthor()).toBe(true);
  });
});

describe("ReviewController send lifecycle", () => {
  function twoComments(harness: ReturnType<typeof createHarness>): string[] {
    commitAndFillDraft(harness, "first");
    harness.controller.submitDraft();
    harness.controller.beginSelection("b.ts", { side: "new", line: 1 });
    harness.controller.commitSelection("hash-b");
    harness.controller.setDraftBody("second");
    harness.controller.submitDraft();
    return harness.controller.list().map((comment) => comment.id);
  }

  it("beginSend snapshots ids + markdown, cancels an open draft, and locks authoring", () => {
    const harness = createHarness();
    const ids = twoComments(harness);
    harness.controller.beginSelection("c.ts", { side: "new", line: 1 });
    harness.controller.commitSelection("hash-c");
    harness.controller.setDraftBody("in progress");

    const snapshot = requiredSnapshot(harness.controller);

    expect(snapshot.ids.sort()).toEqual(ids.sort());
    expect(snapshot.markdown).toContain("Code review comments (");
    expect(harness.controller.draft()).toBeUndefined();
    expect(harness.state.reviewSendLocked).toBe(true);
    expect(harness.controller.canAuthor()).toBe(false);
  });

  it("completeSend removes exactly the snapshotted ids and clears the lock", () => {
    const harness = createHarness();
    twoComments(harness);
    const snapshot = requiredSnapshot(harness.controller);

    harness.controller.completeSend(snapshot);

    expect(harness.controller.list()).toHaveLength(0);
    expect(harness.state.reviewSendLocked).toBe(false);
  });

  it("abortSend keeps all comments and clears the lock", () => {
    const harness = createHarness();
    twoComments(harness);
    const snapshot = requiredSnapshot(harness.controller);

    harness.controller.abortSend(snapshot);

    expect(harness.controller.list()).toHaveLength(2);
    expect(harness.state.reviewSendLocked).toBe(false);
  });

  it("rejects mutation attempts made while locked (canAuthor guard holds)", () => {
    const harness = createHarness();
    twoComments(harness);
    const snapshot = requiredSnapshot(harness.controller);

    harness.controller.beginSelection("d.ts", { side: "new", line: 1 });
    expect(harness.state.reviewSelection).toBeUndefined();
    harness.controller.commitSelection("hash-d");
    expect(harness.controller.draft()).toBeUndefined();

    harness.controller.abortSend(snapshot);
    expect(harness.controller.list()).toHaveLength(2);
  });
});

describe("ReviewController session lifecycle", () => {
  it("adoptSession loads that session's comments and cancels any open draft/selection", () => {
    const harness = createHarness();
    reviewCommentStorage.saveComments("remote-1:session-2", [fakeComment("x.ts")], harness.backing);
    harness.controller.beginSelection("a.ts", { side: "new", line: 1 });

    harness.controller.adoptSession("remote-1", "session-2");

    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.controller.list()[0]?.anchor.filePath).toBe("x.ts");
    expect(harness.state.reviewSelection).toBeUndefined();
    expect(harness.state.reviewDraft).toBeUndefined();
  });

  it("comments are session-scoped: switching sessions swaps the active view without dropping either session's storage", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "session-1 comment");
    harness.controller.submitDraft();
    expect(harness.controller.list()).toHaveLength(1);

    harness.setSelectedSessionId("session-2");
    harness.controller.adoptSession("local", "session-2");
    expect(harness.controller.list()).toHaveLength(0);

    commitAndFillDraft(harness, "session-2 comment", "hash-b");
    harness.controller.submitDraft();
    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.controller.list()[0]?.body).toBe("session-2 comment");

    harness.setSelectedSessionId("session-1");
    harness.controller.adoptSession("local", "session-1");
    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.controller.list()[0]?.body).toBe("session-1 comment");
  });

  it("clearActiveSession empties the in-memory view without touching persisted storage", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "note");
    harness.controller.submitDraft();
    expect(harness.controller.list()).toHaveLength(1);

    harness.controller.clearActiveSession();
    expect(harness.controller.list()).toHaveLength(0);

    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toHaveLength(1);

    harness.controller.adoptSession("local", "session-1");
    expect(harness.controller.list()).toHaveLength(1);
  });

  it("renameSession moves the store from the old key to the new key", () => {
    const harness = createHarness();
    reviewCommentStorage.saveComments("local:old-id", [fakeComment("y.ts")], harness.backing);

    harness.controller.renameSession("local:old-id", "local:new-id");

    expect(reviewCommentStorage.loadComments("local:old-id", harness.backing)).toHaveLength(0);
    expect(reviewCommentStorage.loadComments("local:new-id", harness.backing)).toHaveLength(1);
  });

  it("forgetSession clears storage for that session key", () => {
    const harness = createHarness();
    reviewCommentStorage.saveComments("local:session-1", [fakeComment("z.ts")], harness.backing);

    harness.controller.forgetSession("local", "session-1");

    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toHaveLength(0);
  });

  it("submitDraft saves comment with updated anchor when provided", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "test comment");
    const draft = harness.controller.draft();
    if (draft === undefined) throw new Error("expected draft");

    const updatedAnchor = {
      filePath: draft.anchor.filePath,
      range: { side: "new" as const, start: 10, end: 15 },
    };
    harness.controller.submitDraft(updatedAnchor);

    const comment = harness.controller.list()[0];
    expect(comment?.anchor).toEqual(updatedAnchor);
  });

  it("update saves comment with updated anchor when provided", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "original");
    harness.controller.submitDraft();
    const id = harness.controller.list()[0]?.id;
    if (id === undefined) throw new Error("expected a comment");

    const updatedAnchor = {
      filePath: "a.ts",
      range: { side: "new" as const, start: 20, end: 25 },
    };
    harness.controller.update(id, "updated body", updatedAnchor);

    const comment = harness.controller.list()[0];
    expect(comment?.anchor).toEqual(updatedAnchor);
    expect(comment?.body).toBe("updated body");
  });
});

function fakeComment(filePath: string): ReviewComment {
  return {
    id: "review-fixture",
    anchor: { filePath, range: { side: "new", start: 1, end: 1 } },
    body: "fixture",
    createdAt: 1,
    updatedAt: 1,
    sourceHash: "hash",
  };
}

function requiredSnapshot(controller: ReviewController) {
  const snapshot = controller.beginSend();
  if (snapshot === undefined) throw new Error("Expected accepted review send");
  return snapshot;
}


describe("ReviewController owner-bound sends", () => {
  it.each([true, false])("settles only the originating machine/session after navigation (success: %s)", (success) => {
    const harness = createHarness();
    commitAndFillDraft(harness, "A");
    harness.controller.submitDraft();
    const first = requiredSnapshot(harness.controller);
    expect(harness.controller.beginSend()).toBeUndefined();
    harness.setMachineId("remote");
    harness.controller.adoptSession("remote", "session-1");
    expect(harness.state.reviewSendLocked).toBe(false);
    commitAndFillDraft(harness, "B");
    harness.controller.submitDraft();
    const second = requiredSnapshot(harness.controller);

    if (success) harness.controller.completeSend(first);
    else harness.controller.abortSend(first);

    expect(harness.controller.list().map((comment) => comment.body)).toEqual(["B"]);
    expect(harness.state.reviewSendLocked).toBe(true);
    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toHaveLength(success ? 0 : 1);
    harness.controller.abortSend(second);
    expect(harness.state.reviewSendLocked).toBe(false);
  });

  it("restores an in-flight lock on revisit and ignores an already settled token", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "A");
    harness.controller.submitDraft();
    const first = requiredSnapshot(harness.controller);
    harness.setSelectedSessionId("B");
    harness.controller.adoptSession("local", "B");
    harness.setSelectedSessionId("session-1");
    harness.controller.adoptSession("local", "session-1");
    expect(harness.controller.canAuthor()).toBe(false);
    harness.controller.abortSend(first);
    const second = requiredSnapshot(harness.controller);
    harness.controller.completeSend(first);
    expect(harness.controller.list()).toHaveLength(1);
    expect(harness.state.reviewSendLocked).toBe(true);
    harness.controller.completeSend(second);
    expect(harness.controller.list()).toEqual([]);
  });

  it.each([true, false])("follows a pending send through replacement without clearing newer feedback (adopt first: %s)", (adoptFirst) => {
    const harness = createHarness();
    commitAndFillDraft(harness, "temporary");
    harness.controller.submitDraft();
    const snapshot = requiredSnapshot(harness.controller);
    reviewCommentStorage.saveComments("local:real", [fakeComment("newer.ts")], harness.backing);
    harness.controller.renameSession("local:session-1", "local:real");
    harness.setSelectedSessionId("real");
    if (adoptFirst) harness.controller.adoptSession("local", "real");
    expect(harness.state.reviewSendLocked).toBe(true);
    harness.controller.completeSend(snapshot);
    harness.controller.adoptSession("local", "real");
    expect(harness.controller.list().map((comment) => comment.anchor.filePath)).toEqual(["newer.ts"]);
    expect(reviewCommentStorage.loadComments("local:session-1", harness.backing)).toEqual([]);
    expect(reviewCommentStorage.loadComments("local:real", harness.backing)).toHaveLength(1);
  });

  it("generates independent IDs after recreating the controller and adopting stored comments", () => {
    const backing = new MemoryStorage();
    let state = { ...initialAppState(), selectedSession: session };
    const storage = {
      loadComments: (key: string) => reviewCommentStorage.loadComments(key, backing),
      saveComments: (key: string, comments: readonly ReviewComment[]) => { reviewCommentStorage.saveComments(key, comments, backing); },
      clearComments: (key: string) => { reviewCommentStorage.clearComments(key, backing); },
      moveComments: (from: string, to: string) => { reviewCommentStorage.moveComments(from, to, backing); },
    };
    const makeController = () => new ReviewController(() => state, (patch) => { state = { ...state, ...patch, selectedSession: session }; }, { storage });
    for (let index = 0; index < 2; index += 1) {
      const controller = makeController();
      controller.adoptSession("local", session.id);
      controller.beginSelection("a.ts", { source: "files", side: "new", line: 1 });
      controller.commitSelection("hash");
      controller.setDraftBody(`comment ${String(index)}`);
      controller.submitDraft();
    }
    expect(state.reviewComments).toHaveLength(2);
    expect(new Set(state.reviewComments.map((comment) => comment.id)).size).toBe(2);
  });
});

describe("ReviewController snapshot domains", () => {
  it("keeps raw, staged, unstaged, and legacy feedback isolated in queries and invalidation", () => {
    const harness = createHarness();
    commitAndFillDraft(harness, "legacy", "legacy-hash");
    harness.controller.submitDraft();
    for (const source of ["files", "git-staged", "git-unstaged"] as const) {
      const ref = { source, side: "new" as const, line: 3 };
      harness.controller.beginSelection("a.ts", ref);
      harness.controller.commitSelection(source);
      harness.controller.setDraftBody(source);
      expect(harness.controller.draftForLine("a.ts", ref)?.body).toBe(source);
      expect(harness.controller.draftForLine("a.ts", { ...ref, sourceHash: "older" })).toBeUndefined();
      harness.controller.submitDraft();
      expect(harness.controller.commentsForLine("a.ts", ref).map((comment) => comment.body)).toEqual([source]);
      expect(harness.controller.commentsForLine("a.ts", { ...ref, sourceHash: "older" })).toEqual([]);
    }
    harness.controller.invalidateFile("a.ts", "raw-content", "files");
    expect(harness.controller.list().map((comment) => comment.body)).toEqual(["legacy", "git-staged", "git-unstaged"]);
    harness.controller.invalidateFile("a.ts", "git-staged", "git-staged");
    expect(harness.controller.total()).toBe(3);
    harness.controller.invalidateFile("a.ts", "changed-worktree", "git-unstaged");
    harness.controller.invalidateFile("a.ts", "unknown");
    expect(harness.controller.list().map((comment) => comment.body)).toEqual(["legacy", "git-staged"]);
    expect(requiredSnapshot(harness.controller).markdown).toContain("(Git staged)");
  });

  it("does not commit a selection against content changed during the gesture", () => {
    const harness = createHarness();
    harness.controller.beginSelection("a.ts", { source: "git-staged", sourceHash: "old", side: "new", line: 3 });
    harness.controller.commitSelection("new");
    expect(harness.controller.draft()).toBeUndefined();
    expect(harness.state.reviewSelection).toBeUndefined();
  });

  it("does not extend a staged selection with an unstaged line", () => {
    const harness = createHarness();
    harness.controller.beginSelection("a.ts", { source: "git-staged", side: "new", line: 3 });
    harness.controller.extendSelection({ source: "git-unstaged", side: "new", line: 8 });
    expect(harness.controller.lineState("a.ts", { source: "git-unstaged", side: "new", line: 3 }).selected).toBe(false);
    harness.controller.commitSelection("staged");
    expect(harness.controller.draft()?.anchor).toEqual({ source: "git-staged", filePath: "a.ts", range: { side: "new", start: 3, end: 3 } });
    harness.controller.invalidateFile("a.ts", "different", "git-unstaged");
    expect(harness.controller.draft()).toBeDefined();
    harness.controller.invalidateFile("a.ts", "different", "git-staged");
    expect(harness.controller.draft()).toBeUndefined();
  });
});
