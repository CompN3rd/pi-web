// @vitest-environment happy-dom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationPanelContext, PiWebPlugin, PiWebStatusResponse, PluginSelectionService, WorkspacePanelTerminal } from "../../../plugin-api";
import infoPlugin from "../../../../pi-web-plugins/info/pi-web-plugin";
import updatesPlugin from "../../../../pi-web-plugins/updates/pi-web-plugin";
import type { RequiredTerminalBrowserComposition, RequiredTerminalBrowserFacadeV1 } from "../plugins/requiredTerminalFacade";
import { initialAppState, type AppState } from "../appState";
import { PI_WEB_PLUGIN_LIFECYCLE_VERSION } from "../../../shared/apiTypes";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import { PiWebApp } from "./PiWebApp";
import { WorkspacePanel } from "./WorkspacePanel";

// Keep real shell, registry, loader and public callback adaptation; omit socket/API startup.
class ApplicationPanelsApp extends PiWebApp {
  override connectedCallback(): void { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define("application-panels-test-app", ApplicationPanelsApp);

const workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const project = { id: "project", name: "Project", path: "/repo", createdAt: "now" };
const remote = { id: "remote", name: "Remote box", kind: "remote" as const, createdAt: "now", updatedAt: "now" };

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // Layout/scroll scheduling is not the behavior under test.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses bundled Info with no project, workspace or session and follows selection without reactivation", async () => {
  const activate = vi.fn(infoPlugin.activate);
  const app = await mount({ ...infoPlugin, activate });
  const panel = toolSurface(app);
  expect(panel.shadowRoot?.textContent).toContain("PI WEB status is not available yet");
  expect(panel.shadowRoot?.textContent).toContain("Machine");
  expect(panel.shadowRoot?.textContent).not.toContain("Workspace");
  expect(panel.shadowRoot?.querySelector('[aria-label="Info"]')).not.toBeNull();
  const status: PiWebStatusResponse = {
    packageName: "@jmfederico/pi-web", generatedAt: "now",
    components: {
      web: { component: "web", label: "Web/UI", runtimeVersion: "1.202610.0", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false }, commands: {}, messages: [],
  };
  patchState(app, { piWebStatus: status });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("1.202610.0");
  expect(panel.shadowRoot?.textContent).toContain("Services");

  patchState(app, { selectedMachine: remote, selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("Remote box");
  expect(panel.shadowRoot?.textContent).toContain("remote machine");
  expect(panel.shadowRoot?.textContent).toContain("Workspace");
  expect(panel.shadowRoot?.textContent).toContain("/repo");
  expect(app.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot?.querySelector("workspace-list")?.shadowRoot?.textContent).toContain("folder");

  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);
  expect(panel.shadowRoot?.textContent).toContain("Remote box");
  expect(panel.shadowRoot?.textContent).not.toContain("/repo");
  expect(activate).toHaveBeenCalledOnce();
});

it("gives public callbacks fresh basic selections and keeps workspace-only tabs out until selected", async () => {
  const contexts: ApplicationPanelContext[] = [];
  const plugin: PiWebPlugin = {
    apiVersion: 4, name: "Selection probe",
    activate: () => ({ contributions: { applicationPanels: [{
      id: "workspace.info", title: "Info", badge: (context) => context.state.selectedProject?.name,
      render: (context) => { contexts.push(context); return html`<p>${context.state.selectedSession?.name ?? "No session"}</p>`; },
    }] } }),
  };
  const app = await mount(plugin);
  const registry = registryFor(app);
  const workspaceRender = vi.fn(() => html`<p>Workspace only</p>`);
  await registry.register({ id: "workspace-only", plugin: { apiVersion: 4, name: "Workspace only", activate: () => ({
    contributions: { workspacePanels: [{ id: "panel", title: "Workspace only", render: workspaceRender }] },
  }) } });
  patchState(app, { error: "Unrelated update" });
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).not.toContain("Workspace only");
  expect(workspaceRender).not.toHaveBeenCalled();
  expect(contexts.at(-1)?.workspace).toBeUndefined();
  expect(contexts.at(-1)?.terminal).toBeUndefined();

  const session = { id: "session", name: "Conversation", cwd: "/repo", path: "/private/session.jsonl", created: "now", modified: "now", messageCount: 1, firstMessage: "private" };
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, selectedSession: session, workspaces: [workspace] });
  await settle(app);
  const context = contexts.at(-1);
  expect(context?.state.selectedProject).toEqual({ id: "project", name: "Project", path: "/repo" });
  expect(context?.state.selectedWorkspace).not.toHaveProperty("effectiveConfig");
  expect(context?.state.selectedSession).toEqual({ id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false });
  expect(context?.state).not.toHaveProperty("messages");
  expect(context?.state.selectedSession).not.toHaveProperty("path");
  expect(context?.workspace?.id).toBe("workspace");
  expect(context?.terminal).toBeUndefined(); // Terminal-disabled recovery still supplies workspace information.
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Conversation");
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Workspace only");
  expect(toolSurface(app).shadowRoot?.querySelector('[aria-label="Info, Project"]')).not.toBeNull();

  patchState(app, { selectedSession: { ...session, name: "Renamed" } });
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Renamed");
  contexts.at(-1)?.host.requestRender();
  await settle(app);
  expect(contexts.at(-1)).not.toBe(context);
});

it("supplies an external plugin live selection while its panel is closed, with early and lifetime unsubscribe", async () => {
  let selection: PluginSelectionService | undefined;
  const received = vi.fn();
  const early = vi.fn();
  let unsubscribe: () => void = () => undefined;
  const render = vi.fn(() => html`<p>Selection observer</p>`);
  const activate = vi.fn<PiWebPlugin["activate"]>((context) => {
    expect(context.apiVersion).toBe(4);
    selection = context.selection;
    if (selection === undefined) throw new Error("Missing public selection service");
    selection.subscribe(received);
    unsubscribe = selection.subscribe(early);
    return { contributions: { applicationPanels: [
      { id: "workspace.selection", title: "Selection", render },
      { id: "other", title: "Other", render: () => html`<p>Other tab</p>` },
    ] } };
  });
  const app = await mount({ apiVersion: 4, name: "Selection observer", activate }, {
    id: "selection", state: { workspaceTool: "selection:other" },
  });
  expect(selection?.getSnapshot()).toEqual({});
  expect(received).not.toHaveBeenCalled(); // subscribe is not an initial notification.
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Other tab");
  expect(render).not.toHaveBeenCalled();

  patchState(app, { selectedMachine: remote });
  expect(selection?.getSnapshot().selectedMachine).toEqual({ id: "remote", name: "Remote box", kind: "remote" });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({ selectedMachine: { id: "remote", name: "Remote box", kind: "remote" } });
  unsubscribe();
  unsubscribe();
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({
    selectedMachine: { id: "remote", name: "Remote box", kind: "remote" },
    selectedProject: { id: "project", name: "Project", path: "/repo" },
    selectedWorkspace: { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true },
  });
  expect(early).toHaveBeenCalledOnce();

  const session = { id: "session", name: "Conversation", cwd: "/repo", path: "/private/session.jsonl",
    created: "now", modified: "now", messageCount: 1, firstMessage: "private" };
  // Exercise the same state commit used by host controllers, not a service-only publish.
  const setState: unknown = Reflect.get(app, "setState");
  if (typeof setState !== "function") throw new Error("Expected host state commit");
  Reflect.apply(setState, app, [{ selectedSession: session }]);
  expect(selection?.getSnapshot().selectedSession).toEqual({ id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith(expect.objectContaining({
    selectedSession: { id: "session", name: "Conversation", cwd: "/repo", archived: false, pending: false },
  }));
  patchState(app, { selectedSession: { ...session, name: "Renamed", archived: true } });
  await settle(app);
  expect(selection?.getSnapshot().selectedSession).toEqual({ id: "session", name: "Renamed", cwd: "/repo", archived: true, pending: false });
  const notifications = received.mock.calls.length;
  patchState(app, { error: "Unrelated update", mainView: "chat", piWebStatus: updatesStatus });
  await settle(app);
  expect(received).toHaveBeenCalledTimes(notifications);
  expect(selection?.getSnapshot()).not.toHaveProperty("mainView");
  expect(selection?.getSnapshot()).not.toHaveProperty("piWebStatus");
  expect(render).not.toHaveBeenCalled();

  patchState(app, { selectedMachine: undefined, selectedProject: undefined, selectedWorkspace: undefined, selectedSession: undefined });
  await settle(app);
  expect(received).toHaveBeenLastCalledWith({});
  toolSurface(app).shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Selection"]')?.click();
  await settle(app);
  expect(render).toHaveBeenCalled();
  expect(activate).toHaveBeenCalledOnce();
  const beforeShutdown = received.mock.calls.length;
  app.remove(); // Real host disconnect aborts the plugin lifetime before disposal.
  const late = vi.fn();
  selection?.subscribe(late);
  patchState(app, { selectedMachine: remote });
  registryFor(app).notifySelectionChanged();
  expect(received).toHaveBeenCalledTimes(beforeShutdown);
  expect(late).not.toHaveBeenCalled();
});

it("opens an application tab through existing navigation without a workspace and retains invalid-tool errors", async () => {
  const app = await mount(infoPlugin);
  const tabs = app.shadowRoot?.querySelector("app-mobile-main-tabs");
  tabs?.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Info"]')?.click();
  await settle(app);
  expect(new URL(window.location.href).searchParams.get("tool")).toBe("info:workspace.info");
  expect(new URL(window.location.href).searchParams.get("view")).toBe("workspace");
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Machine");

  window.history.replaceState(null, "", "?tool=missing%3Apanel&view=workspace");
  app.requestUpdate();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.textContent).toContain("Workspace panel unavailable: missing:panel");
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")).toBeNull();
  toolSurface(app).shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Info"]')?.click();
  await settle(app);
  expect(toolSurface(app).shadowRoot?.querySelector(".panel-content")?.textContent).toContain("Machine");
});

it("shows bundled Updates guidance and Copy without selections, retaining visibility, badges and identity", async () => {
  const activate = vi.fn(updatesPlugin.activate);
  const app = await mount({ ...updatesPlugin, activate }, { id: "updates", state: { piWebStatus: updatesStatus } });
  const panel = toolSurface(app);
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  expect(panel.shadowRoot?.textContent).toContain("PI WEB update available");
  expect(panel.shadowRoot?.textContent).toContain("Installed services");
  expect(panel.shadowRoot?.querySelector('[aria-label="Updates, 1"]')).not.toBeNull();
  expect(commandButtons(panel, "Run")).toHaveLength(0);
  commandButtons(panel, "Copy")[0]?.click();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("pi-web-docker update");
  expect(registryFor(app).resolveWorkspacePanelRouteId("updates:workspace.updates", "local")).toBe("updates:workspace.updates");
  expect(registryFor(app).getWorkspacePanels()).toEqual([]);
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0); // Workspace selection alone cannot enable Terminal-disabled recovery.
  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);

  panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Updates, 1"]')?.click();
  await settle(app);
  expect(new URL(window.location.href).searchParams.get("tool")).toBe("updates:workspace.updates");

  patchState(app, { piWebStatus: { ...updatesStatus, messages: [] } });
  await settle(app);
  expect(panel.shadowRoot?.querySelector('[aria-label="Updates"]')).not.toBeNull();
  const managed = { kind: "pi-package" as const };
  patchState(app, { piWebStatus: {
    ...updatesStatus, messages: [],
    components: {
      web: { ...updatesStatus.components.web, installation: managed },
      sessiond: { ...updatesStatus.components.sessiond, installation: managed },
    },
  } });
  await settle(app);
  expect(panel.shadowRoot?.querySelector('[aria-label="Updates"]')).toBeNull();
  expect(activate).toHaveBeenCalledOnce();
});

it("offers Updates Run only with a selected-workspace Terminal on the current machine and rejects stale clicks", async () => {
  const app = await mount(updatesPlugin, { id: "updates", state: { piWebStatus: updatesStatus } });
  const panel = toolSurface(app);
  const { createWorkspaceTerminal, runCommand } = installTerminal(app, "local");
  app.requestUpdate();
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0); // A provider alone is not a machine command facility.

  window.history.replaceState(null, "", "?project=project&workspace=workspace&tool=updates%3Aworkspace.updates&view=workspace");
  patchState(app, { selectedProject: project, selectedWorkspace: workspace, workspaces: [workspace] });
  await settle(app);
  const run = commandButtons(panel, "Run")[0];
  if (run === undefined) throw new Error("Expected Updates Run with a workspace Terminal");
  run.click();
  expect(createWorkspaceTerminal).toHaveBeenCalledOnce();
  expect(createWorkspaceTerminal.mock.calls[0]?.[0]).toMatchObject({
    origin: "updates", registrationPluginId: "pi-web.terminal", workspace,
  });
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({
    title: "Update & restart everything", command: "pi-web-docker update", open: true, metadata: { "pi.plugin": "updates" },
  });

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "?machine=remote&project=project&workspace=workspace&tool=updates%3Aworkspace.updates&view=workspace");
  patchState(app, { selectedMachine: remote });
  run.click(); // A retained local callback must not run after selection changed, even before rerender.
  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith(
      'Updates plugin failed to run "Update & restart everything"', expect.objectContaining({ message: "Workspace panel context is no longer current" }),
    );
  });
  expect(createWorkspaceTerminal).toHaveBeenCalledOnce();
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0); // Never borrow the gateway Terminal.
  expect(commandButtons(panel, "Copy").length).toBeGreaterThan(0);

  const { createWorkspaceTerminal: remoteTerminal } = installTerminal(app, "remote");
  app.requestUpdate();
  await settle(app);
  const remoteRun = commandButtons(panel, "Run")[0];
  expect(remoteRun).toBeDefined();
  expect(new URL(window.location.href).searchParams.get("machine")).toBe("remote");
  remoteRun?.click();
  expect(remoteTerminal).toHaveBeenCalledOnce();
  expect(remoteTerminal.mock.calls[0]?.[0]).toMatchObject({
    origin: "updates", registrationPluginId: "remote-terminal", workspace,
  });
  expect(createWorkspaceTerminal).toHaveBeenCalledOnce();

  patchState(app, { selectedProject: undefined, selectedWorkspace: undefined });
  await settle(app);
  expect(commandButtons(panel, "Run")).toHaveLength(0);
  expect(commandButtons(panel, "Copy").length).toBeGreaterThan(0);
});

const updatesStatus: PiWebStatusResponse = {
  packageName: "@jmfederico/pi-web", generatedAt: "now",
  components: {
    web: { component: "web", label: "Web/UI", stale: false, available: true, installation: { kind: "docker" } },
    sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true, installation: { kind: "docker" } },
  },
  release: { packageName: "@jmfederico/pi-web", updateAvailable: true },
  commands: { update: "pi-web-docker update" },
  messages: [{ id: "update", severity: "info", title: "PI WEB update available", body: "Update and restart to use the new release." }],
};

// Inject only Terminal's command boundary; the shell, public loader, registry and freshness facade remain real.
function installTerminal(app: PiWebApp, machineId: string) {
  const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>((input) => {
    const run = {
      id: "run", origin: "updates", projectId: workspace.projectId, workspaceId: workspace.id,
      terminalId: "terminal", title: input.title, command: input.command, status: "succeeded" as const, createdAt: "now", metadata: {},
    };
    return Promise.resolve({ run, completed: Promise.resolve(run) });
  });
  const createWorkspaceTerminal = vi.fn<RequiredTerminalBrowserFacadeV1["createWorkspaceTerminal"]>(() => ({
    open: () => undefined, runCommand,
  }));
  const composition: RequiredTerminalBrowserComposition = {
    binding: {
      registrationPluginId: machineId === "local" ? "pi-web.terminal" : "remote-terminal",
      sourcePluginId: "pi-web.terminal", backendRevision: `${machineId}-revision`, pairedRequestVersion: 1, pairedChannelVersion: 1,
    },
    facade: {
      version: 1, createWorkspaceTerminal, listCommandRuns: () => Promise.resolve([]),
      parseCommandRun: () => { throw new Error("Unexpected command parsing"); },
    },
  };
  const compositions: unknown = Reflect.get(app, "requiredTerminalByMachine");
  if (!(compositions instanceof Map)) throw new Error("Expected Terminal compositions");
  compositions.set(machineId, composition);
  // Production plugin loading invalidates the guarded surface when composition becomes available.
  const invalidate: unknown = Reflect.get(app, "invalidateWorkspaceSurface");
  if (typeof invalidate !== "function") throw new Error("Expected workspace surface invalidation");
  Reflect.apply(invalidate, app, []);
  return { createWorkspaceTerminal, runCommand };
}

function commandButtons(panel: WorkspacePanel, label: string): HTMLButtonElement[] {
  return [...panel.shadowRoot?.querySelectorAll<HTMLButtonElement>(".updates-command-actions button") ?? []].filter((button) => button.textContent === label);
}

async function mount(plugin: PiWebPlugin, { id = "info", state = {} }: { id?: string; state?: Partial<AppState> } = {}): Promise<ApplicationPanelsApp> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, terminalMode: "recovery-disabled",
    plugins: [{ id, module: `${id}/pi-web-plugin.js`, machineSpecific: false }],
  }))));
  const app = new ApplicationPanelsApp();
  Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"], ["remote", "recovery-disabled"]]));
  const loaded = await loadExternalPlugins(undefined, { moduleLoader: () => Promise.resolve({ default: plugin }) });
  expect(loaded.failures).toEqual([]);
  await registryFor(app).registerBatch(loaded.registrations, { declarations: loaded.declarations });
  Reflect.set(app, "state", { ...initialAppState(), workspaceTool: `${id}:workspace.${id}`, ...state });
  document.body.append(app);
  await settle(app);
  return app;
}

function registryFor(app: PiWebApp): PluginRegistry {
  const registry: unknown = Reflect.get(app, "plugins");
  if (!(registry instanceof PluginRegistry)) throw new Error("Expected plugin registry");
  return registry;
}

function toolSurface(app: PiWebApp): WorkspacePanel {
  const panel = app.shadowRoot?.querySelector("workspace-panel");
  if (!(panel instanceof WorkspacePanel)) throw new Error("Expected tool surface");
  return panel;
}

function patchState(app: PiWebApp, patch: Partial<AppState>): void {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("Expected app state");
  Reflect.set(app, "state", { ...state, ...patch });
}

async function settle(element: LitElement): Promise<void> {
  await element.updateComplete;
  for (const child of element.shadowRoot?.querySelectorAll("*") ?? []) {
    if (child instanceof LitElement) await settle(child);
  }
  await element.updateComplete;
}
