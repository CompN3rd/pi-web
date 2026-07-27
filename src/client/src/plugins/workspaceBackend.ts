import type { JsonValue, Workspace } from "../api";
import { requestPluginBackend, type PluginBackendRequestTarget } from "../api/pluginBackends";
import type { WorkspaceBackend, WorkspacePluginBinding } from "./types";

export type PluginBackendRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
) => Promise<JsonValue>;

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
