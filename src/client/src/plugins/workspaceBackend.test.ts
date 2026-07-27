import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { createPluginWorkspaceBackend, type PluginBackendRequester } from "./workspaceBackend";

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

describe("plugin workspace backend", () => {
  it("binds the contribution source and revision to its workspace and machine", async () => {
    const request = vi.fn<PluginBackendRequester>(() => Promise.resolve({ files: [] }));
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    }, workspace, "remote one", request);

    await expect(backend.request("status", null)).resolves.toEqual({ files: [] });
    expect(request).toHaveBeenCalledWith({
      pluginId: "changes.owner",
      backendRevision: "remote-r2",
      machineId: "remote one",
      projectId: "project one",
      workspaceId: "workspace one",
    }, "status", null);
  });

  it("returns an explicit mixed-version error when the browser module has no server revision", async () => {
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "changes.owner",
      sourcePluginId: "changes.owner",
    }, workspace, "remote-1");

    await expect(backend.request("status", null)).rejects.toThrow("does not declare a server backend");
  });
});
