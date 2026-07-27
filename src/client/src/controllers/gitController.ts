import type { Workspace } from "../api";
import { parseGitDiffResponse, parseGitStatusResponse } from "../api/parsers";
import { queryNamespace, setNamespacedQueryKey } from "../namespacedQueryArgs";
import type { WorkspaceBackend } from "../plugins/types";
import { selectedMachineId, type GetState, type SetState, type UpdateUrl } from "./types";

const GIT_ROUTE_NAMESPACE = queryNamespace("core:workspace.git");
const GIT_STATUS_OPERATION = "status";
const GIT_DIFF_OPERATION = "diff";

export type ResolveGitWorkspaceBackend = (
  workspace: Workspace,
  machineId: string,
) => WorkspaceBackend | Promise<WorkspaceBackend>;

export class GitController {
  private pollTimer: number | undefined;

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    private readonly updateUrl: UpdateUrl,
    private readonly resolveBackend: ResolveGitWorkspaceBackend,
  ) {}

  dispose(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async refreshGit(): Promise<void> {
    const state = this.getState();
    const workspace = state.selectedWorkspace;
    if (state.selectedProject === undefined || workspace === undefined) return;
    try {
      const backend = await this.resolveBackend(workspace, selectedMachineId(state));
      const status = parseGitStatusResponse(await backend.request(GIT_STATUS_OPERATION, null));
      this.setState({ gitStatus: status, gitStale: false, error: "" });
      const selectedDiffPath = this.getState().selectedDiffPath;
      if (selectedDiffPath !== undefined) {
        if (status.files.some((file) => file.path === selectedDiffPath)) await this.refreshDiff(selectedDiffPath);
        else {
          this.setState({ selectedDiffPath: undefined, selectedDiff: undefined, selectedStagedDiff: undefined });
          setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", undefined, { replace: true });
        }
      }
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  async selectDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined, workspaceTool: "core:workspace.git", mainView: this.getState().mainView === "chat" ? "chat" : "core:workspace.git" });
    setNamespacedQueryKey(GIT_ROUTE_NAMESPACE, "diff", path);
    this.updateUrl({ replace: true });
    await this.refreshDiff(path);
  }

  async restoreDiff(path: string): Promise<void> {
    this.setState({ selectedDiffPath: path, selectedDiff: undefined, selectedStagedDiff: undefined });
    await this.refreshDiff(path);
  }

  async refreshDiff(path: string): Promise<void> {
    const state = this.getState();
    const workspace = state.selectedWorkspace;
    if (state.selectedProject === undefined || workspace === undefined) return;
    try {
      const backend = await this.resolveBackend(workspace, selectedMachineId(state));
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        backend.request(GIT_DIFF_OPERATION, { path }).then(parseGitDiffResponse),
        backend.request(GIT_DIFF_OPERATION, { path, staged: true }).then(parseGitDiffResponse),
      ]);
      this.setState({ selectedDiff, selectedStagedDiff, error: "" });
    } catch (error) {
      this.setState({ error: String(error) });
    }
  }

  updatePolling(): void {
    this.dispose();
    const state = this.getState();
    if (state.workspaceTool === "core:workspace.git" || state.mainView === "core:workspace.git") {
      this.pollTimer = window.setInterval(() => { void this.refreshGit(); }, 8000);
    }
  }
}
