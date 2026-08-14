export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const AUTOMATIONS_CONTRACT_VERSION = 1;
export const AUTOMATIONS_OPERATIONS = Object.freeze({
  snapshot: "snapshot",
  create: "create",
  update: "update",
  delete: "delete",
  runNow: "run-now",
  cancelRun: "cancel-run",
} as const);

export type AutomationTrigger =
  | { type: "manual" }
  | { type: "once"; at: string }
  | { type: "interval"; intervalMs: number }
  | { type: "cron"; expression: string; timeZone: string };
export type AutomationModelPolicy =
  | { mode: "default" }
  | { mode: "fixed"; provider: string; id: string; name?: string };
export type AutomationThinkingPolicy =
  | { mode: "default" }
  | { mode: "fixed"; level: string };
export type AutomationRunSource = "manual" | "scheduled";
export type AutomationRunStatus = "queued" | "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "skipped" | "unknown";
export type AutomationAttemptStatus = "starting" | "running" | "aborting" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
export type AutomationUsageQuality = "estimated" | "partial" | "provider_reported" | "unknown";

export interface AutomationModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: readonly string[];
}
export interface AutomationUsageSnapshot {
  scope: "root_session";
  quality: AutomationUsageQuality;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  estimatedCostMicros?: number;
  capturedAt: string;
}
export interface AutomationDefinition {
  id: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  name: string;
  description?: string;
  prompt: string;
  enabled: boolean;
  revision: number;
  testedRevision?: number;
  trigger: AutomationTrigger;
  model: AutomationModelPolicy;
  thinking: AutomationThinkingPolicy;
  timeoutMs: number;
  abortGraceMs: number;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface AutomationAttempt {
  id: string;
  runId: string;
  attemptNumber: number;
  status: AutomationAttemptStatus;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  forceStopped: boolean;
  usage?: AutomationUsageSnapshot;
}
export interface AutomationRun {
  id: string;
  automationId: string;
  automationRevision: number;
  automationName: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  source: AutomationRunSource;
  scheduledFor: string;
  status: AutomationRunStatus;
  prompt: string;
  trigger: AutomationTrigger;
  configuredModel: AutomationModelPolicy;
  configuredThinking: AutomationThinkingPolicy;
  actualModel?: AutomationModel;
  actualThinkingLevel?: string;
  timeoutMs: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  cancelRequestedAt?: string;
  cancellationKind?: "user" | "timeout";
  sessionId?: string;
  reason?: string;
  error?: string;
  usage?: AutomationUsageSnapshot;
  attempt?: AutomationAttempt;
}
export interface AutomationDraft {
  name: string;
  description?: string;
  prompt: string;
  trigger: AutomationTrigger;
  model: AutomationModelPolicy;
  thinking: AutomationThinkingPolicy;
  timeoutMs?: number;
}
export interface AutomationPatch {
  name?: string;
  description?: string;
  prompt?: string;
  trigger?: AutomationTrigger;
  model?: AutomationModelPolicy;
  thinking?: AutomationThinkingPolicy;
  timeoutMs?: number;
  enabled?: boolean;
}
export interface AutomationError { code: string; message: string }
export type AutomationEnvelope<T extends JsonValue = JsonValue> =
  | { contractVersion: 1; ok: true; value: T }
  | { contractVersion: 1; ok: false; error: AutomationError };

export function parseAutomationEnvelope(value: JsonValue): AutomationEnvelope {
  if (!isRecord(value) || value["contractVersion"] !== AUTOMATIONS_CONTRACT_VERSION || typeof value["ok"] !== "boolean") {
    throw new Error("Invalid Automations backend response");
  }
  if (value["ok"]) {
    if (!("value" in value) || !isJsonValue(value["value"])) throw new Error("Invalid Automations success response");
    return { contractVersion: 1, ok: true, value: value["value"] };
  }
  const error = value["error"];
  if (!isRecord(error) || typeof error["code"] !== "string" || typeof error["message"] !== "string") {
    throw new Error("Invalid Automations error response");
  }
  return { contractVersion: 1, ok: false, error: { code: error["code"], message: error["message"] } };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
