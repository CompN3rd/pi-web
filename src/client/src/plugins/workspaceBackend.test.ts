import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import {
  createProviderWorkspaceBackend,
  type PluginBackendRequester,
  type WorkspaceBackendBindingResolver,
} from "./workspaceBackend";

const workspace: Workspace = {
  id: "workspace one",
  projectId: "project one",
  path: "/repo",
  label: "main",
  isMain: true,
  isGitRepo: false,
  isGitWorktree: false,
  provider: {
    pluginId: "changes.owner",
    capabilities: { request: true, remove: false },
  },
};

describe("temporary provider workspace backend adapter", () => {
  it("binds the current owner and selected machine to the generic request helper", async () => {
    const bindings: WorkspaceBackendBindingResolver = {
      getWorkspaceBackendBinding: () => ({
        registrationPluginId: "machine.remote.changes.owner",
        sourcePluginId: "changes.owner",
        backendRevision: "remote-r2",
      }),
    };
    const request = vi.fn<PluginBackendRequester>(() => Promise.resolve({ files: [] }));
    const backend = createProviderWorkspaceBackend(bindings, workspace, "remote one", request);

    await expect(backend.request("status", null)).resolves.toEqual({ files: [] });
    expect(request).toHaveBeenCalledWith({
      pluginId: "changes.owner",
      backendRevision: "remote-r2",
      machineId: "remote one",
      projectId: "project one",
      workspaceId: "workspace one",
    }, "status", null);
  });

  it("returns explicit capability errors instead of falling back to private routes", () => {
    const noBindings: WorkspaceBackendBindingResolver = { getWorkspaceBackendBinding: () => undefined };

    expect(() => createProviderWorkspaceBackend(noBindings, workspaceWithoutProvider(), "remote-1"))
      .toThrow("restart or upgrade the selected machine");
    expect(() => createProviderWorkspaceBackend(noBindings, {
      ...workspace,
      provider: { pluginId: "changes.owner", capabilities: { request: false, remove: false } },
    }, "remote-1")).toThrow("does not expose backend requests");
    expect(() => createProviderWorkspaceBackend(noBindings, workspace, "remote-1"))
      .toThrow("browser backend is unavailable");
    expect(() => createProviderWorkspaceBackend({
      getWorkspaceBackendBinding: () => ({ registrationPluginId: "changes.owner", sourcePluginId: "changes.owner" }),
    }, workspace, "remote-1")).toThrow("backend revision is unavailable");
  });
});

function workspaceWithoutProvider(): Workspace {
  const copy: Workspace = { ...workspace };
  Reflect.deleteProperty(copy, "provider");
  return copy;
}
