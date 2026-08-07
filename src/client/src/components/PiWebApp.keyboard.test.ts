// @vitest-environment happy-dom

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { AuthDialog } from "./AuthDialog";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("PiWebApp global shortcut modality boundary", () => {
  it("runs a global shortcut when the application has no open modal", () => {
    const app = new PiWebApp();
    const target = appendKeyTarget();
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(targetKeyDown).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "project dialog",
      open: (app: PiWebApp) => { setAppState(app, { projectDialogOpen: true }); },
    },
    {
      name: "authentication dialog",
      open: (app: PiWebApp) => { setAppState(app, { authDialog: { step: "method" } }); },
    },
    {
      name: "session cleanup dialog",
      open: (app: PiWebApp) => {
        if (!Reflect.set(app, "sessionCleanupDialog", { error: "" })) throw new Error("Could not open session cleanup dialog");
      },
    },
  ])("leaves keyboard handling with the $name", ({ open }) => {
    const app = new PiWebApp();
    open(app);
    const target = appendKeyTarget();
    const targetKeyDown = vi.fn();
    target.addEventListener("keydown", targetKeyDown);

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(targetKeyDown).toHaveBeenCalledOnce();
  });

  it("renders session-independent authentication before suppressing global shortcuts", async () => {
    const app = new PiWebApp();
    setAppState(app, { authDialog: { step: "method" } });
    const container = document.createElement("div");
    document.body.append(container);
    render(app.render(), container);
    const dialog = container.querySelector("auth-dialog");
    if (!(dialog instanceof AuthDialog)) throw new Error("Authentication dialog was not rendered");
    await dialog.updateComplete;

    const target = appendKeyTarget();
    const event = dispatchShortcutThroughApp(app, target);

    expect(dialog.isConnected).toBe(true);
    expect(actionPaletteIsOpen(app)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not suppress shortcuts for a session-scoped dialog that cannot render", () => {
    const app = new PiWebApp();
    setAppState(app, { modelDialog: { title: "Select model", options: [] } });
    const target = appendKeyTarget();

    const event = dispatchShortcutThroughApp(app, target);

    expect(actionPaletteIsOpen(app)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not return focus to the prompt while Settings remains open", () => {
    const app = new PiWebApp();
    const appShell: unknown = Reflect.get(app, "appShell");
    if (!isAutoFocusAppShell(appShell)) throw new Error("PiWebApp shell was unavailable");
    vi.spyOn(appShell, "shouldAutoFocusPrompt").mockReturnValue(true);

    expect(appShouldAutoFocusPrompt(app)).toBe(true);
    if (!Reflect.set(app, "settingsSection", "general")) throw new Error("Could not open Settings");

    expect(appShouldAutoFocusPrompt(app)).toBe(false);
  });
});

type AppKeyDownHandler = (event: KeyboardEvent) => void;

interface AutoFocusAppShell {
  shouldAutoFocusPrompt: () => boolean;
}

function dispatchShortcutThroughApp(app: PiWebApp, target: HTMLElement): KeyboardEvent {
  const handler: unknown = Reflect.get(app, "onKeyDown");
  if (!isAppKeyDownHandler(handler)) throw new Error("PiWebApp shortcut handler was unavailable");
  window.addEventListener("keydown", handler, { capture: true });
  const event = new KeyboardEvent("keydown", {
    key: "k",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  try {
    target.dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", handler, { capture: true });
  }
  return event;
}

function isAppKeyDownHandler(value: unknown): value is AppKeyDownHandler {
  return typeof value === "function";
}

function isAutoFocusAppShell(value: unknown): value is AutoFocusAppShell {
  return typeof value === "object" && value !== null && "shouldAutoFocusPrompt" in value
    && typeof value.shouldAutoFocusPrompt === "function";
}

function appShouldAutoFocusPrompt(app: PiWebApp): boolean {
  const decision: unknown = Reflect.get(app, "shouldAutoFocusPrompt");
  if (typeof decision !== "function") throw new Error("PiWebApp auto-focus decision was unavailable");
  const result: unknown = Reflect.apply(decision, app, []);
  if (typeof result !== "boolean") throw new Error("PiWebApp auto-focus decision was invalid");
  return result;
}

function actionPaletteIsOpen(app: PiWebApp): boolean {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null || !("actionPaletteOpen" in state) || typeof state.actionPaletteOpen !== "boolean") {
    throw new Error("PiWebApp action-palette state was unavailable");
  }
  return state.actionPaletteOpen;
}

function setAppState(app: PiWebApp, patch: Partial<AppState>): void {
  if (!Reflect.set(app, "state", { ...initialAppState(), ...patch })) throw new Error("Could not set PiWebApp state");
}

function appendKeyTarget(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Modal action";
  document.body.append(button);
  return button;
}
