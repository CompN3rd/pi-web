import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { JsonValue, Project, Workspace } from "../api";
import type { WorkspaceBackend } from "../plugins/types";
import { GitController, type ResolveGitWorkspaceBackend } from "./gitController";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const workspace: Workspace = {
  id: "workspace-1",
  projectId: project.id,
  path: project.path,
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
  provider: { pluginId: "git", capabilities: { request: true, remove: false } },
};

describe("GitController provider backend adapter", () => {
  it("preserves status and staged/unstaged diff behavior through generic operations", async () => {
    const requests: { operation: string; input: JsonValue }[] = [];
    const backend: WorkspaceBackend = {
      request(operation, input) {
        requests.push({ operation, input });
        if (operation === "status") {
          return Promise.resolve({
            isGitRepo: true,
            hash: "status-hash",
            branch: "main",
            files: [{ path: "tracked.txt", index: "unmodified", workingTree: "modified" }],
            submodules: [],
          });
        }
        const staged = isRecord(input) && input["staged"] === true;
        return Promise.resolve({
          path: "tracked.txt",
          staged,
          hash: staged ? "staged-hash" : "working-hash",
          diff: staged ? "staged diff" : "working diff",
          truncated: false,
        });
      },
    };
    const resolveBackend = vi.fn<ResolveGitWorkspaceBackend>(() => backend);
    const fixture = controllerFixture(resolveBackend);

    await fixture.controller.refreshGit();
    await fixture.controller.refreshDiff("tracked.txt");

    expect(resolveBackend).toHaveBeenCalledWith(workspace, "local");
    expect(requests).toEqual([
      { operation: "status", input: null },
      { operation: "diff", input: { path: "tracked.txt" } },
      { operation: "diff", input: { path: "tracked.txt", staged: true } },
    ]);
    expect(fixture.state()).toMatchObject({
      gitStatus: { hash: "status-hash", branch: "main" },
      selectedDiff: { hash: "working-hash", staged: false },
      selectedStagedDiff: { hash: "staged-hash", staged: true },
      gitStale: false,
      error: "",
    });
  });

  it("contains malformed plugin results as the existing controller error state", async () => {
    const fixture = controllerFixture(() => ({ request: () => Promise.resolve({ files: [] }) }));

    await fixture.controller.refreshGit();

    expect(fixture.state().gitStatus).toBeUndefined();
    expect(fixture.state().error).toContain("Expected boolean field: isGitRepo");
  });
});

function controllerFixture(resolveBackend: ResolveGitWorkspaceBackend): {
  controller: GitController;
  state: () => AppState;
} {
  let state: AppState = { ...initialAppState(), selectedProject: project, selectedWorkspace: workspace };
  const controller = new GitController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    vi.fn(),
    resolveBackend,
  );
  return { controller, state: () => state };
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
