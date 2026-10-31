import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { SessionOperationGate } from "./sessionOperationGate.js";
import { PiSessionService, type PiAgentSession, type PiSessionManager, type PiSessionRuntime, type PiSessionServiceDependencies } from "./piSessionService.js";

class CapturingSessionEventHub extends SessionEventHub {
  readonly sessionEvents: { sessionId: string; event: SessionUiEvent }[] = [];
  readonly globalEvents: GlobalSessionEvent[] = [];

  override publish(sessionId: string, event: SessionUiEvent): void {
    this.sessionEvents.push({ sessionId, event });
  }

  override publishGlobal(event: GlobalSessionEvent): void {
    this.globalEvents.push(event);
  }
}

type SessionGateway = NonNullable<PiSessionServiceDependencies["sessionManager"]>;
type RuntimeCreator = NonNullable<PiSessionServiceDependencies["createAgentRuntime"]>;

interface TestSession extends PiAgentSession {
  sessionName: string | undefined;
  model: PiAgentSession["model"];
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  getSteeringMessages: () => readonly string[];
  getFollowUpMessages: () => readonly string[];
}

function fakeSessionManager(cwd = "/workspace"): PiSessionManager {
  return {
    getCwd: () => cwd,
    getBranch: () => [],
    getLeafId: () => "leaf-1",
  };
}

function sessionRecord(id: string, cwd = "/workspace") {
  return { id, path: `/sessions/${id}.jsonl`, cwd, created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date("2026-01-01T00:01:00.000Z"), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

function fakeRuntime(sessionId = "session-1", patch: Partial<TestSession> = {}) {
  const promptCalls: { text: string; options: unknown }[] = [];
  const calls = { abort: 0, clearQueue: 0, dispose: 0, prompt: promptCalls };
  const session: TestSession = {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    messages: [],
    sessionName: undefined,
    model: undefined,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    sessionManager: fakeSessionManager(),
    modelRegistry: ModelRegistry.create(AuthStorage.inMemory()),
    scopedModels: [],
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => undefined,
    bindExtensions: () => Promise.resolve(),
    getSessionStats: () => ({ sessionId, totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    prompt: (text: string, options: unknown) => {
      calls.prompt.push({ text, options });
      return Promise.resolve();
    },
    executeBash: () => Promise.resolve({ output: "", exitCode: 0, cancelled: false, truncated: false }),
    abort: () => {
      calls.abort += 1;
      return Promise.resolve();
    },
    clearQueue: () => {
      calls.clearQueue += 1;
      return { steering: [], followUp: [] };
    },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    setModel: () => Promise.resolve(),
    cycleModel: () => Promise.resolve(undefined),
    getAvailableThinkingLevels: () => [],
    setThinkingLevel: () => undefined,
    cycleThinkingLevel: () => undefined,
    setSessionName: (name: string) => { session.sessionName = name; },
    compact: () => Promise.resolve({ summary: "", tokensBefore: 0 }),
    getUserMessagesForForking: () => [],
    ...patch,
  };
  const runtime: PiSessionRuntime = {
    cwd: session.sessionManager.getCwd(),
    session,
    setRebindSession: () => undefined,
    fork: () => Promise.resolve({ cancelled: false }),
    dispose: () => {
      calls.dispose += 1;
      return Promise.resolve();
    },
  };
  return { runtime, session, calls };
}

function runtimeCreator(runtime: PiSessionRuntime): RuntimeCreator {
  return async () => {
    await Promise.resolve();
    return runtime;
  };
}

function sessionGateway(records: ReturnType<typeof sessionRecord>[]): SessionGateway {
  return {
    create: () => fakeSessionManager(),
    list: () => Promise.resolve(records),
    listAll: () => Promise.resolve(records),
    open: () => fakeSessionManager(),
  };
}

describe("PiSessionService", () => {
  it.each(["prompt", "shell", "compact"] as const)("retains admission for detached %s work even when SDK busy flags are false", async (kind) => {
    const operations = new SessionOperationGate();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeRuntime("busy-session", {
      prompt: () => pending,
      executeBash: async () => { await pending; return { output: "", exitCode: 0, cancelled: false, truncated: false }; },
      compact: async () => { await pending; return { summary: "", tokensBefore: 0 }; },
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      operationGate: operations,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("busy-session")]),
    });
    try {
      const accepted = kind === "prompt" ? service.prompt("busy-session", "hello")
        : kind === "shell" ? service.shell("busy-session", "!echo hello")
          : service.runCommand("busy-session", "/compact");
      // Admission is already held before archive/catalog lookup completes.
      await expect(operations.runExclusive(() => undefined)).rejects.toThrow("all session activity");
      await accepted;
      expect(fake.session.isStreaming || fake.session.isBashRunning || fake.session.isCompacting).toBe(false);
      await expect(operations.runExclusive(() => undefined)).rejects.toThrow("all session activity");
      release();
      await vi.waitFor(async () => { await expect(operations.runExclusive(() => undefined)).resolves.toBeUndefined(); });
    } finally {
      release();
      await service.dispose();
    }
  });

  it("retains admission for background naming after the prompt has finished", async () => {
    const operations = new SessionOperationGate();
    const modelRegistry = ModelRegistry.create(AuthStorage.inMemory());
    const model = modelRegistry.find("anthropic", "claude-3-5-sonnet-20241022");
    expect(model).toBeDefined();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const auth = vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockImplementation(async () => {
      await pending;
      throw new Error("No credentials in this test");
    });
    const fake = fakeRuntime("naming-session", { model });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      operationGate: operations, modelRegistry,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("naming-session")]),
    });
    try {
      await service.prompt("naming-session", "Name this session");
      expect(auth).toHaveBeenCalledTimes(1);
      await expect(operations.runExclusive(() => undefined)).rejects.toThrow("all session activity");
      release();
      await vi.waitFor(async () => { await expect(operations.runExclusive(() => undefined)).resolves.toBeUndefined(); });
      expect(fake.session.sessionName).toBe("Name this session");
    } finally {
      release();
      auth.mockRestore();
      await service.dispose();
    }
  });

  it("rejects prompt, shell, commands and saved-session opens during exclusive admission without starting a runtime", async () => {
    const operations = new SessionOperationGate();
    const fake = fakeRuntime();
    const createAgentRuntime = vi.fn(runtimeCreator(fake.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      operationGate: operations, createAgentRuntime,
      sessionManager: sessionGateway([sessionRecord("session-1")]),
    });
    try {
      await operations.runExclusive(async () => {
        await expect(service.prompt("session-1", "hello")).rejects.toThrow("reloading");
        await expect(service.shell("session-1", "!echo hello")).rejects.toThrow("reloading");
        await expect(service.runCommand("session-1", "/compact")).rejects.toThrow("reloading");
        await expect(service.status("session-1")).rejects.toThrow("reloading");
        expect(createAgentRuntime).not.toHaveBeenCalled();
      });
      await service.status("session-1");
      expect(createAgentRuntime).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
    }
  });

  it("coalesces concurrent saved-session opens, including ID prefixes, before runtime creation finishes", async () => {
    const fake = fakeRuntime("saved-session");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const createAgentRuntime = vi.fn(async () => { await ready; return fake.runtime; });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime, sessionManager: sessionGateway([sessionRecord("saved-session")]),
    });
    try {
      const requests = [service.status("saved-session"), service.commands("saved"), service.messages("saved-session")];
      await vi.waitFor(() => { expect(createAgentRuntime).toHaveBeenCalledTimes(1); });
      release();
      await Promise.all(requests);
      expect(createAgentRuntime).toHaveBeenCalledTimes(1);
      expect(service.activeCount()).toBe(1);
    } finally {
      release();
      await service.dispose();
    }
    expect(fake.calls.dispose).toBe(1);
  });

  it("allows retry after an open fails", async () => {
    const fake = fakeRuntime("saved-session");
    const createAgentRuntime = vi.fn()
      .mockRejectedValueOnce(new Error("creation failed"))
      .mockResolvedValue(fake.runtime);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime, sessionManager: sessionGateway([sessionRecord("saved-session")]),
    });
    try {
      await expect(service.status("saved-session")).rejects.toThrow("creation failed");
      expect(createAgentRuntime).toHaveBeenCalledTimes(1);
      await service.status("saved-session");
      expect(createAgentRuntime).toHaveBeenCalledTimes(2);
    } finally {
      await service.dispose();
    }
  });

  it("drains creation before disposal and rejects new runtime admission", async () => {
    const fake = fakeRuntime();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const createAgentRuntime = vi.fn(async () => { await ready; return fake.runtime; });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime, sessionManager: sessionGateway([]),
    });
    const starting = service.start("/workspace");
    const disposing = service.dispose();
    try {
      await expect(service.start("/workspace")).rejects.toThrow("disposed");
      await expect(service.status("session-1")).rejects.toThrow("disposed");
      expect(fake.calls.dispose).toBe(0);
      release();
      await starting;
      await disposing;
      expect(fake.calls.dispose).toBe(1);
      expect(service.activeCount()).toBe(0);
      expect(createAgentRuntime).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await disposing;
    }
  });

  it("does not create a runtime if disposal overtakes catalog lookup", async () => {
    const fake = fakeRuntime();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const gateway = sessionGateway([sessionRecord("session-1")]);
    const listAll = vi.fn(async () => { await ready; return [sessionRecord("session-1")]; });
    const createAgentRuntime = vi.fn(runtimeCreator(fake.runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime, sessionManager: { ...gateway, listAll },
    });
    const opening = service.status("session-1");
    try {
      await vi.waitFor(() => { expect(listAll).toHaveBeenCalledTimes(1); });
      await service.dispose();
      release();
      await expect(opening).rejects.toThrow("disposed");
      expect(createAgentRuntime).not.toHaveBeenCalled();
    } finally {
      release();
      await service.dispose();
    }
  });
  it("starts sessions through an injected runtime creator", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    let createCalls = 0;
    const createAgentRuntime: RuntimeCreator = async () => {
      createCalls += 1;
      await Promise.resolve();
      return fake.runtime;
    };
    const service = new PiSessionService(hub, {
      createAgentRuntime,
      sessionManager: sessionGateway([]),
      heartbeatIntervalMs: 60_000,
    });

    const session = await service.start("/workspace");

    expect(createCalls).toBe(1);
    expect(session).toMatchObject({ id: "session-1", cwd: "/workspace", messageCount: 0 });
    expect(service.activeCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "session-1")).toBe(true);

    await service.dispose();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("subscribes before binding extensions and waits for startup before exposing the session", async () => {
    const hub = new CapturingSessionEventHub();
    const order: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeRuntime("startup", {
      subscribe: () => { order.push("subscribe"); return () => undefined; },
      bindExtensions: async (bindings) => {
        order.push("bind");
        bindings.onError?.({ extensionPath: "test.ts", event: "session_start", error: "startup warning" });
        await ready;
      },
    });
    const service = new PiSessionService(hub, {
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([]),
    });
    try {
      const starting = service.start("/workspace");
      await vi.waitFor(() => { expect(order).toEqual(["subscribe", "bind"]); });
      let statusResolved = false;
      const status = service.status("startup").then(() => { statusResolved = true; });
      await Promise.resolve();
      expect(statusResolved).toBe(false);
      release();
      await starting;
      await status;
      expect(hub.sessionEvents).toContainEqual({ sessionId: "startup", event: { type: "session.error", message: "Extension test.ts: startup warning" } });
    } finally {
      release();
      await service.dispose();
    }
  });

  it("rebinds extension lifecycle after runtime replacement", async () => {
    const firstBind = vi.fn(() => Promise.resolve());
    const nextBind = vi.fn(() => Promise.resolve());
    const fake = fakeRuntime("first", { bindExtensions: firstBind });
    const next = fakeRuntime("next", { bindExtensions: nextBind });
    let rebind: ((session: PiAgentSession) => Promise<void>) | undefined;
    const runtime = { ...fake.runtime, setRebindSession: (callback?: (session: PiAgentSession) => Promise<void>) => { rebind = callback; } };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(runtime), sessionManager: sessionGateway([]),
    });
    try {
      await service.start("/workspace");
      runtime.session = next.session;
      await rebind?.(next.session);
      expect(firstBind).toHaveBeenCalledTimes(1);
      expect(nextBind).toHaveBeenCalledTimes(1);
      expect((await service.status("next")).sessionId).toBe("next");
      expect(service.activeCount()).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it("disposes a runtime whose extension binding fails", async () => {
    const unsubscribe = vi.fn();
    const fake = fakeRuntime("failed", {
      subscribe: () => unsubscribe,
      bindExtensions: () => Promise.reject(new Error("resource discovery failed")),
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime), sessionManager: sessionGateway([]),
    });
    try {
      await expect(service.start("/workspace")).rejects.toThrow("resource discovery failed");
      expect(service.activeCount()).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(fake.calls.abort).toBe(1);
      expect(fake.calls.dispose).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  it("clears stale active activity once a previously active session becomes idle", async () => {
    vi.useFakeTimers();
    let service: PiSessionService | undefined;
    try {
      const hub = new CapturingSessionEventHub();
      let listener: ((event: unknown) => void) | undefined;
      const fake = fakeRuntime("idle-session", {
        isStreaming: true,
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
      });
      service = new PiSessionService(hub, {
        createAgentRuntime: runtimeCreator(fake.runtime),
        sessionManager: sessionGateway([sessionRecord("idle-session")]),
        heartbeatIntervalMs: 1_000,
      });

      await service.status("idle-session");
      hub.globalEvents.length = 0;
      listener?.({ type: "agent_start" });

      const activityPhases = () => hub.globalEvents
        .filter((event) => event.type === "activity.update")
        .map((event) => event.activity.phase);
      expect(activityPhases()).toEqual(["active"]);

      fake.session.isStreaming = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(activityPhases()).toEqual(["active", "idle"]);
    } finally {
      await service?.dispose();
      vi.useRealTimers();
    }
  });

  it("publishes idle activity for SDK completion events", async () => {
    const hub = new CapturingSessionEventHub();
    let listener: ((event: unknown) => void) | undefined;
    const fake = fakeRuntime("completion-session", {
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    const service = new PiSessionService(hub, {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("completion-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("completion-session");
    hub.globalEvents.length = 0;
    listener?.({ type: "tool_execution_end", toolName: "read", isError: false });

    expect(hub.globalEvents.filter((event) => event.type === "activity.update")).toMatchObject([
      { activity: { sessionId: "completion-session", phase: "idle", label: "tool complete", detail: "read" } },
    ]);

    await service.dispose();
  });

  it("uses injected archive and session-manager gateways for listing", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }]),
        get: () => Promise.resolve(undefined),
        archive: () => Promise.resolve({ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" }),
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([
          { ...sessionRecord("active"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" },
          { ...sessionRecord("archived"), messageCount: 2, firstMessage: "bye", allMessagesText: "bye" },
        ]),
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active" });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", archived: true, archivedAt: "2026-01-01T00:00:00.000Z" });

    await service.dispose();
  });

  it("lists archived records that have been moved out of the active session directory", async () => {
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 2, firstMessage: "bye" }]),
        get: () => Promise.resolve(undefined),
        archive: () => { throw new Error("archive should not be called for moved records"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([{ ...sessionRecord("active"), messageCount: 1, firstMessage: "hello", allMessagesText: "hello" }]),
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "active" });
    expect(sessions[0]?.archived).toBeUndefined();
    expect(sessions[1]).toMatchObject({ id: "archived", path: "/sessions/archived.jsonl", archived: true, archivedAt: "2026-01-02T00:00:00.000Z" });

    await service.dispose();
  });

  it("archives a session subtree within the root workspace", async () => {
    const archivedInputs: string[] = [];
    const root = sessionRecord("root");
    const directChild = { ...sessionRecord("direct-child"), path: "/sessions/direct-child.jsonl", parentSessionPath: root.path };
    const archivedChild = { ...sessionRecord("archived-child"), path: "/sessions/archived-child.jsonl", parentSessionPath: root.path };
    const grandchild = { ...sessionRecord("grandchild"), path: "/sessions/grandchild.jsonl", parentSessionPath: archivedChild.path };
    const otherWorkspaceChild = { ...sessionRecord("other-child", "/other"), path: "/sessions/other-child.jsonl", parentSessionPath: root.path };
    const fake = fakeRuntime("root", { sessionFile: root.path });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived-child", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: archivedChild.path, archivePath: "/archive/archived-child.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 1, firstMessage: "archived", parentSessionPath: root.path }]),
        get: () => Promise.resolve(undefined),
        archive: (input) => {
          archivedInputs.push(input.sessionId);
          return Promise.resolve({ sessionId: input.sessionId, cwd: input.cwd, archivedAt: "2026-01-03T00:00:00.000Z" });
        },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd) => Promise.resolve(cwd === "/workspace" ? [root, directChild, archivedChild, grandchild] : [otherWorkspaceChild]),
        listAll: () => Promise.resolve([root, directChild, archivedChild, grandchild, otherWorkspaceChild]),
        open: () => fakeSessionManager(),
      },
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.archiveTree("root")).resolves.toEqual({
      archived: true,
      sessionIds: ["root", "direct-child", "grandchild"],
      archivedCount: 3,
      skippedAlreadyArchivedCount: 1,
    });
    expect(archivedInputs).toEqual(["root", "direct-child", "grandchild"]);

    await service.dispose();
  });

  it("reconciles workspace activity when listing only archived sessions", async () => {
    const reconciliations: { cwd: string; sessionIds: string[] }[] = [];
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      archiveStore: {
        list: () => Promise.resolve([{ sessionId: "archived", cwd: "/workspace", archivedAt: "2026-01-02T00:00:00.000Z", originalPath: "/sessions/archived.jsonl", archivePath: "/archive/archived.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 2, firstMessage: "bye" }]),
        get: () => Promise.resolve(undefined),
        archive: () => { throw new Error("archive should not be called for moved records"); },
        restore: () => Promise.resolve(),
        isArchived: () => Promise.resolve(false),
      },
      sessionManager: {
        create: () => fakeSessionManager(),
        list: () => Promise.resolve([]),
        listAll: () => Promise.resolve([]),
        open: () => fakeSessionManager(),
      },
      workspaceActivity: {
        applySessionStatus: () => undefined,
        applySessionActivity: () => undefined,
        removeSession: () => undefined,
        reconcileSessionActivity: (cwd, sessionIds) => { reconciliations.push({ cwd, sessionIds: [...sessionIds] }); },
      },
      heartbeatIntervalMs: 60_000,
    });

    const sessions = await service.list("/workspace");

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "archived", archived: true });
    expect(reconciliations).toEqual([{ cwd: "/workspace", sessionIds: [] }]);

    await service.dispose();
  });

  it("sends prompts to an injected runtime without touching the SDK runtime", async () => {
    const fake = fakeRuntime("prompt-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("prompt-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("prompt-session", "Build the thing");

    expect(fake.calls.prompt).toEqual([{ text: "Build the thing", options: undefined }]);
    await service.dispose();
  });

  it("includes queued message details in session status", async () => {
    const fake = fakeRuntime("status-session", {
      pendingMessageCount: 2,
      getSteeringMessages: () => ["adjust this turn"],
      getFollowUpMessages: () => ["then do this"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("status-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await expect(service.status("status-session")).resolves.toMatchObject({
      pendingMessageCount: 2,
      queuedMessages: [{ kind: "steer", text: "adjust this turn" }, { kind: "followUp", text: "then do this" }],
    });
    await service.dispose();
  });

  it("does not enqueue duplicate queued message text", async () => {
    const fake = fakeRuntime("dedupe-session", {
      isStreaming: true,
      pendingMessageCount: 1,
      getFollowUpMessages: () => ["already queued"],
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("dedupe-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("dedupe-session", "already queued", "followUp");

    expect(fake.calls.prompt).toEqual([]);
    await service.dispose();
  });

  it("does not append queued prompts to the transcript before delivery", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("queued-session", { isStreaming: true });
    const service = new PiSessionService(hub, {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("queued-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.prompt("queued-session", "Wait for the current turn", "followUp");

    expect(fake.calls.prompt).toEqual([{ text: "Wait for the current turn", options: { streamingBehavior: "followUp" } }]);
    expect(hub.sessionEvents.some(({ event }) => event.type === "message.append")).toBe(false);
    await service.dispose();
  });

  it("clears queued messages when aborting active work", async () => {
    const fake = fakeRuntime("abort-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("abort-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("abort-session");
    await service.abort("abort-session");

    expect(fake.calls.clearQueue).toBe(1);
    expect(fake.calls.abort).toBe(1);
    await service.dispose();
  });

  it("refreshes auth state and dedupes warnings when logout removes the current model's credentials", async () => {
    const hub = new CapturingSessionEventHub();
    const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sk-test" } });
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find("anthropic", "claude-3-5-sonnet-20241022");
    if (model === undefined) throw new Error("Expected Anthropic model fixture");
    const fake = fakeRuntime("auth-session", { model, modelRegistry });

    const service = new PiSessionService(hub, {
      modelRegistry,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("auth-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("auth-session");
    hub.sessionEvents.length = 0;
    hub.globalEvents.length = 0;

    authStorage.logout("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    service.applyAuthChange({ removedProviderId: "anthropic" });

    const warningCount = () => hub.sessionEvents.filter(({ event }) => event.type === "command.output" && event.level === "error" && event.message.includes("anthropic/claude-3-5-sonnet-20241022")).length;
    expect(warningCount()).toBe(1);
    expect(hub.globalEvents.some((event) => event.type === "status.update" && event.status.sessionId === "auth-session")).toBe(true);

    authStorage.set("anthropic", { type: "api_key", key: "sk-new" });
    service.applyAuthChange();
    authStorage.logout("anthropic");
    service.applyAuthChange({ removedProviderId: "anthropic" });
    expect(warningCount()).toBe(2);

    await service.dispose();
  });

  it("clears queued messages when stopping a session runtime", async () => {
    const fake = fakeRuntime("stop-session");
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway([sessionRecord("stop-session")]),
      heartbeatIntervalMs: 60_000,
    });

    await service.status("stop-session");
    service.stop("stop-session");

    expect(fake.calls.clearQueue).toBe(1);
    await service.dispose();
  });
});
