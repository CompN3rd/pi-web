import type { JsonValue, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  AutomationsController,
  availableThinkingLevels,
  type TimerApi,
} from "./browser/automations-controller.js";
import { AUTOMATIONS_OPERATIONS, type AutomationDefinition, type AutomationRun, type AutomationSnapshot } from "./browser/contracts.js";

const definition: AutomationDefinition = {
  id: "automation-1", projectId: "project-1", workspaceId: "workspace-1", workspacePath: "/repo", name: "Daily review", prompt: "Review changes", enabled: false,
  revision: 1, testedRevision: 1, trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 600_000, abortGraceMs: 5_000,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const run: AutomationRun = {
  id: "run-1", automationId: definition.id, automationRevision: 1, automationName: definition.name, projectId: definition.projectId, workspaceId: definition.workspaceId,
  workspacePath: definition.workspacePath, source: "manual", scheduledFor: "2026-01-01T00:00:00.000Z", status: "running", prompt: definition.prompt,
  trigger: definition.trigger, configuredModel: definition.model, configuredThinking: definition.thinking, timeoutMs: definition.timeoutMs, queuedAt: "2026-01-01T00:00:00.000Z",
};

function snapshot(runs: AutomationRun[] = []): AutomationSnapshot {
  return {
    definitions: [definition], runs,
    models: [{ provider: "anthropic", id: "sonnet", name: "Sonnet", thinkingLevels: ["low", "high"] }],
    thinkingLevels: ["off", "low", "high"], defaultTimeoutMs: 600_000, minTimeoutMs: 60_000, maxTimeoutMs: 86_400_000,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function success(value: unknown): JsonValue {
  return { contractVersion: 1, ok: true, value: json(value) };
}

function context(request: (operation: string, input: JsonValue) => Promise<JsonValue>, machineId = "local", workspaceId = "workspace-1") {
  const requestRender = vi.fn();
  const value: WorkspacePanelContext = {
    machine: { id: machineId, name: machineId, kind: "local" },
    workspace: { id: workspaceId, projectId: "project-1", path: "/repo", label: workspaceId, isMain: true },
    files: fileMethods(),
    backend: { request },
    host: { requestRender },
    prompt: { insertText() { return undefined; }, getText: () => "", getSelection: () => null },
    terminal: { open() { return undefined; }, runCommand: () => Promise.reject(new Error("not used")) },
  };
  return { value, requestRender };
}

describe("AutomationsController", () => {
  it("polls at active and idle rates, then cleans up on disconnect", async () => {
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const timers: TimerApi = {
      setTimeout: (_callback, delay) => { delays.push(delay); return longTimer(() => undefined, 60_000); },
      clearTimeout: (handle) => { cleared.push(handle); clearTimeout(handle); },
    };
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot([run])));
    const target = context(backend);
    const controller = new AutomationsController(timers);

    controller.connect(target.value);
    await controller.refresh(target.value);
    expect(delays.at(-1)).toBe(ACTIVE_POLL_INTERVAL_MS);

    backend.mockResolvedValue(success(snapshot()));
    await controller.refresh(target.value);
    expect(delays.at(-1)).toBe(IDLE_POLL_INTERVAL_MS);

    controller.disconnect(target.value);
    expect(cleared.length).toBeGreaterThan(0);
  });

  it("pauses while hidden and refreshes when visibility returns", async () => {
    const timers = timerFixture();
    const backend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot()));
    const target = context(backend);
    const controller = new AutomationsController(timers.api);
    controller.connect(target.value);
    await controller.refresh(target.value);
    const before = backend.mock.calls.length;

    controller.visibilityChanged(target.value, false);
    expect(timers.cleared).toBeGreaterThan(0);
    controller.visibilityChanged(target.value, true);
    await controller.refresh(target.value);
    expect(backend.mock.calls.length).toBeGreaterThan(before);
  });

  it("fences an old machine response after the target changes", async () => {
    let resolveOld: ((value: JsonValue) => void) | undefined;
    const oldBackend = vi.fn(() => new Promise<JsonValue>((resolve) => { resolveOld = resolve; }));
    const newBackend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue(success(snapshot()));
    const oldTarget = context(oldBackend, "old");
    const newTarget = context(newBackend, "new");
    const controller = new AutomationsController(timerFixture().api);

    controller.connect(oldTarget.value);
    controller.connect(newTarget.value);
    await controller.refresh(newTarget.value);
    resolveOld?.(success(snapshot([run])));
    await Promise.resolve(); await Promise.resolve();

    expect(controller.state(oldTarget.value).snapshot).toBeUndefined();
    expect(controller.state(newTarget.value).snapshot?.runs).toEqual([]);
  });

  it("uses exact scoped backend envelopes for create, edit, run, enable, delete, and cancel", async () => {
    const calls: [string, JsonValue][] = [];
    const backend = vi.fn((operation: string, input: JsonValue): Promise<JsonValue> => {
      calls.push([operation, input]);
      if (operation === AUTOMATIONS_OPERATIONS.snapshot) return Promise.resolve(success(snapshot()));
      if (operation === AUTOMATIONS_OPERATIONS.delete) return Promise.resolve(success({ deleted: true }));
      if (operation === AUTOMATIONS_OPERATIONS.runNow || operation === AUTOMATIONS_OPERATIONS.cancelRun) return Promise.resolve(success(run));
      return Promise.resolve(success(definition));
    });
    const target = context(backend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(target.value);
    await controller.refresh(target.value);

    controller.beginCreate(target.value);
    controller.updateEditor(target.value, { name: "New", prompt: "Do it" });
    await controller.saveEditor(target.value);
    controller.beginEdit(target.value, definition);
    controller.updateEditor(target.value, { prompt: "Changed" });
    await controller.saveEditor(target.value);
    await controller.runNow(target.value, definition);
    await controller.setEnabled(target.value, definition, true);
    await controller.delete(target.value, definition);
    await controller.cancelRun(target.value, run);

    const mutations = calls.filter(([operation]) => operation !== AUTOMATIONS_OPERATIONS.snapshot);
    expect(mutations.map(([operation]) => operation)).toEqual(["create", "update", "run-now", "update", "delete", "cancel-run"]);
    expect(mutations[0]?.[1]).toEqual({ contractVersion: 1, draft: { name: "New", prompt: "Do it", trigger: { type: "manual" }, model: { mode: "default" }, thinking: { mode: "default" }, timeoutMs: 600_000 } });
    expect(mutations[1]?.[1]).toMatchObject({ contractVersion: 1, automationId: "automation-1", expectedRevision: 1, patch: { prompt: "Changed" } });
    for (const [, input] of mutations) {
      expect(JSON.stringify(input)).not.toMatch(/projectId|workspaceId|workspacePath|machine|cwd/u);
    }
    expect(target.requestRender).toHaveBeenCalled();
  });

  it("surfaces domain and malformed response errors", async () => {
    const domainBackend = vi.fn<(operation: string, input: JsonValue) => Promise<JsonValue>>().mockResolvedValue({ contractVersion: 1, ok: false, error: { code: "conflict", message: "revision changed" } });
    const domainTarget = context(domainBackend);
    const controller = new AutomationsController(timerFixture().api);
    controller.connect(domainTarget.value);
    await controller.refresh(domainTarget.value);
    expect(controller.state(domainTarget.value).error).toBe("revision changed");

    const malformedTarget = context(() => Promise.resolve({ ok: true, value: null }));
    controller.connect(malformedTarget.value);
    await controller.refresh(malformedTarget.value);
    expect(controller.state(malformedTarget.value).error).toContain("Invalid Automations backend response");
  });

  it("filters thinking levels to the selected model", () => {
    expect(availableThinkingLevels(snapshot(), { mode: "fixed", provider: "anthropic", id: "sonnet" })).toEqual(["low", "high"]);
    expect(availableThinkingLevels(snapshot(), { mode: "fixed", provider: "other", id: "missing" })).toEqual([]);
    expect(availableThinkingLevels(snapshot(), { mode: "default" })).toEqual(["off", "low", "high"]);
  });
});

function timerFixture(): { api: TimerApi; cleared: number } {
  const fixture = {
    cleared: 0,
    api: {
      setTimeout: (callback: () => void, delay: number) => longTimer(callback, 60_000 + delay),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => { fixture.cleared += 1; clearTimeout(handle); },
    },
  };
  return fixture;
}

function longTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const handle = setTimeout(callback, delay);
  handle.unref();
  return handle;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]));
  throw new Error("not JSON");
}

function fileMethods(): WorkspacePanelContext["files"] {
  const unused = (): Promise<never> => Promise.reject(new Error("not used"));
  return { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused };
}
