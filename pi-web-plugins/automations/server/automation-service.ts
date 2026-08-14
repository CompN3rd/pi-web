import { randomUUID } from "node:crypto";
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationModel,
  AutomationRun,
  AutomationScope,
  UpdateAutomationRequest,
} from "./contracts.js";
import {
  advanceAutomationNextRunAt,
  DEFAULT_AUTOMATION_ABORT_GRACE_MS,
  DEFAULT_AUTOMATION_TIMEOUT_MS,
  initialAutomationNextRunAt,
  MAX_AUTOMATION_TIMEOUT_MS,
  MIN_AUTOMATION_TIMEOUT_MS,
  validateAutomationTimeoutMs,
  validateAutomationTrigger,
} from "./automation-schedule.js";
import { AutomationSessionRunner, type CreatedAutomationSession } from "./automation-session-runner.js";
import { AutomationStore, isTerminalRunStatus } from "./automation-store.js";

const KNOWN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const POLL_INTERVAL_MS = 1_000;
const MAX_CONCURRENT_RUNS = 2;
const MAX_ERROR_LENGTH = 2_000;

export interface AutomationModels {
  models: AutomationModel[];
  thinkingLevels: string[];
  defaultTimeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
}

interface ActiveAutomationRun {
  runId: string;
  session?: CreatedAutomationSession;
  cancellationKind?: "user" | "timeout";
  timeout?: ReturnType<typeof setTimeout>;
  forceStopTimer?: ReturnType<typeof setTimeout>;
  abortStarted: boolean;
  abortPromise?: Promise<void>;
  promise?: Promise<void>;
}

export interface AutomationServiceLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

const noopLogger: AutomationServiceLogger = {
  info() { /* no-op */ },
  warn() { /* no-op */ },
  error() { /* no-op */ },
};

export class AutomationServiceError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 500 = 400) {
    super(message);
  }
}

export class AutomationService {
  private readonly active = new Map<string, ActiveAutomationRun>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopping = false;
  private storeClosed = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly runner: Pick<AutomationSessionRunner, "models" | "create" | "run" | "snapshot" | "abort" | "forceStop" | "release">,
    private readonly logger: AutomationServiceLogger = noopLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.pollTimer !== undefined) return;
    this.stopping = false;
    const recovered = this.store.recoverInterruptedRuns(this.nowIso());
    for (const run of recovered) {
      this.logger.warn({ runId: run.id, sessionId: run.sessionId }, "automation run became unknown after session daemon restart");
    }
    this.pollTimer = setInterval(() => { this.tick(); }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
    this.tick();
  }

  async stop(waitMs = DEFAULT_AUTOMATION_ABORT_GRACE_MS + 250): Promise<void> {
    this.stopping = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const context of this.active.values()) {
      if (context.timeout !== undefined) {
        clearTimeout(context.timeout);
        delete context.timeout;
      }
      const run = this.store.getRun(context.runId);
      if (run !== undefined && !isTerminalRunStatus(run.status)) {
        const cancelling = this.store.requestCancellation(run.id, "user", this.nowIso());
        context.cancellationKind = cancelling.cancellationKind ?? "user";
      } else {
        context.cancellationKind = "user";
      }
      void this.beginAbort(context);
    }
    await this.waitForActiveDrain(waitMs);
    await Promise.allSettled([...this.active.values()].map((context) => this.forceStop(context)));
  }

  dispose(): void {
    if (this.storeClosed) return;
    this.storeClosed = true;
    this.store.close();
  }

  list(scope: AutomationScope): AutomationDefinition[] {
    return this.store.listDefinitions(scope.projectId, scope.workspaceId);
  }

  listRuns(scope: AutomationScope, options?: { automationId?: string; limit?: number }): AutomationRun[] {
    if (options?.automationId !== undefined) this.requireDefinition(options.automationId, scope);
    return this.store.listRuns(scope.projectId, scope.workspaceId, options);
  }

  models(): AutomationModels {
    return {
      models: this.runner.models(),
      thinkingLevels: [...KNOWN_THINKING_LEVELS],
      defaultTimeoutMs: DEFAULT_AUTOMATION_TIMEOUT_MS,
      minTimeoutMs: MIN_AUTOMATION_TIMEOUT_MS,
      maxTimeoutMs: MAX_AUTOMATION_TIMEOUT_MS,
    };
  }

  create(scope: AutomationScope, draft: AutomationDraft): AutomationDefinition {
    const workspace = scope;
    const now = this.now();
    const trigger = validateAutomationTrigger(draft.trigger, now);
    const description = optionalText(draft.description, 500);
    const definition: AutomationDefinition = {
      id: randomUUID(),
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      name: requireText(draft.name, "name", 120),
      ...(description === undefined ? {} : { description }),
      prompt: requireText(draft.prompt, "prompt", 100_000),
      enabled: false,
      revision: 1,
      trigger,
      model: this.validateModelPolicy(draft.model),
      thinking: validateThinkingPolicy(draft.thinking),
      timeoutMs: validateAutomationTimeoutMs(draft.timeoutMs),
      abortGraceMs: DEFAULT_AUTOMATION_ABORT_GRACE_MS,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      const created = this.store.insertDefinition(definition);
      return created;
    } catch (error) {
      throw conflictFrom(error);
    }
  }

  update(id: string, request: UpdateAutomationRequest): AutomationDefinition {
    const workspace = request;
    const current = this.requireDefinition(id, request);
    if (current.revision !== request.expectedRevision) throw new AutomationServiceError("Automation was changed by another client", 409);

    const definitionChanged = request.name !== undefined
      || request.description !== undefined
      || request.prompt !== undefined
      || request.trigger !== undefined
      || request.model !== undefined
      || request.thinking !== undefined
      || request.timeoutMs !== undefined;
    if (definitionChanged && request.enabled === true) throw new AutomationServiceError("Test the updated automation before enabling it", 409);

    const now = this.now();
    let trigger = request.trigger === undefined ? current.trigger : validateAutomationTrigger(request.trigger, now);
    const enabled = request.enabled ?? (definitionChanged ? false : current.enabled);
    if (enabled) trigger = validateAutomationTrigger(trigger, now);
    if (enabled && current.testedRevision !== current.revision) throw new AutomationServiceError("Run this automation successfully before enabling it", 409);
    const revision = definitionChanged ? current.revision + 1 : current.revision;
    const updated: AutomationDefinition = {
      ...current,
      workspacePath: workspace.workspacePath,
      name: request.name === undefined ? current.name : requireText(request.name, "name", 120),
      prompt: request.prompt === undefined ? current.prompt : requireText(request.prompt, "prompt", 100_000),
      trigger,
      model: request.model === undefined ? current.model : this.validateModelPolicy(request.model),
      thinking: request.thinking === undefined ? current.thinking : validateThinkingPolicy(request.thinking),
      timeoutMs: request.timeoutMs === undefined ? current.timeoutMs : validateAutomationTimeoutMs(request.timeoutMs),
      enabled,
      revision,
      updatedAt: now.toISOString(),
    };
    if (request.description !== undefined) {
      delete updated.description;
      const description = optionalText(request.description, 500);
      if (description !== undefined) updated.description = description;
    }
    delete updated.nextRunAt;
    const nextRunAt = enabled ? initialAutomationNextRunAt(trigger, now) : undefined;
    if (nextRunAt !== undefined) updated.nextRunAt = nextRunAt;
    if (definitionChanged) delete updated.testedRevision;
    try {
      const saved = this.store.replaceDefinition(updated, request.expectedRevision);
      return saved;
    } catch (error) {
      throw conflictFrom(error);
    }
  }

  delete(id: string, scope: AutomationScope, expectedRevision: number): void {
    const definition = this.requireDefinition(id, scope);
    if (definition.revision !== expectedRevision) throw new AutomationServiceError("Automation was changed by another client", 409);
    try {
      if (!this.store.archiveDefinition(id, scope.projectId, scope.workspaceId, this.nowIso())) {
        throw new AutomationServiceError("Automation not found", 404);
      }
    } catch (error) {
      throw conflictFrom(error);
    }
  }

  runNow(id: string, scope: AutomationScope, expectedRevision: number): AutomationRun {
    const definition = this.requireDefinition(id, scope);
    if (definition.revision !== expectedRevision) throw new AutomationServiceError("Automation was changed by another client", 409);
    let run: AutomationRun;
    try {
      run = this.store.createManualRun(definition, randomUUID(), this.nowIso());
    } catch (error) {
      throw conflictFrom(error);
    }
    this.drainQueue();
    return run;
  }

  cancel(runId: string, scope: AutomationScope): AutomationRun {
    const existing = this.store.getRunScoped(runId, scope.projectId, scope.workspaceId);
    if (existing === undefined) throw new AutomationServiceError("Automation run not found", 404);
    const run = this.store.requestCancellation(runId, "user", this.nowIso());
    const context = this.active.get(runId);
    if (context !== undefined) {
      context.cancellationKind = run.cancellationKind ?? "user";
      if (context.timeout !== undefined) {
        clearTimeout(context.timeout);
        delete context.timeout;
      }
      void this.beginAbort(context);
    }
    return run;
  }

  private tick(): void {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const definition of this.store.listDueDefinitions(now.toISOString())) {
        try {
          const nextRunAt = advanceAutomationNextRunAt(definition.trigger, definition.nextRunAt ?? now.toISOString(), now);
          this.store.claimScheduledOccurrence(definition, nextRunAt, now.toISOString(), randomUUID());
        } catch (error) {
          this.logger.warn({ automationId: definition.id, err: error }, "could not claim scheduled automation occurrence");
        }
      }
      this.drainQueue();
    } finally {
      this.ticking = false;
    }
  }

  private drainQueue(): void {
    if (this.stopping) return;
    for (const run of this.store.listQueuedRuns(MAX_CONCURRENT_RUNS * 2)) {
      if (this.active.size >= MAX_CONCURRENT_RUNS) return;
      if (this.active.has(run.id)) continue;
      const context: ActiveAutomationRun = { runId: run.id, abortStarted: false };
      this.active.set(run.id, context);
      context.promise = this.execute(context).finally(() => {
        clearContextTimers(context);
        if (context.session !== undefined) void this.runner.release(context.session);
        this.active.delete(run.id);
        if (!this.stopping) this.drainQueue();
      });
    }
  }

  private async execute(context: ActiveAutomationRun): Promise<void> {
    const claimed = this.store.markRunStarting(context.runId, randomUUID(), this.nowIso());
    if (claimed === undefined) return;
    let run = claimed;
    try {
      if (this.isStoreClosed()) return;
      run = this.store.getRun(run.id) ?? run;
      if (run.status === "cancelling") {
        this.finishCancellation(run.id, run.cancellationKind ?? "user", undefined);
        return;
      }
      if (isTerminalRunStatus(run.status)) return;

      const session = await this.runner.create(
        { projectId: run.projectId, workspaceId: run.workspaceId, model: run.configuredModel, thinking: run.configuredThinking },
        (created) => { this.acceptCreatedSession(context, created); },
      );
      context.session = session;
      if (this.isStoreClosed() || this.active.get(context.runId) !== context) {
        await this.runner.forceStop(session).catch(() => undefined);
        return;
      }
      run = this.store.getRun(run.id) ?? run;
      if (isTerminalRunStatus(run.status)) {
        await this.runner.forceStop(session).catch(() => undefined);
        return;
      }
      const startedAt = this.now();
      run = this.store.markRunRunning(run.id, {
        sessionId: session.sessionId,
        ...(session.actualModel === undefined ? {} : { actualModel: session.actualModel }),
        ...(session.actualThinkingLevel === undefined ? {} : { actualThinkingLevel: session.actualThinkingLevel }),
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + run.timeoutMs).toISOString(),
      });
      context.timeout = setTimeout(() => { void this.timeoutRun(context); }, run.timeoutMs);
      context.timeout.unref();
      if (run.status === "cancelling") {
        context.cancellationKind = run.cancellationKind ?? "user";
        await this.beginAbort(context);
        if (this.isStoreClosed() || this.active.get(context.runId) !== context) return;
        const cancellationRun = this.store.getRun(run.id);
        if (cancellationRun === undefined || isTerminalRunStatus(cancellationRun.status)) return;
        const usage = await this.runner.snapshot(session, this.nowIso());
        if (this.isStoreClosed()) return;
        this.finishCancellation(run.id, context.cancellationKind, usage);
        return;
      }

      const usage = await this.runner.run(session, run.prompt, () => this.nowIso());
      if (this.isStoreClosed()) return;
      const latest = this.store.getRun(run.id) ?? run;
      if (latest.status === "cancelling" || context.cancellationKind !== undefined) {
        this.finishCancellation(run.id, latest.cancellationKind ?? context.cancellationKind ?? "user", usage);
      } else {
        this.store.finishRun(run.id, { status: "completed", completedAt: this.nowIso(), usage });
      }
    } catch (error) {
      if (this.isStoreClosed()) return;
      const latest = this.store.getRun(context.runId);
      if (latest === undefined || isTerminalRunStatus(latest.status)) return;
      const usage = context.session === undefined ? undefined : await this.runner.snapshot(context.session, this.nowIso());
      if (latest.status === "cancelling" || context.cancellationKind !== undefined) {
        this.finishCancellation(context.runId, latest.cancellationKind ?? context.cancellationKind ?? "user", usage);
      } else {
        this.store.finishRun(context.runId, {
          status: "failed",
          completedAt: this.nowIso(),
          error: errorMessage(error),
          reason: classifyFailure(error),
          ...(usage === undefined ? {} : { usage }),
        });
        this.logger.error({ runId: context.runId, err: error }, "automation run failed");
      }
    }
  }

  private async timeoutRun(context: ActiveAutomationRun): Promise<void> {
    const run = this.store.getRun(context.runId);
    if (run === undefined || isTerminalRunStatus(run.status)) return;
    const cancelling = this.store.requestCancellation(run.id, "timeout", this.nowIso());
    context.cancellationKind = cancelling.cancellationKind ?? "timeout";
    await this.beginAbort(context);
  }

  private acceptCreatedSession(context: ActiveAutomationRun, session: CreatedAutomationSession): void {
    context.session = session;
    if (this.active.get(context.runId) !== context) {
      void this.runner.forceStop(session).catch(() => undefined);
      return;
    }
    if (context.abortStarted) void this.beginAbort(context);
  }

  private async beginAbort(context: ActiveAutomationRun): Promise<void> {
    if (!context.abortStarted) {
      context.abortStarted = true;
      const run = this.store.getRun(context.runId);
      const graceMs = run === undefined ? DEFAULT_AUTOMATION_ABORT_GRACE_MS : this.store.getDefinition(run.automationId)?.abortGraceMs ?? DEFAULT_AUTOMATION_ABORT_GRACE_MS;
      context.forceStopTimer = setTimeout(() => {
        void this.forceStop(context).catch((error: unknown) => {
          this.logger.error({ runId: context.runId, err: error }, "automation force stop failed");
        });
      }, graceMs);
      context.forceStopTimer.unref();
    }
    if (context.session === undefined) return;
    context.abortPromise ??= this.runner.abort(context.session).catch((error: unknown) => {
      this.logger.warn({ runId: context.runId, err: error }, "automation soft abort failed");
    });
    await context.abortPromise;
  }

  private async forceStop(context: ActiveAutomationRun): Promise<void> {
    const run = this.store.getRun(context.runId);
    if (run === undefined || isTerminalRunStatus(run.status)) return;
    const usage = context.session === undefined ? undefined : await this.runner.snapshot(context.session, this.nowIso());
    if (context.session !== undefined) {
      try {
        await this.runner.forceStop(context.session);
      } catch (error) {
        this.logger.warn({ runId: context.runId, err: error }, "automation force stop failed");
      }
    }
    this.store.finishRun(context.runId, {
      status: "unknown",
      completedAt: this.nowIso(),
      reason: "force_stop_unconfirmed",
      error: "The run did not acknowledge cancellation before the force-stop deadline",
      forceStopped: true,
      ...(usage === undefined ? {} : { usage }),
    });
    clearContextTimers(context);
    if (this.active.get(context.runId) === context) this.active.delete(context.runId);
    if (!this.stopping) this.drainQueue();
  }

  private finishCancellation(runId: string, fallbackKind: "user" | "timeout", usage: Parameters<AutomationStore["finishRun"]>[1]["usage"]): void {
    const kind = this.store.getRun(runId)?.cancellationKind ?? fallbackKind;
    this.store.finishRun(runId, {
      status: kind === "timeout" ? "timed_out" : "cancelled",
      completedAt: this.nowIso(),
      reason: kind,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  private isStoreClosed(): boolean {
    return this.storeClosed;
  }

  private waitForActiveDrain(timeoutMs: number): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.active.size === 0 || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  private validateModelPolicy(model: AutomationDraft["model"]): AutomationDraft["model"] {
    if (model.mode === "default") return model;
    const provider = requireText(model.provider, "model provider", 120);
    const id = requireText(model.id, "model id", 240);
    const available = this.runner.models().find((candidate) => candidate.provider === provider && candidate.id === id);
    if (available === undefined) throw new AutomationServiceError(`Configured model is unavailable: ${provider}/${id}`, 409);
    return { mode: "fixed", provider, id, name: available.name };
  }

  private requireDefinition(id: string, scope: AutomationScope): AutomationDefinition {
    const definition = this.store.getDefinitionScoped(id, scope.projectId, scope.workspaceId);
    if (definition === undefined) throw new AutomationServiceError("Automation not found", 404);
    return definition;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function validateThinkingPolicy(thinking: AutomationDraft["thinking"]): AutomationDraft["thinking"] {
  if (thinking.mode === "default") return thinking;
  const level = requireText(thinking.level, "thinking level", 40);
  if (!KNOWN_THINKING_LEVELS.some((candidate) => candidate === level)) throw new AutomationServiceError(`Invalid thinking level: ${level}`);
  return { mode: "fixed", level };
}

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new AutomationServiceError(`${field} is required`);
  if (normalized.length > maxLength) throw new AutomationServiceError(`${field} must be at most ${String(maxLength)} characters`);
  return normalized;
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  if (normalized.length > maxLength) throw new AutomationServiceError(`Value must be at most ${String(maxLength)} characters`);
  return normalized;
}

function conflictFrom(error: unknown): AutomationServiceError {
  if (error instanceof AutomationServiceError) return error;
  const message = errorMessage(error);
  return new AutomationServiceError(message, /not found/iu.test(message) ? 404 : 409);
}

function classifyFailure(error: unknown): string {
  const message = errorMessage(error);
  if (/model|thinking|auth/iu.test(message)) return "configuration";
  if (/workspace|project/iu.test(message)) return "workspace_unavailable";
  return "execution_error";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

function clearContextTimers(context: ActiveAutomationRun): void {
  if (context.timeout !== undefined) clearTimeout(context.timeout);
  if (context.forceStopTimer !== undefined) clearTimeout(context.forceStopTimer);
}
