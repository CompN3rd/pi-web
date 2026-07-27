import { isAbsolute } from "node:path";
import type { ServerPluginHealth } from "../../server-plugin-api.js";
import type { ServerPluginSafeStart } from "../../serverPluginRecovery.js";
import type { JsonObject, JsonValue, Workspace } from "../../shared/apiTypes.js";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import type {
  ServerPluginHealthInspection,
  ServerPluginLifecyclePhase,
  ServerPluginRuntimeRecord,
  ServerPluginRuntimeState,
} from "../plugins/serverPluginRuntime.js";
import {
  WorkspaceCatalogProtocolError,
  WorkspaceCatalogRequestError,
  WorkspaceCatalogUnavailableError,
  type WorkspaceCatalog,
  type WorkspaceProviderRuntimeSnapshot,
  withBrowserV1WorkspaceCompatibility,
} from "./workspaceCatalog.js";

const WORKSPACE_CATALOG_PATH = "/workspace-catalog";

/** Narrow web adapter over sessiond's internal workspace-authority protocol. */
export class SessionDaemonWorkspaceCatalog implements WorkspaceCatalog {
  constructor(private readonly daemon: SessionDaemonRequestClient) {}

  async list(projectId: string): Promise<Workspace[]> {
    const value = await this.requestJson(`${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces`);
    if (!isRecord(value)) throw protocolError("workspace list response must be an object");
    return parseWorkspaceList(value["workspaces"], projectId).map(withBrowserV1WorkspaceCompatibility);
  }

  async resolve(projectId: string, workspaceId: string): Promise<Workspace> {
    const value = await this.requestJson(
      `${WORKSPACE_CATALOG_PATH}/projects/${encodedId(projectId, "project")}/workspaces/${encodedId(workspaceId, "workspace")}`,
    );
    const workspace = parseWorkspace(value, "workspace resolution response");
    if (workspace.projectId !== projectId || workspace.id !== workspaceId) {
      throw protocolError("workspace resolution response did not match the requested project and workspace");
    }
    return withBrowserV1WorkspaceCompatibility(workspace);
  }

  async providerRuntime(): Promise<WorkspaceProviderRuntimeSnapshot> {
    return parseProviderRuntimeSnapshot(await this.requestJson(`${WORKSPACE_CATALOG_PATH}/provider-runtime`));
  }

  private async requestJson(path: string): Promise<unknown> {
    let response: Awaited<ReturnType<SessionDaemonRequestClient["request"]>>;
    try {
      response = await this.daemon.request("GET", path);
    } catch (error) {
      throw new WorkspaceCatalogUnavailableError(
        `Session daemon workspace authority unavailable: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (isUnknownWorkspaceCatalogRoute(response.statusCode, response.body)) {
        throw new WorkspaceCatalogProtocolError(
          "Session daemon does not support workspace authority operations; restart or upgrade the session daemon",
        );
      }
      throw new WorkspaceCatalogRequestError(
        workspaceCatalogRequestMessage(response.statusCode, response.body),
        response.statusCode,
      );
    }

    try {
      if (response.body === "") return undefined;
      const value: unknown = JSON.parse(response.body);
      return value;
    } catch (error) {
      throw new WorkspaceCatalogProtocolError("Session daemon workspace authority returned invalid JSON", { cause: error });
    }
  }
}

function parseWorkspaceList(value: unknown, projectId: string): Workspace[] {
  if (!Array.isArray(value) || value.length === 0) throw protocolError("workspace list must be a non-empty array");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const workspaces = value.map((item, index) => parseWorkspace(item, `workspace list item ${String(index + 1)}`));
  let mainCount = 0;
  for (const workspace of workspaces) {
    if (workspace.projectId !== projectId) throw protocolError("workspace list contained a workspace for another project");
    if (ids.has(workspace.id)) throw protocolError(`workspace list contained duplicate id: ${workspace.id}`);
    if (paths.has(workspace.path)) throw protocolError(`workspace list contained duplicate path: ${workspace.path}`);
    ids.add(workspace.id);
    paths.add(workspace.path);
    if (workspace.isMain) mainCount += 1;
  }
  if (mainCount !== 1) throw protocolError("workspace list must contain exactly one main workspace");
  return workspaces;
}

function parseWorkspace(value: unknown, label: string): Workspace {
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const path = requireString(value, "path", label);
  if (!isAbsolute(path)) throw protocolError(`${label} path must be absolute`);
  const branch = optionalString(value, "branch", label);
  const provider = value["provider"] === undefined ? undefined : parseProvider(value["provider"], label);
  const removal = value["removal"] === undefined ? undefined : parseRemoval(value["removal"], label);
  return {
    id: requireString(value, "id", label),
    projectId: requireString(value, "projectId", label),
    path,
    label: requireString(value, "label", label),
    ...(branch === undefined ? {} : { branch }),
    isMain: requireBoolean(value, "isMain", label),
    isGitRepo: requireBoolean(value, "isGitRepo", label),
    isGitWorktree: requireBoolean(value, "isGitWorktree", label),
    ...(provider === undefined ? {} : { provider }),
    ...(removal === undefined ? {} : { removal }),
  };
}

function parseProvider(value: unknown, workspaceLabel: string): NonNullable<Workspace["provider"]> {
  const label = `${workspaceLabel} provider`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const capabilities = value["capabilities"];
  if (!isRecord(capabilities)) throw protocolError(`${label} capabilities must be an object`);
  const metadata = value["metadata"] === undefined ? undefined : parseJsonObject(value["metadata"], `${label} metadata`);
  return {
    pluginId: requireString(value, "pluginId", label),
    capabilities: {
      request: requireBoolean(capabilities, "request", `${label} capabilities`),
      remove: requireBoolean(capabilities, "remove", `${label} capabilities`),
    },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseRemoval(value: unknown, workspaceLabel: string): NonNullable<Workspace["removal"]> {
  const label = `${workspaceLabel} removal`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  return {
    actionLabel: requireString(value, "actionLabel", label),
    confirmation: requireString(value, "confirmation", label),
  };
}

function parseProviderRuntimeSnapshot(value: unknown): WorkspaceProviderRuntimeSnapshot {
  if (!isRecord(value)) throw protocolError("provider runtime response must be an object");
  const safeStart = parseSafeStart(value["safeStart"]);
  const records = parseArray(value["records"], "provider runtime records", parseRuntimeRecord);
  const health = parseArray(value["health"], "provider runtime health", parseHealthInspection);
  return Object.freeze({
    ...(safeStart === undefined ? {} : { safeStart }),
    records: Object.freeze(records),
    health: Object.freeze(health),
  });
}

function parseRuntimeRecord(value: unknown, index: number): ServerPluginRuntimeRecord {
  const label = `provider runtime record ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const state = value["state"];
  const scope = value["scope"];
  const phase = value["phase"];
  if (!isRuntimeState(state)) throw protocolError(`${label} state is invalid`);
  if (scope !== "bundled" && scope !== "local" && scope !== "user" && scope !== "project") {
    throw protocolError(`${label} scope is invalid`);
  }
  if (phase !== undefined && !isLifecyclePhase(phase)) throw protocolError(`${label} phase is invalid`);
  const name = optionalString(value, "name", label);
  const message = optionalString(value, "message", label);
  return Object.freeze({
    pluginId: requireString(value, "pluginId", label),
    source: requireString(value, "source", label),
    scope,
    moduleRevision: requireString(value, "moduleRevision", label),
    state,
    ...(name === undefined ? {} : { name }),
    ...(phase === undefined ? {} : { phase }),
    ...(message === undefined ? {} : { message }),
  });
}

function parseHealthInspection(value: unknown, index: number): ServerPluginHealthInspection {
  const label = `provider runtime health item ${String(index + 1)}`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const phase = value["phase"];
  if (phase !== undefined && phase !== "health") throw protocolError(`${label} phase is invalid`);
  const error = optionalString(value, "error", label);
  return Object.freeze({
    pluginId: requireString(value, "pluginId", label),
    health: parseHealth(value["health"], label),
    ...(phase === undefined ? {} : { phase }),
    ...(error === undefined ? {} : { error }),
  });
}

function parseHealth(value: unknown, inspectionLabel: string): ServerPluginHealth {
  const label = `${inspectionLabel} health`;
  if (!isRecord(value)) throw protocolError(`${label} must be an object`);
  const status = value["status"];
  if (status !== "healthy" && status !== "degraded" && status !== "unhealthy") {
    throw protocolError(`${label} status is invalid`);
  }
  const message = optionalString(value, "message", label);
  const details = value["details"] === undefined ? undefined : parseJsonObject(value["details"], `${label} details`);
  return Object.freeze({
    status,
    ...(message === undefined ? {} : { message }),
    ...(details === undefined ? {} : { details }),
  });
}

function parseSafeStart(value: unknown): ServerPluginSafeStart | undefined {
  if (value === undefined) return undefined;
  if (value === "bundled-only" || value === "none") return value;
  throw protocolError("provider runtime safeStart is invalid");
}

function parseArray<T>(value: unknown, label: string, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw protocolError(`${label} must be an array`);
  return value.map(parse);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw protocolError(`${label} must be a JSON object`);
  const output = Object.fromEntries(
    Object.entries(value).map(([key, child]): [string, JsonValue] => [key, parseJsonValue(child, label)]),
  );
  Object.freeze(output);
  return output;
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const output = value.map((item) => parseJsonValue(item, label));
    Object.freeze(output);
    return output;
  }
  if (isRecord(value)) return parseJsonObject(value, label);
  throw protocolError(`${label} must contain only JSON values`);
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw protocolError(`${label} ${field} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw protocolError(`${label} ${field} must be a string`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw protocolError(`${label} ${field} must be a boolean`);
  return value;
}

function isRuntimeState(value: unknown): value is ServerPluginRuntimeState {
  return value === "active" || value === "failed" || value === "incompatible" || value === "disabled";
}

function isLifecyclePhase(value: unknown): value is ServerPluginLifecyclePhase {
  return value === "import" || value === "activate" || value === "validate" || value === "start" || value === "health" || value === "stop";
}

function encodedId(value: string, label: string): string {
  if (value === "") throw new Error(`${label} id must be a non-empty string`);
  return encodeURIComponent(value);
}

function workspaceCatalogRequestMessage(statusCode: number, body: string): string {
  const detail = responseError(body);
  if (statusCode < 500 && detail !== undefined) return detail;
  return `Session daemon workspace authority returned HTTP ${String(statusCode)}${detail === undefined ? "" : `: ${detail}`}`;
}

function responseError(body: string): string | undefined {
  const value = parseResponseBody(body);
  return isRecord(value) && typeof value["error"] === "string" ? value["error"] : undefined;
}

function isUnknownWorkspaceCatalogRoute(statusCode: number, body: string): boolean {
  if (statusCode !== 404) return false;
  const value = parseResponseBody(body);
  if (!isRecord(value)) return true;
  const error = value["error"];
  const message = value["message"];
  return error === "Not Found" || (typeof message === "string" && /^Route .* not found$/u.test(message));
}

function parseResponseBody(body: string): unknown {
  try {
    if (body === "") return undefined;
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    return undefined;
  }
}

function protocolError(message: string): WorkspaceCatalogProtocolError {
  return new WorkspaceCatalogProtocolError(`Invalid session daemon workspace authority response: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
