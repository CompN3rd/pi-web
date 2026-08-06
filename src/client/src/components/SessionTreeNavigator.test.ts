// @vitest-environment happy-dom

import type { TemplateResult } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateResult, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
// The modal-surface shell (focus on open, Escape/backdrop routing) is exercised
// through real DOM interaction; keyboard state and hierarchy stay covered through
// the pure sessionTreeModel, and TemplateResult extraction is limited to pointer
// row/confirmation wiring.
import { templateClickHandlerForText, templateEventHandlerNearMarker } from "../templateInspection.testSupport";
import { deepActiveElement, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { SessionTreeNavigator, sessionTreeEntryReturnsToEditor, sessionTreeVisualDepth } from "./SessionTreeNavigator";

type NavigateCallback = (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;
type VoidMethod = (this: SessionTreeNavigator) => void;
type PromiseMethod = (this: SessionTreeNavigator) => Promise<void>;
type SummaryModeMethod = (this: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]) => void;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("session-tree-navigator modal surface", () => {
  it("focuses the selected history row when opened", async () => {
    const navigator = await mountNavigator();

    expect(deepActiveElement()).toBe(treeRow(navigator, "active"));
  });

  it("focuses the close button when opened with an empty tree", async () => {
    const navigator = await mountNavigator({ tree: { nodes: [], activeLeafId: null, activePathIds: [] } });

    expect(deepActiveElement()).toBe(closeButton(navigator));
  });

  it("cancels from the tree step on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });

    pressKey(dialogSurface(navigator), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("returns to the tree step from confirmation on Escape instead of cancelling", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });
    await continueToConfirmation(navigator);

    pressKey(dialogSurface(navigator), "Escape");
    await settleRenderedDialog(navigator);

    expect(onCancel).not.toHaveBeenCalled();
    expect(renderedTree(navigator)).not.toBeNull();
  });

  // The surface owns one dismissal route, so a backdrop press steps back from
  // confirmation exactly like Escape instead of closing outright.
  it("steps back from confirmation on a backdrop press and cancels from the tree step", async () => {
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onCancel });
    await continueToConfirmation(navigator);

    backdropPress(navigator);
    await settleRenderedDialog(navigator);

    expect(onCancel).not.toHaveBeenCalled();
    expect(renderedTree(navigator)).not.toBeNull();

    backdropPress(navigator);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight summarization on Escape and swallows backdrop presses while busy", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onNavigate, onAbort, onCancel });
    await continueToConfirmation(navigator);
    summaryRadio(navigator, "default").click();
    await settleRenderedDialog(navigator);
    primaryFooterButton(navigator).click();
    await settleRenderedDialog(navigator);

    backdropPress(navigator);
    pressKey(dialogSurface(navigator), "Escape");

    expect(onCancel).not.toHaveBeenCalled();
    expect(onAbort).toHaveBeenCalledOnce();

    navigation.resolve({ cancelled: true, aborted: true });
    await settleRenderedDialog(navigator);
  });

  it("swallows Escape while a plain navigation is in flight", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const onCancel = vi.fn<() => void>();
    const navigator = await mountNavigator({ onNavigate, onAbort, onCancel });
    await continueToConfirmation(navigator);
    primaryFooterButton(navigator).click();
    await settleRenderedDialog(navigator);

    pressKey(dialogSurface(navigator), "Escape");

    expect(onAbort).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    navigation.resolve({ cancelled: false });
    await settleRenderedDialog(navigator);
  });
});

describe("session-tree-navigator interactions", () => {
  it("uses pointer selection for explicit navigation and retains it after cancellation", async () => {
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: true, aborted: true });
    navigator.onNavigate = onNavigate;

    templateClickHandlerForText(renderNavigator(navigator), "Side branch")(new Event("click"));
    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(onNavigate).toHaveBeenNthCalledWith(1, "side", { mode: "none" });
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(componentProperty(navigator, "statusMessage")).toContain("selected history entry is unchanged");

    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "side", { mode: "none" });
  });

  it("restores the valid no-summary default after leaving an incomplete custom choice", async () => {
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    navigator.onNavigate = onNavigate;

    clickTreeNavigate(navigator);
    callSummaryModeMethod(navigator, "custom");
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).not.toHaveBeenCalled();

    callVoidMethod(navigator, "returnToTree");
    clickTreeNavigate(navigator);

    expect(componentProperty(navigator, "summaryMode")).toBe("none");
    await callPromiseMethod(navigator, "submitNavigation");
    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "none" });
  });

  it("submits trimmed custom focus, exposes busy cancellation, and returns to the same node", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const navigator = initializedNavigator();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    navigator.onNavigate = onNavigate;
    navigator.onAbort = onAbort;

    clickTreeNavigate(navigator);
    callSummaryModeMethod(navigator, "custom");
    setComponentProperty(navigator, "customInstructions", "  focus on failed tests  ");

    const submission = callPromiseMethod(navigator, "submitNavigation");
    expect(componentProperty(navigator, "busy")).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "custom", instructions: "focus on failed tests" });

    await callPromiseMethod(navigator, "abortNavigation");
    expect(onAbort).toHaveBeenCalledOnce();
    expect(componentProperty(navigator, "aborting")).toBe(true);

    navigation.resolve({ cancelled: true, aborted: true });
    await submission;
    expect(componentProperty(navigator, "busy")).toBe(false);
    expect(componentProperty(navigator, "selectedId")).toBe("active");
    expect(componentProperty(navigator, "step")).toBe("tree");
  });

  it("clears transient cancelling status if navigation rejects after abort", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const navigator = initializedNavigator();
    navigator.onNavigate = () => navigation.promise;
    navigator.onAbort = () => Promise.resolve();

    clickTreeNavigate(navigator);
    callSummaryModeMethod(navigator, "default");
    const submission = callPromiseMethod(navigator, "submitNavigation");
    await callPromiseMethod(navigator, "abortNavigation");
    expect(componentProperty(navigator, "statusMessage")).toBe("Cancelling summarization…");

    navigation.reject(new Error("remote operation failed"));
    await submission;

    expect(componentProperty(navigator, "statusMessage")).toBe("");
    expect(componentProperty(navigator, "error")).toBe("Could not navigate session history: remote operation failed");
  });

  it("keeps navigation failures actionable and local to the confirmation step", async () => {
    const navigator = initializedNavigator();
    navigator.onNavigate = () => Promise.reject(new Error("The session changed since /tree was opened. Reopen /tree and try again."));

    clickTreeNavigate(navigator);
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "step")).toBe("confirm");
    expect(componentProperty(navigator, "busy")).toBe(false);
    expect(componentProperty(navigator, "error")).toBe("Could not navigate session history: The session changed since /tree was opened. Reopen /tree and try again.");
  });

  it("focuses the active leaf selected when the dialog opens", () => {
    const navigator = initializedNavigator();
    const activeFocus = vi.fn();
    const activeScroll = vi.fn();
    const root = {
      querySelector: () => null,
      querySelectorAll: () => [
        { dataset: { treeNodeId: "root" }, focus: vi.fn(), scrollIntoView: vi.fn() },
        { dataset: { treeNodeId: "active" }, focus: activeFocus, scrollIntoView: activeScroll },
      ],
    };
    if (!Reflect.set(navigator, "renderRoot", root)) throw new Error("Could not install navigator render root");

    callVoidMethod(navigator, "focusSelectedTreeItem");

    expect(activeFocus).toHaveBeenCalledOnce();
    expect(activeScroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("keeps an empty tree inert and moves initial focus to the close boundary", async () => {
    const navigator = new SessionTreeNavigator();
    navigator.tree = { nodes: [], activeLeafId: null, activePathIds: [] };
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    navigator.onNavigate = onNavigate;
    const closeFocus = vi.fn();
    const root = {
      querySelector: (selector: string) => selector === ".close-button" ? { focus: closeFocus } : null,
      querySelectorAll: () => [],
    };
    if (!Reflect.set(navigator, "renderRoot", root)) throw new Error("Could not install navigator render root");
    callVoidMethod(navigator, "resetTree");

    callVoidMethod(navigator, "focusSelectedTreeItem");
    callVoidMethod(navigator, "continueToConfirmation");
    await callPromiseMethod(navigator, "submitNavigation");

    expect(componentProperty(navigator, "selectedId")).toBeUndefined();
    expect(componentProperty(navigator, "step")).toBe("tree");
    expect(closeFocus).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("describes Pi's editor-return semantics and bounds pathological visual indentation", () => {
    expect(sessionTreeEntryReturnsToEditor("user")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("custom-message")).toBe(true);
    expect(sessionTreeEntryReturnsToEditor("assistant")).toBe(false);
    expect(sessionTreeEntryReturnsToEditor("tool-result")).toBe(false);
    expect(sessionTreeVisualDepth(-1)).toBe(0);
    expect(sessionTreeVisualDepth(7)).toBe(7);
    expect(sessionTreeVisualDepth(20_000)).toBe(8);
  });
});

interface MountedNavigatorProps {
  tree?: SessionTreeSnapshot;
  onNavigate?: NavigateCallback;
  onAbort?: () => Promise<void>;
  onCancel?: () => void;
}

async function mountNavigator(props: MountedNavigatorProps = {}): Promise<SessionTreeNavigator> {
  const navigator = new SessionTreeNavigator();
  navigator.tree = props.tree ?? tree();
  navigator.onNavigate = props.onNavigate ?? (() => Promise.resolve({ cancelled: false }));
  if (props.onAbort !== undefined) navigator.onAbort = props.onAbort;
  if (props.onCancel !== undefined) navigator.onCancel = props.onCancel;
  document.body.append(navigator);
  await settleRenderedDialog(navigator);
  return navigator;
}

async function continueToConfirmation(navigator: SessionTreeNavigator): Promise<void> {
  primaryFooterButton(navigator).click();
  await settleRenderedDialog(navigator);
}

function treeRow(navigator: SessionTreeNavigator, nodeId: string): HTMLElement {
  return requiredElement(navigator.shadowRoot?.querySelector<HTMLElement>(`[data-tree-node-id='${nodeId}']`), `navigator tree row ${nodeId}`);
}

function renderedTree(navigator: SessionTreeNavigator): Element | null {
  return navigator.shadowRoot?.querySelector("[role='tree']") ?? null;
}

function closeButton(navigator: SessionTreeNavigator): HTMLElement {
  return requiredElement(navigator.shadowRoot?.querySelector<HTMLElement>(".close-button"), "navigator close button");
}

function primaryFooterButton(navigator: SessionTreeNavigator): HTMLButtonElement {
  return requiredElement(navigator.shadowRoot?.querySelector<HTMLButtonElement>("footer button.primary"), "navigator primary footer button");
}

function summaryRadio(navigator: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]): HTMLInputElement {
  return requiredElement(navigator.shadowRoot?.querySelector<HTMLInputElement>(`input[name='session-tree-summary'][value='${mode}']`), `navigator ${mode} summary radio`);
}

function backdropPress(navigator: SessionTreeNavigator): void {
  surfaceBackdrop(navigator).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
}

function initializedNavigator(): SessionTreeNavigator {
  const navigator = new SessionTreeNavigator();
  navigator.tree = tree();
  callVoidMethod(navigator, "resetTree");
  return navigator;
}

function tree(): SessionTreeSnapshot {
  return {
    nodes: [
      { id: "root", parentId: null, kind: "user", summary: "Initial prompt" },
      { id: "active", parentId: "root", kind: "assistant", summary: "Active answer" },
      { id: "side", parentId: "root", kind: "assistant", summary: "Side branch" },
    ],
    activeLeafId: "active",
    activePathIds: ["root", "active"],
  };
}

function renderNavigator(navigator: SessionTreeNavigator): TemplateResult {
  return navigator.render();
}

function clickTreeNavigate(navigator: SessionTreeNavigator): void {
  templateEventHandlerNearMarker(renderNavigator(navigator), ">Navigate</button>")(new Event("click"));
}

function componentProperty(navigator: SessionTreeNavigator, property: string): unknown {
  return Reflect.get(navigator, property);
}

function setComponentProperty(navigator: SessionTreeNavigator, property: string, value: unknown): void {
  if (!Reflect.set(navigator, property, value)) throw new Error(`Could not set navigator property ${property}`);
}

function callVoidMethod(navigator: SessionTreeNavigator, methodName: string): void {
  const method: unknown = Reflect.get(navigator, methodName);
  if (!isVoidMethod(method)) throw new Error(`SessionTreeNavigator.${methodName} is not callable`);
  method.call(navigator);
}

async function callPromiseMethod(navigator: SessionTreeNavigator, methodName: string): Promise<void> {
  const method: unknown = Reflect.get(navigator, methodName);
  if (!isPromiseMethod(method)) throw new Error(`SessionTreeNavigator.${methodName} is not callable`);
  await method.call(navigator);
}

function callSummaryModeMethod(navigator: SessionTreeNavigator, mode: SessionTreeSummaryChoice["mode"]): void {
  const method: unknown = Reflect.get(navigator, "selectSummaryMode");
  if (!isSummaryModeMethod(method)) throw new Error("SessionTreeNavigator.selectSummaryMode is not callable");
  method.call(navigator, mode);
}

function isVoidMethod(value: unknown): value is VoidMethod {
  return typeof value === "function";
}

function isPromiseMethod(value: unknown): value is PromiseMethod {
  return typeof value === "function";
}

function isSummaryModeMethod(value: unknown): value is SummaryModeMethod {
  return typeof value === "function";
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
