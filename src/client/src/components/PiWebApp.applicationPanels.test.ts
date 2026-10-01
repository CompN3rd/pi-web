// @vitest-environment happy-dom

import { LitElement, html } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationPanelContext, PiWebPlugin, PiWebStatusResponse } from "../../../plugin-api";
import infoPlugin from "../../../../pi-web-plugins/info/pi-web-plugin";
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, terminalMode: "recovery-disabled",
    plugins: [{ id: "info", module: "info/pi-web-plugin.js", machineSpecific: false }],
  }))));
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
  expect(context?.terminal).toBeDefined();
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

async function mount(plugin: PiWebPlugin): Promise<ApplicationPanelsApp> {
  const app = new ApplicationPanelsApp();
  Reflect.set(app, "verifiedPluginModeByMachine", new Map([["local", "recovery-disabled"], ["remote", "recovery-disabled"]]));
  const loaded = await loadExternalPlugins(undefined, { moduleLoader: () => Promise.resolve({ default: plugin }) });
  expect(loaded.failures).toEqual([]);
  await registryFor(app).registerBatch(loaded.registrations, { declarations: loaded.declarations });
  Reflect.set(app, "state", { ...initialAppState(), workspaceTool: "info:workspace.info" });
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
