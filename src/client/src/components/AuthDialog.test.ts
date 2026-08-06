// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthDialogState } from "../appState";
import type { AuthProviderOption, OAuthFlowState } from "../api";
import { AuthDialog, oauthPromptInputType } from "./AuthDialog";
import type { ModalSurface } from "./ModalSurface";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("oauthPromptInputType", () => {
  it("renders secret prompts as password inputs and other prompt types as text", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual_code")).toBe("text");
  });
});

describe("auth-dialog focus on open", () => {
  it("focuses the dialog section when opened on the method step", async () => {
    const dialog = await mountDialog({ step: "method" });

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    expect(dialogSection(dialog).getAttribute("aria-label")).toBe("Configure provider authentication");
  });

  it("focuses the dialog section when opened on the providers step", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", providers: [providerOption("p1", "One")] });

    expect(deepActiveElement()).toBe(dialogSection(dialog));
  });

  it("focuses the dialog section when opened on the logout step", async () => {
    const dialog = await mountDialog({ step: "logout", providers: [providerOption("p1", "One")] });

    expect(deepActiveElement()).toBe(dialogSection(dialog));
  });

  it("focuses the prompt input when opened directly on an OAuth prompt", async () => {
    const dialog = await mountDialog(oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }));

    expect(deepActiveElement()).toBe(promptInput(dialog));
  });

  it("focuses the prompt input when a prompt appears after opening", async () => {
    const dialog = await mountDialog(oauthState());
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    dialog.state = oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } });
    await settleDialog(dialog);

    expect(deepActiveElement()).toBe(promptInput(dialog));
  });

  it("moves focus back into the dialog when a step change replaces the focused control", async () => {
    const onChooseMethod = vi.fn<(authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog({ step: "method" }, { onChooseMethod });
    const firstOption = requiredElement(optionButtons(dialog)[0], "first method option");
    firstOption.focus();
    pressKey(firstOption, "Enter");
    expect(onChooseMethod).toHaveBeenCalledWith("oauth");

    // The host app answers the method choice by advancing the dialog to the
    // providers step, replacing the button that held focus.
    dialog.state = { step: "providers", mode: "login", authType: "oauth", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] };
    await settleDialog(dialog);

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);
  });
});

describe("auth-dialog Escape", () => {
  it("cancels the dialog on Escape from an option-list step", async () => {
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog({ step: "method" }, { onCancel });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels the OAuth flow on Escape from the oauth step", async () => {
    const onOAuthCancel = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    const dialog = await mountDialog(oauthState(), { onOAuthCancel, onCancel });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onOAuthCancel).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("auth-dialog option-list keyboard navigation", () => {
  it("moves the selection with ArrowDown and ArrowUp, wrapping at both ends", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", providers: [providerOption("p1", "One"), providerOption("p2", "Two"), providerOption("p3", "Three")] });
    expect(selectedOptionIndex(dialog)).toBe(0);

    // happy-dom does not propagate events out of shadow roots, so key presses
    // that would bubble from the dialog section to the modal-surface host in a
    // browser are dispatched on the host itself (see ModalSurface.test.ts).
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(2);

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(0);

    pressKey(dialogSurface(dialog), "ArrowUp");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(2);
  });

  it("activates the selected login method with Enter", async () => {
    const onChooseMethod = vi.fn<(authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog({ step: "method" }, { onChooseMethod });

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    const event = pressKey(dialogSurface(dialog), "Enter");

    expect(onChooseMethod).toHaveBeenCalledWith("api_key");
    expect(event.defaultPrevented).toBe(true);
  });

  it("activates the selected provider with Enter", async () => {
    const onSelectProvider = vi.fn<(providerId: string, authType: "oauth" | "api_key") => void>();
    const dialog = await mountDialog(
      { step: "providers", mode: "login", authType: "oauth", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] },
      { onSelectProvider },
    );

    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    pressKey(dialogSurface(dialog), "Enter");

    expect(onSelectProvider).toHaveBeenCalledWith("p2", "oauth");
  });

  it("activates the selected stored credential with Enter on the logout step", async () => {
    const onLogoutProvider = vi.fn<(providerId: string) => void>();
    const dialog = await mountDialog({ step: "logout", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] }, { onLogoutProvider });

    pressKey(dialogSurface(dialog), "Enter");

    expect(onLogoutProvider).toHaveBeenCalledWith("p1");
  });

  it("restarts the selection at the first option when the step changes", async () => {
    const dialog = await mountDialog({ step: "providers", mode: "login", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] });
    pressKey(dialogSurface(dialog), "ArrowDown");
    await settleDialog(dialog);
    expect(selectedOptionIndex(dialog)).toBe(1);

    dialog.state = { step: "logout", providers: [providerOption("p1", "One"), providerOption("p2", "Two")] };
    await settleDialog(dialog);

    expect(selectedOptionIndex(dialog)).toBe(0);
  });
});

describe("auth-dialog OAuth prompt keys", () => {
  it("submits the OAuth prompt with Enter", async () => {
    const onOAuthRespond = vi.fn<(value?: string) => void>();
    const dialog = await mountDialog(oauthState({ prompt: { requestId: "req-1", message: "Enter the code", promptType: "text" } }), { onOAuthRespond });

    pressKey(promptInput(dialog), "Enter");

    expect(onOAuthRespond).toHaveBeenCalledOnce();
  });
});

interface AuthDialogCallbacks {
  onChooseMethod?: (authType: "oauth" | "api_key") => void;
  onSelectProvider?: (providerId: string, authType: "oauth" | "api_key") => void;
  onLogoutProvider?: (providerId: string) => void;
  onOAuthInput?: (value: string) => void;
  onOAuthRespond?: (value?: string) => void;
  onOAuthCancel?: () => void;
  onCancel?: () => void;
}

async function mountDialog(state: AuthDialogState, callbacks: AuthDialogCallbacks = {}): Promise<AuthDialog> {
  const dialog = new AuthDialog();
  Object.assign(dialog, callbacks);
  dialog.state = state;
  document.body.append(dialog);
  await settleDialog(dialog);
  return dialog;
}

async function settleDialog(dialog: AuthDialog): Promise<void> {
  // Await the dialog, the nested modal-surface it renders, and one more dialog
  // cycle so any render scheduled from within updated() has settled.
  await dialog.updateComplete;
  await dialogSurface(dialog).updateComplete;
  await dialog.updateComplete;
}

function dialogSurface(dialog: AuthDialog): ModalSurface {
  return requiredElement(dialog.shadowRoot?.querySelector<ModalSurface>("modal-surface"), "auth-dialog modal-surface");
}

function dialogSection(dialog: AuthDialog): HTMLElement {
  return requiredElement(dialogSurface(dialog).shadowRoot?.querySelector("section[role='dialog']"), "auth-dialog dialog section");
}

function promptInput(dialog: AuthDialog): HTMLInputElement {
  return requiredElement(dialog.shadowRoot?.querySelector("input"), "OAuth prompt input");
}

function optionButtons(dialog: AuthDialog): HTMLButtonElement[] {
  return [...(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
}

function selectedOptionIndex(dialog: AuthDialog): number {
  return optionButtons(dialog).findIndex((button) => button.classList.contains("selected"));
}

function providerOption(id: string, name: string): AuthProviderOption {
  return { id, name, authType: "oauth", status: { configured: false } };
}

function oauthState(flow: Partial<OAuthFlowState> = {}): AuthDialogState {
  return {
    step: "oauth",
    machineId: "machine-1",
    flow: { flowId: "flow-1", providerId: "anthropic", providerName: "Anthropic", status: "running", progress: [], ...flow },
  };
}

function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement instanceof Element) {
    active = active.shadowRoot.activeElement;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // the runtime value is normalized even though the type says Element | null.
  return active ?? null;
}

function requiredElement<T extends Element>(element: T | null | undefined, description: string): T {
  if (element === null || element === undefined) throw new Error(`Expected ${description} to exist`);
  return element;
}
