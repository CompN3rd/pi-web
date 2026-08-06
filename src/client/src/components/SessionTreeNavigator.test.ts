// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateResult, SessionTreeSnapshot, SessionTreeSummaryChoice } from "../api";
import { SessionTreeNavigator, sessionTreeEntryReturnsToEditor, sessionTreeVisualDepth } from "./SessionTreeNavigator";

type NavigateCallback = (targetId: string, summaryChoice: SessionTreeSummaryChoice) => Promise<SessionTreeNavigateResult>;

describe("session-tree-navigator location step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps operation selection out of step 1 and offers only Cancel and Next", async () => {
    const navigator = await mountNavigator();

    expect(footerLabels(navigator)).toEqual(["Cancel", "Next"]);
    expect(shadowText(navigator)).toContain("Select the history entry where you would like to continue.");
    expect(navigator.renderRoot.querySelector("input[name='session-tree-operation']")).toBeNull();
    expect(footerButton(navigator, "Next").classList.contains("primary")).toBe(true);
    expect(footerButton(navigator, "Next").disabled).toBe(false);
  });

  it("keeps an empty history inert", async () => {
    const navigator = await mountNavigator({ nodes: [], activeLeafId: null, activePathIds: [] });

    expect(shadowText(navigator)).toContain("does not contain any selectable history entries");
    expect(footerLabels(navigator)).toEqual(["Cancel", "Next"]);
    expect(footerButton(navigator, "Next").disabled).toBe(true);
  });

  it("ignores f and F but advances with Enter", async () => {
    const navigator = await mountNavigator();
    const selected = treeItem(navigator, "active");

    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "F", bubbles: true }));
    await settle(navigator);

    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(navigator.renderRoot.querySelector("h2")).toBeNull();

    selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(footerLabels(navigator)).toEqual(["Back", "Continue from here"]);
  });

  it("moves focus across steps and traps Tab in the dialog", async () => {
    const navigator = await mountNavigator();
    const next = footerButton(navigator, "Next");

    expect(navigator.shadowRoot?.activeElement).toBe(treeItem(navigator, "active"));

    next.focus();
    dialogElement(navigator).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(navigator.shadowRoot?.activeElement).toBe(closeButton(navigator));

    dialogElement(navigator).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(navigator.shadowRoot?.activeElement).toBe(next);

    next.click();
    await settle(navigator);
    expect(navigator.shadowRoot?.activeElement).toBe(operationRadio(navigator, "continue"));

    footerButton(navigator, "Back").click();
    await settle(navigator);
    expect(navigator.shadowRoot?.activeElement).toBe(treeItem(navigator, "active"));
  });

  it("uses Back and Escape to revisit location, then Escape to cancel", async () => {
    const onCancel = vi.fn();
    const navigator = await mountNavigator();
    navigator.onCancel = onCancel;

    await advanceToAction(navigator);
    footerButton(navigator, "Back").click();
    await settle(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();

    await advanceToAction(navigator);
    dialogElement(navigator).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();

    treeItem(navigator, "active").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("session-tree-navigator action step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults to Continue, keeps operation and summary choices distinct, and hides summaries for Fork", async () => {
    const navigator = await mountNavigator();
    await advanceToAction(navigator);

    expect(fieldsetByLegend(navigator, "How would you like to continue?")).toBeTruthy();
    expect(operationRadio(navigator, "continue").checked).toBe(true);
    expect(operationRadio(navigator, "fork").checked).toBe(false);
    expect(operationRadio(navigator, "continue").parentElement?.textContent).toContain("Continue in this session");
    expect(operationRadio(navigator, "fork").parentElement?.textContent).toContain("Fork into a new session");
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeTruthy();
    expect(summaryRadio(navigator, "none").checked).toBe(true);
    expect(footerButton(navigator, "Continue from here")).toBeTruthy();
    expect(selectedEntryText(navigator)).toContain("prompt editor will be empty");

    operationRadio(navigator, "fork").click();
    await settle(navigator);

    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(navigator.renderRoot.querySelector("input[name='session-tree-summary']")).toBeNull();
    expect(selectedEntryText(navigator)).toContain("include this entry and all history leading to it");
    expect(shadowText(navigator)).toContain("separate session file while leaving the original unchanged");
    expect(footerButton(navigator, "Fork into new session")).toBeTruthy();

    operationRadio(navigator, "continue").click();
    await settle(navigator);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeTruthy();
    expect(footerButton(navigator, "Continue from here")).toBeTruthy();
  });

  it("explains user-message restoration for same-session continuation and forks", async () => {
    const navigator = await mountNavigator();
    treeItem(navigator, "root").click();
    await settle(navigator);
    await advanceToAction(navigator);

    expect(selectedEntryText(navigator)).toContain("text will return to the prompt editor for optional editing and resubmission in this session");

    operationRadio(navigator, "fork").click();
    await settle(navigator);
    expect(selectedEntryText(navigator)).toContain("branch before this user message");
    expect(selectedEntryText(navigator)).toContain("new session draft");
  });

  it("dispatches the final action to the selected callback and retains location after cancellation", async () => {
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: true });
    const onFork = vi.fn(() => Promise.resolve());
    const navigator = await mountNavigator();
    navigator.onNavigate = onNavigate;
    navigator.onFork = onFork;

    treeItem(navigator, "side").click();
    await settle(navigator);
    await advanceToAction(navigator);
    footerButton(navigator, "Continue from here").click();
    await settle(navigator);

    expect(onNavigate).toHaveBeenCalledWith("side", { mode: "none" });
    expect(onFork).not.toHaveBeenCalled();
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(shadowText(navigator)).toContain("selected history entry is unchanged");

    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settle(navigator);
    footerButton(navigator, "Fork into new session").click();
    await settle(navigator);

    expect(onFork).toHaveBeenCalledWith("side");
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("validates custom summary focus without submitting", async () => {
    const onNavigate = vi.fn<NavigateCallback>().mockResolvedValue({ cancelled: false });
    const navigator = await mountNavigator();
    navigator.onNavigate = onNavigate;
    await advanceToAction(navigator);

    summaryRadio(navigator, "custom").click();
    await settle(navigator);
    footerButton(navigator, "Continue from here").click();
    await settle(navigator);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(navigator.renderRoot.querySelector(".validation-error[role='alert']")?.textContent).toContain("Enter custom summary focus instructions");
    expect(navigator.shadowRoot?.activeElement).toBe(customFocus(navigator));
  });

  it("submits trimmed custom focus and exposes disabled busy controls and cancellation", async () => {
    const navigation = deferred<SessionTreeNavigateResult>();
    const onNavigate = vi.fn<NavigateCallback>(() => navigation.promise);
    const onAbort = vi.fn(() => Promise.resolve());
    const navigator = await mountNavigator();
    navigator.onNavigate = onNavigate;
    navigator.onAbort = onAbort;
    await advanceToAction(navigator);

    summaryRadio(navigator, "custom").click();
    await settle(navigator);
    const textarea = customFocus(navigator);
    textarea.value = "  focus on failed tests  ";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle(navigator);
    footerButton(navigator, "Continue from here").click();
    await settle(navigator);

    expect(onNavigate).toHaveBeenCalledWith("active", { mode: "custom", instructions: "focus on failed tests" });
    expect(fieldsetByLegend(navigator, "How would you like to continue?")?.disabled).toBe(true);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")?.disabled).toBe(true);
    expect(closeButton(navigator).disabled).toBe(true);
    expect(footerButton(navigator, "Back").disabled).toBe(true);
    expect(footerButton(navigator, "Summarizing…").disabled).toBe(true);
    expect(footerButton(navigator, "Cancel summarization").disabled).toBe(false);

    dialogElement(navigator).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(navigator);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(footerButton(navigator, "Cancelling…").disabled).toBe(true);

    navigation.resolve({ cancelled: true, aborted: true });
    await settle(navigator);
    expect(navigator.renderRoot.querySelector("[role='tree']")).toBeTruthy();
    expect(shadowText(navigator)).toContain("Summarization cancelled");
  });

  it("keeps navigation failures visible and actionable in step 2", async () => {
    const navigator = await mountNavigator();
    navigator.onNavigate = () => Promise.reject(new Error("The session changed since /tree was opened."));
    await advanceToAction(navigator);

    footerButton(navigator, "Continue from here").click();
    await settle(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(navigator.renderRoot.querySelector(".dialog-error[role='alert']")?.textContent).toContain("Could not navigate session history: The session changed since /tree was opened.");
    expect(footerButton(navigator, "Continue from here").disabled).toBe(false);
  });

  it("keeps fork failures visible in step 2 without showing summary controls", async () => {
    const navigator = await mountNavigator();
    navigator.onFork = () => Promise.reject(new Error("Restart the session daemon to enable tree forks."));
    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settle(navigator);

    footerButton(navigator, "Fork into new session").click();
    await settle(navigator);

    expect(navigator.renderRoot.querySelector("h2")?.textContent).toBe("Choose how to continue");
    expect(navigator.renderRoot.querySelector(".dialog-error[role='alert']")?.textContent).toContain("Restart the session daemon to enable tree forks.");
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(footerButton(navigator, "Fork into new session").disabled).toBe(false);
  });

  it("disables the unified step while a fork is in flight", async () => {
    let resolveFork: () => void = () => undefined;
    const forkPromise = new Promise<void>((resolve) => { resolveFork = resolve; });
    const navigator = await mountNavigator();
    navigator.onFork = () => forkPromise;
    await advanceToAction(navigator);
    operationRadio(navigator, "fork").click();
    await settle(navigator);

    footerButton(navigator, "Fork into new session").click();
    await settle(navigator);

    expect(fieldsetByLegend(navigator, "How would you like to continue?")?.disabled).toBe(true);
    expect(fieldsetByLegend(navigator, "Abandoned branch summary")).toBeNull();
    expect(closeButton(navigator).disabled).toBe(true);
    expect(footerButton(navigator, "Back").disabled).toBe(true);
    expect(footerButton(navigator, "Forking…").disabled).toBe(true);
    expect(footerLabels(navigator)).not.toContain("Cancel summarization");

    resolveFork();
    await settle(navigator);
    expect(footerButton(navigator, "Fork into new session").disabled).toBe(false);
  });
});

describe("session-tree-navigator display helpers", () => {
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

async function mountNavigator(snapshot: SessionTreeSnapshot = tree()): Promise<SessionTreeNavigator> {
  const element = document.createElement("session-tree-navigator");
  if (!(element instanceof SessionTreeNavigator)) throw new Error("session-tree-navigator element was not upgraded");
  element.tree = snapshot;
  document.body.append(element);
  await settle(element);
  return element;
}

async function advanceToAction(navigator: SessionTreeNavigator): Promise<void> {
  footerButton(navigator, "Next").click();
  await settle(navigator);
}

async function settle(navigator: SessionTreeNavigator): Promise<void> {
  await Promise.resolve();
  await navigator.updateComplete;
  await Promise.resolve();
  await navigator.updateComplete;
}

function dialogElement(navigator: SessionTreeNavigator): HTMLElement {
  const dialog = navigator.renderRoot.querySelector("section[role='dialog']");
  if (!(dialog instanceof HTMLElement)) throw new Error("Session tree dialog was unavailable");
  return dialog;
}

function treeItem(navigator: SessionTreeNavigator, id: string): HTMLElement {
  const item = navigator.renderRoot.querySelector(`[data-tree-node-id='${id}']`);
  if (!(item instanceof HTMLElement)) throw new Error(`Tree item "${id}" was unavailable`);
  return item;
}

function closeButton(navigator: SessionTreeNavigator): HTMLButtonElement {
  const button = navigator.renderRoot.querySelector(".close-button");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Close button was unavailable");
  return button;
}

function footerButton(navigator: SessionTreeNavigator, label: string): HTMLButtonElement {
  for (const button of navigator.renderRoot.querySelectorAll("footer button")) {
    if (button.textContent.trim() !== label) continue;
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Footer button "${label}" is not a button element`);
    return button;
  }
  throw new Error(`Footer button "${label}" was unavailable`);
}

function footerLabels(navigator: SessionTreeNavigator): string[] {
  return [...navigator.renderRoot.querySelectorAll("footer button")].map((button) => button.textContent.trim());
}

function operationRadio(navigator: SessionTreeNavigator, value: "continue" | "fork"): HTMLInputElement {
  return radio(navigator, "session-tree-operation", value);
}

function summaryRadio(navigator: SessionTreeNavigator, value: SessionTreeSummaryChoice["mode"]): HTMLInputElement {
  return radio(navigator, "session-tree-summary", value);
}

function radio(navigator: SessionTreeNavigator, name: string, value: string): HTMLInputElement {
  const input = navigator.renderRoot.querySelector(`input[name='${name}'][value='${value}']`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Radio ${name}:${value} was unavailable`);
  return input;
}

function fieldsetByLegend(navigator: SessionTreeNavigator, legend: string): HTMLFieldSetElement | null {
  for (const fieldset of navigator.renderRoot.querySelectorAll("fieldset")) {
    if (fieldset.querySelector("legend")?.textContent !== legend) continue;
    if (!(fieldset instanceof HTMLFieldSetElement)) throw new Error(`Fieldset "${legend}" was not a fieldset element`);
    return fieldset;
  }
  return null;
}

function customFocus(navigator: SessionTreeNavigator): HTMLTextAreaElement {
  const textarea = navigator.renderRoot.querySelector("#session-tree-custom-focus");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Custom summary focus was unavailable");
  return textarea;
}

function selectedEntryText(navigator: SessionTreeNavigator): string {
  return navigator.renderRoot.querySelector(".selected-entry")?.textContent ?? "";
}

function shadowText(navigator: SessionTreeNavigator): string {
  return navigator.renderRoot.textContent;
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
