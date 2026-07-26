import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, oldSession, runPendingAnimationFrames, sessionLookupId, status, workspace, type AppState, type SessionActivity, type SessionInfo } from "./sessionController.testSupport";

const REMOTE_MACHINE = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };

function startupActivity(patch: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: "backend-session",
    phase: "active",
    label: "Creating session",
    detail: "Starting the Pi session",
    at: "2026-07-20T00:00:01.000Z",
    ...patch,
  };
}

/** The end-of-window report: no phase left to name, so no detail either. */
function idleStartupActivity(): SessionActivity {
  return { sessionId: "backend-session", phase: "idle", label: "idle", at: "2026-07-20T00:00:02.000Z" };
}

function pendingStartController(state: { current: AppState }, api: Partial<typeof defaultApi> = {}) {
  const startRequest = deferred<SessionInfo>();
  const controller = new SessionController(
    () => state.current,
    (patch) => { state.current = { ...state.current, ...patch }; },
    () => undefined,
    undefined,
    {
      api: {
        ...defaultApi,
        startSession: () => startRequest.promise,
        messages: () => Promise.resolve(emptyPage),
        status: (session) => Promise.resolve(status(sessionLookupId(session))),
        ...api,
      },
      socket: new FakeSocket(),
    },
  );
  return { controller, startRequest };
}

describe("SessionController session startup progress", () => {
  it("shows the daemon's startup phase on a pending row while its start request is still open", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: startupActivity() });
    runPendingAnimationFrames();

    // The label changes while the user is waiting, before the start resolves,
    // and it is attributed to the row the user is actually looking at.
    expect(state.current.activity).toMatchObject({ sessionId: temporaryId, phase: "active", label: "Creating session", detail: "Starting the Pi session" });
    expect(state.current.sessionActivities[temporaryId]).toMatchObject({ detail: "Starting the Pi session" });

    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: startupActivity({ detail: "Loading session extensions" }) });
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("Loading session extensions");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("restores the generic wording when the daemon has nothing left to attribute", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");
    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: startupActivity() });
    runPendingAnimationFrames();

    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: idleStartupActivity() });
    runPendingAnimationFrames();

    expect(state.current.activity).toMatchObject({
      sessionId: temporaryId,
      phase: "active",
      label: "Creating session",
      detail: "Waiting for the backend session to be ready",
    });

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("restores the queued-message wording when a pending row has sends waiting", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    await controller.send("queued while starting");
    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: idleStartupActivity() });
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("1 queued message will send when the backend session is ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("applies startup progress for an existing session it already knows the id of", () => {
    let state: AppState = { ...initialAppState(), selectedSession: oldSession, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { socket: new FakeSocket() },
    );

    controller.applyGlobalEvent({
      type: "session.startup",
      cwd: oldSession.cwd,
      activity: startupActivity({ sessionId: oldSession.id, label: "Opening session" }),
    });
    runPendingAnimationFrames();

    expect(state.activity).toMatchObject({ sessionId: oldSession.id, label: "Opening session", detail: "Starting the Pi session" });
  });

  it("gives an existing session's startup its own row rather than a pending start in the same workspace", async () => {
    const existing = { ...oldSession, id: "existing-session", cwd: workspace.path };
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [existing] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    // Opening an existing session in the same workspace publishes the same cwd as
    // the pending create. The known id is the proof of which row it belongs to, so
    // the pending row must keep its own wording instead of the other row's phase.
    controller.applyGlobalEvent({
      type: "session.startup",
      cwd: workspace.path,
      activity: startupActivity({ sessionId: existing.id, label: "Opening session" }),
    });
    runPendingAnimationFrames();

    expect(state.current.sessionActivities[existing.id]).toMatchObject({ label: "Opening session", detail: "Starting the Pi session" });
    expect(state.current.sessionActivities[temporaryId]?.detail).toBe("Waiting for the backend session to be ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await start;
  });

  it("keeps the generic wording when the startup progress cannot be attributed to one row", async () => {
    const state = { current: { ...initialAppState(), selectedWorkspace: workspace, sessions: [] } };
    const { controller, startRequest } = pendingStartController(state);

    const start = controller.startSession();
    const temporaryId = state.current.selectedSession?.id;
    if (temporaryId === undefined) throw new Error("Expected temporary session id");

    // Another workspace's startup.
    controller.applyGlobalEvent({ type: "session.startup", cwd: "/elsewhere", activity: startupActivity() });
    // The selected machine's socket is the only feed for these events, so a cwd
    // that matches while another machine is selected belongs to a different row.
    state.current = { ...state.current, selectedMachine: REMOTE_MACHINE };
    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: startupActivity() });
    state.current = { ...state.current, selectedMachine: undefined };
    runPendingAnimationFrames();

    expect(state.current.activity?.detail).toBe("Waiting for the backend session to be ready");

    // A second concurrent start in the same workspace makes the target ambiguous,
    // so neither row is given a phase that might belong to the other.
    const secondStart = controller.startSession();
    controller.applyGlobalEvent({ type: "session.startup", cwd: workspace.path, activity: startupActivity() });
    runPendingAnimationFrames();

    const secondTemporaryId = state.current.selectedSession?.id;
    expect(secondTemporaryId).not.toBe(temporaryId);
    expect(state.current.sessionActivities[temporaryId]?.detail).toBe("Waiting for the backend session to be ready");
    expect(state.current.sessionActivities[secondTemporaryId ?? ""]?.detail).toBe("Waiting for the backend session to be ready");

    startRequest.resolve({ ...oldSession, id: "backend-session", path: "/tmp/backend-session.jsonl" });
    await Promise.all([start, secondStart]);
  });
});
