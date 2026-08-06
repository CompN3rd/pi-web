// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOption } from "../api";
import { CommandPicker } from "./CommandPicker";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("command-picker modal surface", () => {
  it("focuses the search input when opened searchable", async () => {
    const picker = await mountPicker({ searchable: true, title: "Pick a model" });

    expect(deepActiveElement()).toBe(searchInput(picker));
    expect(dialogSection(picker).getAttribute("aria-label")).toBe("Pick a model");
  });

  it("focuses the options list when opened without search", async () => {
    const picker = await mountPicker();

    expect(deepActiveElement()).toBe(optionsList(picker));
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn<() => void>();
    const picker = await mountPicker({ onCancel });

    pressKey(dialogSurface(picker), "Escape");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels when the backdrop itself is pressed", async () => {
    const onCancel = vi.fn<() => void>();
    const picker = await mountPicker({ onCancel });

    surfaceBackdrop(picker).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps arrow navigation and Enter picking on the option list", async () => {
    const onPick = vi.fn<(value: string) => void>();
    const picker = await mountPicker({ onPick, options: [option("a", "Alpha"), option("b", "Beta"), option("c", "Gamma")] });
    expect(selectedOptionIndex(picker)).toBe(0);

    pressKey(dialogSurface(picker), "ArrowDown");
    await settleRenderedDialog(picker);
    expect(selectedOptionIndex(picker)).toBe(1);

    pressKey(dialogSurface(picker), "ArrowUp");
    await settleRenderedDialog(picker);
    expect(selectedOptionIndex(picker)).toBe(0);

    pressKey(dialogSurface(picker), "ArrowUp");
    await settleRenderedDialog(picker);
    expect(selectedOptionIndex(picker)).toBe(2);

    pressKey(dialogSurface(picker), "Enter");

    expect(onPick).toHaveBeenCalledWith("c");
  });
});

interface CommandPickerProps {
  title?: string;
  searchable?: boolean;
  options?: CommandOption[];
  onPick?: (value: string) => void;
  onCancel?: () => void;
}

async function mountPicker(props: CommandPickerProps = {}): Promise<CommandPicker> {
  const picker = new CommandPicker();
  picker.options = props.options ?? [option("a", "Alpha"), option("b", "Beta")];
  if (props.title !== undefined) picker.title = props.title;
  if (props.searchable !== undefined) picker.searchable = props.searchable;
  if (props.onPick !== undefined) picker.onPick = props.onPick;
  if (props.onCancel !== undefined) picker.onCancel = props.onCancel;
  document.body.append(picker);
  await settleRenderedDialog(picker);
  return picker;
}

function option(value: string, label: string): CommandOption {
  return { value, label };
}

function searchInput(picker: CommandPicker): HTMLInputElement {
  return requiredElement(picker.shadowRoot?.querySelector<HTMLInputElement>("input"), "command-picker search input");
}

function optionsList(picker: CommandPicker): HTMLElement {
  return requiredElement(picker.shadowRoot?.querySelector<HTMLElement>(".options"), "command-picker options list");
}

function selectedOptionIndex(picker: CommandPicker): number {
  const buttons = [...(picker.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
  return buttons.findIndex((button) => button.classList.contains("selected"));
}
