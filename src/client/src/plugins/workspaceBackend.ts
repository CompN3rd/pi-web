import type { JsonValue, Workspace } from "../api";
import { requestPluginBackend, type PluginBackendRequestTarget } from "../api/pluginBackends";
import type { WorkspaceBackend, WorkspacePluginBinding } from "./types";

export interface WorkspaceBackendBindingResolver {
  getWorkspaceBackendBinding(sourcePluginId: string, machineId: string): WorkspacePluginBinding | undefined;
}

export type PluginBackendRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
) => Promise<JsonValue>;

/** Temporary core adapter for an owner until its UI moves into plugin context in S8. */
export function createProviderWorkspaceBackend(
  bindings: WorkspaceBackendBindingResolver,
  workspace: Workspace,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
): WorkspaceBackend {
  const provider = workspace.provider;
  if (provider === undefined) {
    throw new Error("Workspace provider backend identity is unavailable; restart or upgrade the selected machine");
  }
  if (!provider.capabilities.request) {
    throw new Error(`Workspace provider ${provider.pluginId} does not expose backend requests`);
  }
  const binding = bindings.getWorkspaceBackendBinding(provider.pluginId, machineId);
  if (binding === undefined) {
    throw new Error(`Workspace provider ${provider.pluginId} browser backend is unavailable on machine ${machineId}`);
  }
  if (binding.backendRevision === undefined) {
    throw new Error(`Workspace provider ${provider.pluginId} backend revision is unavailable; restart or upgrade the selected machine`);
  }
  return createPluginWorkspaceBackend(binding, workspace, machineId, request);
}

export function createPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
): WorkspaceBackend {
  return {
    request: (operation, input) => {
      if (binding.backendRevision === undefined) {
        return Promise.reject(new Error(`PI WEB plugin ${binding.sourcePluginId} does not declare a server backend`));
      }
      return request({
        pluginId: binding.sourcePluginId,
        backendRevision: binding.backendRevision,
        machineId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
      }, operation, input);
    },
  };
}
