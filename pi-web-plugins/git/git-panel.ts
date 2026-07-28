import type {
  HtmlTemplateTag,
  JsonValue,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  Workspace,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import {
  GIT_DIFF_OPERATION,
  GIT_STATUS_OPERATION,
  parseGitDiffResponse,
  parseGitStatusResponse,
  type GitDiffResponse,
  type GitStatusFile,
  type GitStatusResponse,
} from "./git-contract.js";
import { buildGitFileList, type GitFileListModel, type GitFileListSubmoduleFile, type GitFileListSubmoduleGroup } from "./gitFileList.js";
import { buildGitFileTree, collectGitFileTreeDirectoryPaths, type GitFileTreeNode } from "./gitFileTree.js";
import { readGitFileView, writeGitFileView, type GitFileView } from "./gitFileViewPreference.js";
import { createGitDiffRoute, type GitDiffRoute } from "./gitRoute.js";
import { parseUnifiedDiff, type UnifiedDiffLine, type UnifiedDiffTextSpan } from "./unifiedDiff.js";

const GIT_PROVIDER_ID = "git";
const GIT_PANEL_LOCAL_ID = "workspace.git";
const GIT_POLL_INTERVAL_MS = 8_000;
const activityElementTag = "pi-web-git-panel-activity";

interface GitWorkspaceUiState {
  context: WorkspacePanelContext;
  status: GitStatusResponse | undefined;
  statusLoading: boolean;
  stale: boolean;
  selectedDiffPath: string | undefined;
  selectedDiff: GitDiffResponse | undefined;
  selectedStagedDiff: GitDiffResponse | undefined;
  diffLoading: boolean;
  error: string | undefined;
  expandedDirectories: Set<string>;
  statusRequest: Promise<void> | undefined;
  diffRequestSequence: number;
}

interface GitViewState {
  readonly nodes: readonly GitFileTreeNode[];
  readonly listModel: GitFileListModel;
  readonly expandablePaths: readonly string[];
}

const EMPTY_LIST_MODEL: GitFileListModel = { submodules: [], files: [] };
const EMPTY_VIEW_STATE: GitViewState = { nodes: [], listModel: EMPTY_LIST_MODEL, expandablePaths: [] };

export function createGitBrowserContributions(
  pluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${pluginId}:${GIT_PANEL_LOCAL_ID}`;
  const controller = new GitUiController(createGitDiffRoute(panelId));
  defineGitPanelActivityElement();
  return {
    actions: createGitActions(panelId, controller),
    workspacePanels: [createGitPanel(html, svg, controller)],
  };
}

class GitUiController {
  private readonly states = new Map<string, GitWorkspaceUiState>();
  private activeWorkspaceKey: string | undefined;
  private routeNavigationPending = true;
  private view: GitFileView = readGitFileView();

  constructor(private readonly route: GitDiffRoute) {}

  isOwnedWorkspace(workspace: Workspace | undefined): boolean {
    if (workspace === undefined) return false;
    if (workspace.provider !== undefined) return workspace.provider.pluginId === GIT_PROVIDER_ID;
    // Browser-v1 compatibility for an older workspace payload. New providers
    // use `provider.pluginId`; a declared non-Git owner always wins above.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return workspace.isGitRepo;
  }

  observe(context: WorkspacePanelContext): GitWorkspaceUiState {
    const key = workspaceKey(context.workspace);
    const state = this.stateFor(context);
    state.context = context;

    if (this.activeWorkspaceKey !== key) {
      this.activeWorkspaceKey = key;
      if (this.routeNavigationPending && this.route.matches(context)) {
        this.routeNavigationPending = false;
        const selectedPath = this.route.read();
        this.applyRouteSelection(state, selectedPath);
        this.route.write(selectedPath, { replace: true });
      } else if (this.route.matches(context)) {
        this.route.write(state.selectedDiffPath, { replace: true });
      }
    } else if (this.routeNavigationPending && this.route.matches(context)) {
      this.routeNavigationPending = false;
      const selectedPath = this.route.read();
      this.applyRouteSelection(state, selectedPath);
      this.route.write(selectedPath, { replace: true });
    }

    return state;
  }

  connect(context: WorkspacePanelContext): void {
    const state = this.observe(context);
    if (state.status === undefined && state.statusRequest === undefined) void this.refresh(context);
    else if (state.selectedDiffPath !== undefined && state.selectedDiff === undefined && !state.diffLoading) {
      void this.refreshDiff(state, state.selectedDiffPath);
    }
  }

  handlePopState(context: WorkspacePanelContext): void {
    this.routeNavigationPending = true;
    if (!this.route.matches(context)) return;
    const state = this.observe(context);
    this.applyRouteSelection(state, this.route.read());
    if (state.selectedDiffPath !== undefined && state.status?.files.some((file) => file.path === state.selectedDiffPath) === true) {
      void this.refreshDiff(state, state.selectedDiffPath);
    }
    this.requestRender(state);
  }

  poll(context: WorkspacePanelContext): void {
    const state = this.observe(context);
    state.stale = state.status !== undefined;
    this.requestRender(state);
    void this.refresh(context);
  }

  invalidate(context: WorkspacePanelContext): Promise<void> {
    if (!this.isOwnedWorkspace(context.workspace)) return Promise.resolve();
    return this.refresh(context);
  }

  refreshWorkspace(workspace: Workspace | undefined): Promise<void> {
    if (workspace === undefined) return Promise.resolve();
    const state = this.states.get(workspaceKey(workspace));
    if (state === undefined) return Promise.resolve();
    state.stale = state.status !== undefined;
    this.requestRender(state);
    return this.refresh(state.context);
  }

  refresh(context: WorkspacePanelContext): Promise<void> {
    const state = this.observe(context);
    if (state.statusRequest !== undefined) return state.statusRequest;
    state.statusLoading = true;
    this.requestRender(state);

    const request = requestGitBackend(context, GIT_STATUS_OPERATION, null)
      .then(parseGitStatusResponse)
      .then(async (status) => {
        state.status = status;
        state.stale = false;
        state.error = undefined;
        const path = state.selectedDiffPath;
        if (path === undefined) return;
        if (status.files.some((file) => file.path === path)) await this.refreshDiff(state, path);
        else this.clearSelection(state, true);
      })
      .catch((error: unknown) => {
        state.error = errorMessage(error);
      })
      .finally(() => {
        if (state.statusRequest !== request) return;
        state.statusRequest = undefined;
        state.statusLoading = false;
        this.requestRender(state);
      });
    state.statusRequest = request;
    return request;
  }

  selectDiff(context: WorkspacePanelContext, path: string): void {
    const state = this.observe(context);
    state.selectedDiffPath = path;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    state.diffLoading = true;
    state.error = undefined;
    this.route.write(path);
    this.requestRender(state);
    void this.refreshDiff(state, path);
  }

  setView(context: WorkspacePanelContext, view: GitFileView): void {
    if (this.view === view) return;
    this.view = view;
    writeGitFileView(view);
    const state = this.observe(context);
    state.expandedDirectories = new Set();
    this.requestRender(state);
  }

  currentView(): GitFileView {
    return this.view;
  }

  toggleDirectory(context: WorkspacePanelContext, path: string): void {
    const state = this.observe(context);
    const next = new Set(state.expandedDirectories);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    state.expandedDirectories = next;
    this.requestRender(state);
  }

  toggleExpandAll(context: WorkspacePanelContext, paths: readonly string[], collapse: boolean): void {
    const state = this.observe(context);
    state.expandedDirectories = collapse ? new Set() : new Set(paths);
    this.requestRender(state);
  }

  private stateFor(context: WorkspacePanelContext): GitWorkspaceUiState {
    const key = workspaceKey(context.workspace);
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const created: GitWorkspaceUiState = {
      context,
      status: undefined,
      statusLoading: false,
      stale: false,
      selectedDiffPath: undefined,
      selectedDiff: undefined,
      selectedStagedDiff: undefined,
      diffLoading: false,
      error: undefined,
      expandedDirectories: new Set(),
      statusRequest: undefined,
      diffRequestSequence: 0,
    };
    this.states.set(key, created);
    return created;
  }

  private applyRouteSelection(state: GitWorkspaceUiState, path: string | undefined): void {
    if (state.selectedDiffPath === path) return;
    state.selectedDiffPath = path;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    state.diffLoading = false;
    state.diffRequestSequence += 1;
  }

  private clearSelection(state: GitWorkspaceUiState, replaceUrl: boolean): void {
    this.applyRouteSelection(state, undefined);
    if (replaceUrl && this.activeWorkspaceKey === workspaceKey(state.context.workspace) && this.route.matches(state.context)) {
      this.route.write(undefined, { replace: true });
    }
  }

  private async refreshDiff(state: GitWorkspaceUiState, path: string): Promise<void> {
    const sequence = state.diffRequestSequence + 1;
    state.diffRequestSequence = sequence;
    state.diffLoading = true;
    state.selectedDiff = undefined;
    state.selectedStagedDiff = undefined;
    this.requestRender(state);
    try {
      const [selectedDiff, selectedStagedDiff] = await Promise.all([
        requestGitBackend(state.context, GIT_DIFF_OPERATION, { path }).then(parseGitDiffResponse),
        requestGitBackend(state.context, GIT_DIFF_OPERATION, { path, staged: true }).then(parseGitDiffResponse),
      ]);
      if (state.diffRequestSequence !== sequence || state.selectedDiffPath !== path) return;
      state.selectedDiff = selectedDiff;
      state.selectedStagedDiff = selectedStagedDiff;
      state.error = undefined;
    } catch (error) {
      if (state.diffRequestSequence !== sequence || state.selectedDiffPath !== path) return;
      state.error = errorMessage(error);
    } finally {
      if (state.diffRequestSequence === sequence && state.selectedDiffPath === path) {
        state.diffLoading = false;
        this.requestRender(state);
      }
    }
  }

  private requestRender(state: GitWorkspaceUiState): void {
    state.context.host.requestRender();
  }
}

function createGitActions(panelId: string, controller: GitUiController): PluginAction[] {
  const hasGitWorkspace = (context: PluginRuntimeContext): boolean => controller.isOwnedWorkspace(context.state.selectedWorkspace);
  return [
    {
      id: "view.git",
      title: "Go to Git",
      shortcut: "mod+3",
      group: "Navigation",
      enabled: hasGitWorkspace,
      run: (context) => { context.selectMainView(panelId); },
    },
    {
      id: "workspace.refresh-git",
      title: "Refresh Git",
      shortcut: "mod+shift+g",
      group: "Workspace",
      enabled: hasGitWorkspace,
      run: (context) => controller.refreshWorkspace(context.state.selectedWorkspace),
    },
    {
      id: "workspace.refresh-current",
      title: "Refresh Current Panel",
      shortcut: "mod+shift+r",
      group: "Workspace",
      enabled: (context) => hasGitWorkspace(context) && context.state.workspaceTool === panelId,
      run: (context) => controller.refreshWorkspace(context.state.selectedWorkspace),
    },
  ];
}

function createGitPanel(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  controller: GitUiController,
): WorkspacePanelContribution {
  return {
    id: GIT_PANEL_LOCAL_ID,
    title: "Git",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="6" r="2"></circle>
        <circle cx="18" cy="6" r="2"></circle>
        <circle cx="12" cy="18" r="2"></circle>
        <path d="M8 6h6"></path>
        <path d="M6 8v2a6 6 0 0 0 6 6"></path>
        <path d="M18 8v2a6 6 0 0 1-6 6"></path>
      </svg>
    `,
    order: 20,
    visible: (context) => {
      if (!controller.isOwnedWorkspace(context.workspace)) return false;
      controller.observe(context);
      return true;
    },
    onInvalidate: (context) => controller.invalidate(context),
    render: (context) => renderGitPanel(html, controller, context),
  };
}

function requestGitBackend(context: WorkspacePanelContext, operation: string, input: JsonValue): Promise<JsonValue> {
  if (context.backend === undefined || context.workspace.provider?.capabilities.request === false) {
    return Promise.reject(new Error("Git workspace backend is unavailable. Update and restart PI WEB on this machine, then reload the browser."));
  }
  return context.backend.request(operation, input);
}

function renderGitPanel(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext) {
  const state = controller.observe(context);
  const viewState = buildViewState(state.status, controller.currentView());
  return html`
    <style .textContent=${gitPanelStyles}></style>
    <pi-web-git-panel-activity .controller=${controller} .context=${context}></pi-web-git-panel-activity>
    <section class="toolbar git-toolbar">
      <strong>Git</strong>
      ${state.stale ? html`<span class="stale">stale</span>` : null}
      <div class="toolbar-actions">
        ${viewState.expandablePaths.length === 0 ? null : renderExpandCollapseAll(html, controller, context, state, viewState.expandablePaths)}
        ${renderViewToggle(html, controller, context)}
        <button type="button" ?disabled=${state.statusLoading} @click=${() => { void controller.refresh(context); }}>Refresh</button>
      </div>
    </section>
    ${state.error === undefined ? null : html`<div class="git-error" role="alert">${state.error}</div>`}
    <section class="split">
      <div class="list">${renderFileList(html, controller, context, state, viewState)}</div>
      <div class="viewer">${renderDiffViewer(html, state)}</div>
    </section>
  `;
}

function renderViewToggle(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext) {
  return html`
    <div class="view-toggle" role="group" aria-label="Changed files view">
      ${renderViewToggleButton(html, controller, context, "list", "List")}
      ${renderViewToggleButton(html, controller, context, "tree", "Tree")}
    </div>
  `;
}

function renderViewToggleButton(html: HtmlTemplateTag, controller: GitUiController, context: WorkspacePanelContext, view: GitFileView, label: string) {
  const active = controller.currentView() === view;
  return html`<button type="button" class=${active ? "selected" : ""} aria-pressed=${String(active)} @click=${() => { controller.setView(context, view); }}>${label}</button>`;
}

function renderExpandCollapseAll(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  expandablePaths: readonly string[],
) {
  const allExpanded = expandablePaths.every((path) => state.expandedDirectories.has(path));
  return html`<button type="button" @click=${() => { controller.toggleExpandAll(context, expandablePaths, allExpanded); }}>${allExpanded ? "Collapse all" : "Expand all"}</button>`;
}

function renderFileList(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  viewState: GitViewState,
) {
  const status = state.status;
  if (status === undefined) return html`<p class="muted">${state.statusLoading ? "Loading status…" : "No status loaded."}</p>`;
  if (!status.isGitRepo) return html`<p class="muted">Not a git repository.</p>`;
  const summary = html`<p class="summary">${gitSummary(status)}</p>`;
  if (status.files.length === 0) return html`${summary}<p class="muted">No changes.</p>`;
  const body = controller.currentView() === "tree"
    ? viewState.nodes.map((node) => renderTreeNode(html, controller, context, state, node, 0))
    : renderListBody(html, controller, context, state, viewState.listModel);
  return html`${summary}${body}`;
}

function renderListBody(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  model: GitFileListModel,
) {
  return html`
    ${model.submodules.map((group) => renderSubmoduleGroup(html, controller, context, state, group))}
    ${model.files.map((file) => renderFileRow(html, controller, context, state, file))}
  `;
}

function renderSubmoduleGroup(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  group: GitFileListSubmoduleGroup,
) {
  const expanded = state.expandedDirectories.has(group.path);
  return html`
    <button type="button" class="row" style="--depth:0" aria-expanded=${String(expanded)} @click=${() => { controller.toggleDirectory(context, group.path); }}>
      <span class="twisty">${expanded ? "▾" : "▸"}</span>
      <span>${group.name}${submoduleBadge(html)}</span>
    </button>
    ${expanded ? html`
      ${group.pointer === undefined ? null : renderSelectableRow(html, controller, context, state, group.path, group.pointer.name, group.pointer.file, 1)}
      ${group.files.map((entry) => renderSubmoduleFileRow(html, controller, context, state, entry))}
    ` : null}
  `;
}

function renderSubmoduleFileRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  entry: GitFileListSubmoduleFile,
) {
  return renderSelectableRow(html, controller, context, state, entry.path, entry.relativePath, entry.file, 1);
}

function renderTreeNode(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  node: GitFileTreeNode,
  depth: number,
): ReturnType<HtmlTemplateTag> {
  if (node.kind === "directory") {
    const expanded = state.expandedDirectories.has(node.path);
    return html`
      <button type="button" class="row" style=${`--depth:${String(depth)}`} aria-expanded=${String(expanded)} @click=${() => { controller.toggleDirectory(context, node.path); }}>
        <span class="twisty">${expanded ? "▾" : "▸"}</span>
        <span>${node.name}${node.isSubmodule === true ? submoduleBadge(html) : null}</span>
      </button>
      ${expanded ? node.children.map((child) => renderTreeNode(html, controller, context, state, child, depth + 1)) : null}
    `;
  }
  return renderSelectableRow(html, controller, context, state, node.path, node.name, node.file, depth);
}

function renderFileRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  file: GitStatusFile,
) {
  return renderSelectableRow(html, controller, context, state, file.path, file.path, file, 0);
}

function renderSelectableRow(
  html: HtmlTemplateTag,
  controller: GitUiController,
  context: WorkspacePanelContext,
  state: GitWorkspaceUiState,
  path: string,
  label: string,
  file: GitStatusFile,
  depth: number,
) {
  const selected = state.selectedDiffPath === path;
  return html`
    <button type="button" class=${selected ? "row selected" : "row"} style=${`--depth:${String(depth)}`} @click=${() => { controller.selectDiff(context, path); }}>
      <span>${stateLabel(file.index, file.workingTree)}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderDiffViewer(html: HtmlTemplateTag, state: GitWorkspaceUiState) {
  if (state.selectedDiffPath === undefined || state.selectedDiffPath === "") return html`<p class="muted">Select a changed file.</p>`;
  const unstaged = state.selectedDiff;
  const staged = state.selectedStagedDiff;
  if (state.diffLoading || unstaged === undefined || staged === undefined) return html`<p class="muted">Loading diff…</p>`;
  const diffs = [staged, unstaged].filter((diff) => diff.diff !== "");
  if (diffs.length === 0) return html`<p class="muted">No staged or unstaged diff.</p>`;
  return html`<div class=${diffs.length === 1 ? "diffs single" : "diffs"}>${diffs.map((diff) => renderDiffSection(html, diff))}</div>`;
}

function renderDiffSection(html: HtmlTemplateTag, diff: GitDiffResponse) {
  const lines = parseUnifiedDiff(diff.diff);
  return html`
    <section class="diff-section">
      <div class="viewer-header"><strong>${diff.path ?? "diff"}</strong><small>${diff.staged ? "staged" : "unstaged"}${diff.truncated ? " · truncated" : ""}</small></div>
      ${lines.length === 0 ? html`<p class="muted">No diff.</p>` : html`
        <div class="git-diff-scroller">
          <div class="git-diff-grid" role="table" aria-label="Unified diff">
            ${lines.map((line) => renderDiffLine(html, line))}
          </div>
        </div>
      `}
    </section>
  `;
}

function renderDiffLine(html: HtmlTemplateTag, line: UnifiedDiffLine) {
  return html`
    <div class="git-diff-line" role="row">
      <span class=${`git-diff-cell git-line-number ${line.kind}`} role="cell">${formatLineNumber(line.oldLineNumber)}</span>
      <span class=${`git-diff-cell git-line-number ${line.kind}`} role="cell">${formatLineNumber(line.newLineNumber)}</span>
      <span class=${`git-diff-cell git-prefix ${line.kind}`} role="cell">${line.prefix}</span>
      <span class=${`git-diff-cell git-content ${line.kind}`} role="cell">${renderDiffSpans(html, line.spans)}</span>
    </div>
  `;
}

function renderDiffSpans(html: HtmlTemplateTag, spans: UnifiedDiffTextSpan[]) {
  return spans.map((span) => html`<span class=${span.changed ? "inline-change" : ""}>${span.text}</span>`);
}

function buildViewState(status: GitStatusResponse | undefined, view: GitFileView): GitViewState {
  if (status === undefined || !status.isGitRepo || status.files.length === 0) return EMPTY_VIEW_STATE;
  if (view === "tree") {
    const nodes = buildGitFileTree(status.files, status.submodules);
    return { nodes, listModel: EMPTY_LIST_MODEL, expandablePaths: collectGitFileTreeDirectoryPaths(nodes) };
  }
  const listModel = buildGitFileList(status.files, status.submodules);
  return { nodes: [], listModel, expandablePaths: listModel.submodules.map((group) => group.path) };
}

function defineGitPanelActivityElement(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined" || customElements.get(activityElementTag) !== undefined) return;
  class GitPanelActivityElement extends HTMLElement {
    private controllerValue: GitUiController | undefined;
    private contextValue: WorkspacePanelContext | undefined;
    private pollTimer: number | undefined;

    set controller(value: GitUiController | undefined) {
      if (this.controllerValue === value) return;
      this.controllerValue = value;
      this.restart();
    }

    set context(value: WorkspacePanelContext | undefined) {
      const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
      this.contextValue = value;
      if (value !== undefined) this.controllerValue?.observe(value);
      if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.restart();
    }

    connectedCallback(): void {
      window.addEventListener("popstate", this.onPopState);
      this.restart();
    }

    disconnectedCallback(): void {
      window.removeEventListener("popstate", this.onPopState);
      this.stopTimer();
    }

    private restart(): void {
      this.stopTimer();
      if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
      this.controllerValue.connect(this.contextValue);
      this.pollTimer = window.setInterval(() => {
        if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.poll(this.contextValue);
      }, GIT_POLL_INTERVAL_MS);
    }

    private stopTimer(): void {
      if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    private readonly onPopState = () => {
      if (this.controllerValue !== undefined && this.contextValue !== undefined) this.controllerValue.handlePopState(this.contextValue);
    };
  }
  customElements.define(activityElementTag, GitPanelActivityElement);
}

function submoduleBadge(html: HtmlTemplateTag) {
  return html`<span class="submodule-badge">submodule</span>`;
}

function gitSummary(status: GitStatusResponse): string {
  const branch = status.branch ?? "detached";
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  return ahead === 0 && behind === 0 ? branch : `${branch} · ↑${String(ahead)} ↓${String(behind)}`;
}

function stateLabel(index: string, workingTree: string): string {
  const label = workingTree !== "unmodified" ? workingTree : index;
  return label.slice(0, 1).toUpperCase();
}

function formatLineNumber(lineNumber: number | undefined): string {
  return lineNumber === undefined ? "" : String(lineNumber);
}

function workspaceKey(workspace: Pick<Workspace, "projectId" | "id">): string {
  return JSON.stringify([workspace.projectId, workspace.id]);
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const gitPanelStyles = `
  ${activityElementTag} { display: none; }
  .git-toolbar .toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .git-toolbar .toolbar-actions button { margin-left: 0; }
  .git-toolbar button:disabled { cursor: wait; opacity: .65; }
  .view-toggle { display: inline-flex; }
  .view-toggle button { border-radius: 0; }
  .view-toggle button:first-child { border-top-left-radius: 7px; border-bottom-left-radius: 7px; }
  .view-toggle button:last-child { margin-left: -1px; border-top-right-radius: 7px; border-bottom-right-radius: 7px; }
  .view-toggle button.selected { position: relative; z-index: 1; }
  .row .twisty { color: var(--pi-dim, var(--pi-muted)); }
  .submodule-badge { display: inline-block; margin-left: 6px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; vertical-align: baseline; }
  .git-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .diffs { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; grid-template-rows: minmax(120px, 1fr) minmax(120px, 1fr); }
  .diffs.single { grid-template-rows: minmax(0, 1fr); }
  .diff-section { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--pi-border); }
  .diff-section:last-child { border-bottom: 0; }
  .git-diff-scroller { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--pi-bg); }
  .git-diff-grid { display: grid; grid-template-columns: max-content max-content 2ch max-content; width: max-content; min-width: 100%; padding: 6px 0; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
  .git-diff-line { display: contents; }
  .git-diff-cell { min-height: 1.45em; white-space: pre; }
  .git-line-number { min-width: 4ch; padding: 0 8px; border-right: 1px solid var(--pi-border-muted); color: var(--pi-dim); text-align: right; user-select: none; }
  .git-prefix { padding: 0 4px; color: var(--pi-dim); text-align: center; user-select: none; }
  .git-content { padding: 0 12px 0 4px; }
  .git-diff-cell.meta, .git-diff-cell.marker { color: var(--pi-dim); }
  .git-diff-cell.hunk { background: color-mix(in srgb, var(--pi-accent) 9%, transparent); color: var(--pi-accent); }
  .git-diff-cell.add { background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
  .git-diff-cell.remove { background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
  .git-content.add .inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-success) 36%, transparent); color: var(--pi-text); }
  .git-content.remove .inline-change { border-radius: 2px; background: color-mix(in srgb, var(--pi-danger) 36%, transparent); color: var(--pi-text); }
`;
