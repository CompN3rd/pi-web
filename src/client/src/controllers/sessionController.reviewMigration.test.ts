import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, rememberCachedNewSession } from "../cachedNewSessions";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { loadComments, saveComments } from "../review/reviewCommentStorage";
import type { ReviewComment } from "../review/reviewTypes";
import { ReviewController } from "./reviewController";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, MemoryStorage, oldSession, replacementSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function comment(id: string): ReviewComment {
  return { id, anchor: { source: "files", filePath: "a.ts", range: { side: "new", start: 1, end: 1 } }, body: id, sourceHash: "h", createdAt: 0, updatedAt: 0 };
}

function rejectReplacementWrites(storage: MemoryStorage): void {
  const write = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
    if (key === `pi-web:review-comments:${sessionKey(replacementSession.id)}`) throw new Error("quota exceeded");
    write(key, value);
  });
}

describe("SessionController review migration failures", () => {
  it("retains the failed temporary owner, queued recovery data, and review token when destination writing fails", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const review = new ReviewController(() => state, setState);
    const prompt = vi.fn<typeof defaultApi.prompt>().mockResolvedValue({ accepted: true });
    const controller = new SessionController(() => state, setState, () => undefined, undefined, {
      api: { ...defaultApi, startSession: () => startRequest.promise, prompt }, socket: new FakeSocket(),
      moveReviewComments: (from, to) => { review.renameSession(from, to); },
    });
    const start = controller.startSession();
    const temporary = state.selectedSession;
    if (temporary === undefined) throw new Error("Expected temporary owner");
    saveComments(sessionKey(temporary.id), [comment("source")]);
    saveComments(sessionKey(replacementSession.id), [comment("destination")]);
    saveDraft(sessionKey(temporary.id), "recover draft");
    review.adoptSession("local", temporary.id);
    const token = review.beginSend();
    if (token === undefined) throw new Error("Expected send snapshot");
    await expect(controller.send("queued review feedback", undefined, undefined, "inline", undefined, true)).resolves.toBe(true);
    const queued = state.clientQueuedSessionMessages[temporary.id];
    expect(queued).toHaveLength(1);
    rejectReplacementWrites(storage);
    startRequest.resolve(replacementSession);
    await start;

    expect(state.selectedSession?.id).toBe(temporary.id);
    expect(state.sessions.map((session) => session.id)).toEqual([temporary.id]);
    expect(state.activity?.phase).toBe("error");
    expect(state.activity?.detail).toContain("1 queued message kept below");
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("original feedback was retained");
    expect(state.clientQueuedSessionMessages[temporary.id]).toEqual(queued);
    expect(prompt).not.toHaveBeenCalled();
    expect(loadDraft(sessionKey(temporary.id))).toBe("recover draft");
    expect(loadCachedNewSessions()).toEqual([]);
    expect(loadComments(sessionKey(temporary.id))).toEqual([comment("source")]);
    expect(loadComments(sessionKey(replacementSession.id))).toEqual([comment("destination")]);
    expect(state.reviewSendLocked).toBe(true);
    // No ownership transfer on failure, even if another surface later adopts the real session.
    state = { ...state, selectedSession: replacementSession };
    review.adoptSession("local", replacementSession.id);
    expect(state.reviewSendLocked).toBe(false);
    state = { ...state, selectedSession: temporary };
    review.adoptSession("local", temporary.id);
    expect(state.reviewSendLocked).toBe(true);
    review.abortSend(token);
    expect(state.reviewSendLocked).toBe(false);
    expect(review.list()).toEqual([comment("source")]);
    await expect(controller.send("retry")).resolves.toBe(false);
    controller.dispose();
  });

  it("does not retire a cached owner or migrate its draft/cache markers after failed review migration", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    rememberCachedNewSession(oldSession);
    const cached = markCachedNewSessionInfo(oldSession);
    saveComments(sessionKey(oldSession.id), [comment("source")]);
    saveComments(sessionKey(replacementSession.id), [comment("destination")]);
    saveDraft(sessionKey(oldSession.id), "cached draft");
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: cached, sessions: [cached] };
    const setState = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
    const review = new ReviewController(() => state, setState);
    review.adoptSession("local", oldSession.id);
    const token = review.beginSend();
    if (token === undefined) throw new Error("Expected send snapshot");
    rejectReplacementWrites(storage);
    const controller = new SessionController(() => state, setState, () => undefined, undefined, {
      api: {
        ...defaultApi, startSession: () => Promise.resolve(replacementSession),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
        messages: (session) => sessionLookupId(session) === oldSession.id ? Promise.reject(new Error("Session not found")) : Promise.resolve(emptyPage),
      },
      socket: new FakeSocket(), moveReviewComments: (from, to) => { review.renameSession(from, to); },
    });
    await controller.selectSession(cached, { updateUrl: false });
    expect(state.selectedSession?.id).toBe(oldSession.id);
    expect(state.sessions.map((session) => session.id)).toEqual([oldSession.id]);
    expect(isCachedNewSessionInfo(state.selectedSession)).toBe(true);
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([oldSession.id]);
    expect(loadDraft(sessionKey(oldSession.id))).toBe("cached draft");
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("");
    expect(loadComments(sessionKey(oldSession.id))).toEqual([comment("source")]);
    expect(loadComments(sessionKey(replacementSession.id))).toEqual([comment("destination")]);
    expect(Object.values(state.browserErrors).map((error) => error.message).join("\n")).toContain("original feedback was retained");
    review.abortSend(token);
    expect(state.reviewSendLocked).toBe(false);
    controller.dispose();
  });

  it("does not migrate discarded-start feedback into the real session", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const moveReviewComments = vi.fn(() => { throw new Error("discarded feedback must not migrate"); });
    const stop = vi.fn<typeof defaultApi.stop>().mockResolvedValue({ stopped: true });
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
      api: { ...defaultApi, startSession: () => startRequest.promise, stop }, socket: new FakeSocket(), moveReviewComments,
    });
    const start = controller.startSession();
    const temporary = state.selectedSession;
    if (temporary === undefined) throw new Error("Expected temporary owner");
    saveComments(sessionKey(temporary.id), [comment("discarded")]);
    saveComments(sessionKey(replacementSession.id), [comment("destination")]);
    await controller.deleteCachedNewSession(temporary);
    startRequest.resolve(replacementSession);
    await start;
    expect(moveReviewComments).not.toHaveBeenCalled();
    expect(loadComments(sessionKey(replacementSession.id))).toEqual([comment("destination")]);
    expect(state.selectedSession).toBeUndefined();
    expect(stop).toHaveBeenCalledWith(replacementSession, "local");
    controller.dispose();
  });
});
