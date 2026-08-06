// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalSurface } from "./ModalSurface";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("modal-surface rendering", () => {
  it("renders an accessible dialog section around the provided content", async () => {
    const surface = await mountSurface({
      content: `<p id="greeting">Hello</p>`,
      configure: (element) => { element.label = "Greeting dialog"; },
    });
    const section = dialogSection(surface);

    expect(section.getAttribute("aria-modal")).toBe("true");
    expect(section.getAttribute("aria-busy")).toBe("false");
    expect(section.getAttribute("aria-label")).toBe("Greeting dialog");
    expect(section.getAttribute("aria-labelledby")).toBeNull();
    expect(section.tabIndex).toBe(-1);
    const slot = section.querySelector("slot");
    if (!(slot instanceof HTMLSlotElement)) throw new Error("modal-surface did not render its content slot");
    expect(slot.assignedElements().map((element) => element.id)).toEqual(["greeting"]);
  });

  it("prefers an explicit labelled-by reference over a plain label", async () => {
    const surface = await mountSurface({
      content: `<h1 id="dialog-title">Title</h1>`,
      configure: (element) => {
        element.label = "Ignored label";
        element.labelledBy = "dialog-title";
      },
    });
    const section = dialogSection(surface);

    expect(section.getAttribute("aria-labelledby")).toBe("dialog-title");
    expect(section.getAttribute("aria-label")).toBeNull();
  });
});

describe("modal-surface initial focus", () => {
  it("focuses the designated initial target when opened", async () => {
    const surface = await mountSurface({
      content: `<button>First</button><input aria-label="Query">`,
      configure: (element) => { element.initialFocus = "input"; },
    });

    expect(document.activeElement).toBe(surface.querySelector("input"));
  });

  it("focuses the dialog section when no initial target is set", async () => {
    const surface = await mountSurface({ content: `<button>Only</button>` });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("falls back to the section when the initial-focus selector matches nothing", async () => {
    const surface = await mountSurface({
      content: `<button>Only</button>`,
      configure: (element) => { element.initialFocus = "textarea"; },
    });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("falls back to the section when the initial-focus selector is invalid", async () => {
    const surface = await mountSurface({
      content: `<button>Only</button>`,
      configure: (element) => { element.initialFocus = "input["; },
    });

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });
});

describe("modal-surface refocus on request", () => {
  it("moves focus back to the dialog section when asked", async () => {
    const surface = await mountSurface({ content: `<button>Inside</button>` });
    const outside = appendFocusTarget("Outside");
    outside.focus();
    expect(document.activeElement).toBe(outside);

    surface.focusDialog();

    expect(surface.shadowRoot?.activeElement).toBe(dialogSection(surface));
  });

  it("moves focus to the designated initial target when one is set", async () => {
    const surface = await mountSurface({
      content: `<input aria-label="Query">`,
      configure: (element) => { element.initialFocus = "input"; },
    });
    const outside = appendFocusTarget("Outside");
    outside.focus();

    surface.focusDialog();

    expect(document.activeElement).toBe(surface.querySelector("input"));
  });
});

describe("modal-surface close contract", () => {
  it("routes Escape to the close callback without leaking the key", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });
    const bodySpy = vi.fn();
    document.body.addEventListener("keydown", bodySpy);

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it("routes Escape to the busy callback instead of closing while busy", async () => {
    const onClose = vi.fn<() => void>();
    const onBusyEscape = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => {
        element.onClose = onClose;
        element.onBusyEscape = onBusyEscape;
        element.busy = true;
      },
    });

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).not.toHaveBeenCalled();
    expect(onBusyEscape).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(dialogSection(surface).getAttribute("aria-busy")).toBe("true");
  });

  it("swallows Escape while busy when no busy callback is set", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => {
        element.onClose = onClose;
        element.busy = true;
      },
    });

    const event = pressKey(contentButton(surface), "Escape");

    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes when the backdrop itself is pressed, but not while busy", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });

    backdrop(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    expect(onClose).toHaveBeenCalledOnce();

    surface.busy = true;
    await surface.updateComplete;
    backdrop(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores presses that start on dialog content or the section frame", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<button>Inside</button>`,
      configure: (element) => { element.onClose = onClose; },
    });

    contentButton(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));
    dialogSection(surface).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true }));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("modal-surface Tab trap", () => {
  it("enters the focus cycle from the dialog section in both directions", async () => {
    const surface = await mountTrapSurface();
    const section = dialogSection(surface);
    expect(surface.shadowRoot?.activeElement).toBe(section);

    // happy-dom does not propagate events out of shadow roots, so key presses
    // that would bubble from the section to the host in a browser are
    // dispatched on the host itself; the handler is event-target agnostic.
    pressKey(surface, "Tab");
    expect(document.activeElement).toBe(surface.querySelector("#one"));

    section.focus();
    pressKey(surface, "Tab", { shift: true });
    expect(document.activeElement).toBe(surface.querySelector("#three"));
  });

  it("wraps Tab from the last control and Shift+Tab from the first", async () => {
    const surface = await mountTrapSurface();
    const one = requiredElement(surface.querySelector<HTMLButtonElement>("#one"), "first trap button");
    const three = requiredElement(surface.querySelector<HTMLButtonElement>("#three"), "last trap button");

    three.focus();
    const forward = pressKey(three, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(one);

    one.focus();
    const backward = pressKey(one, "Tab", { shift: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(three);
  });

  it("leaves mid-cycle Tab presses to the browser", async () => {
    const surface = await mountTrapSurface();
    const one = requiredElement(surface.querySelector<HTMLButtonElement>("#one"), "first trap button");

    one.focus();
    const event = pressKey(one, "Tab");

    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps focus on the section when the dialog has no focusable controls", async () => {
    const surface = await mountSurface({ content: `<p>Nothing to focus</p>` });
    const section = dialogSection(surface);

    const event = pressKey(surface, "Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(surface.shadowRoot?.activeElement).toBe(section);
  });
});

describe("modal-surface nested shadow content", () => {
  it("includes controls inside nested shadow roots in the Tab cycle", async () => {
    const surface = await mountSurface({
      content: `<button id="before">Before</button><modal-surface-test-nested></modal-surface-test-nested><button id="after">After</button>`,
    });
    const nestedButton = nestedFocusButton(surface);

    // The nested control is recognized mid-cycle, so its Tab press is left alone.
    nestedButton.focus();
    const midCycle = pressKey(surface, "Tab");
    expect(midCycle.defaultPrevented).toBe(false);

    // The cycle wraps across the shadow boundary: last is the plain trailing button.
    const after = requiredElement(surface.querySelector<HTMLButtonElement>("#after"), "trailing button");
    after.focus();
    pressKey(after, "Tab");
    expect(document.activeElement).toBe(surface.querySelector("#before"));

    // And Shift+Tab from the first control wraps to the trailing button,
    // proving the nested control sits between them in cycle order.
    const before = requiredElement(surface.querySelector<HTMLButtonElement>("#before"), "leading button");
    before.focus();
    pressKey(before, "Tab", { shift: true });
    expect(document.activeElement).toBe(after);
  });

  it("enters the Tab cycle directly into a nested shadow control", async () => {
    const surface = await mountSurface({ content: `<modal-surface-test-nested></modal-surface-test-nested>` });

    pressKey(surface, "Tab");

    expect(deepActiveElement()).toBe(nestedFocusButton(surface));
  });

  it("closes on Escape while a control inside nested shadow content holds focus", async () => {
    const onClose = vi.fn<() => void>();
    const surface = await mountSurface({
      content: `<modal-surface-test-nested></modal-surface-test-nested>`,
      configure: (element) => { element.onClose = onClose; },
    });

    nestedFocusButton(surface).focus();
    pressKey(surface, "Escape");

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("modal-surface focus restoration", () => {
  it("restores focus to the previously focused element when removed", async () => {
    const trigger = appendFocusTarget("Open settings");
    trigger.focus();

    const surface = await mountSurface({ content: `<button>Inside</button>` });
    expect(document.activeElement).not.toBe(trigger);

    surface.remove();
    expect(document.activeElement).toBe(trigger);
  });

  it("skips focus restoration when the previously focused element is gone", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();
    const surface = await mountSurface({ content: `<button>Inside</button>` });

    trigger.remove();
    surface.remove();

    expect(document.activeElement).not.toBe(trigger);
  });

  it("does not pull focus back when a newer dialog already owns it", async () => {
    const trigger = appendFocusTarget("Opener");
    trigger.focus();

    const first = await mountSurface({ content: `<button>First dialog</button>` });
    const second = await mountSurface({ content: `<button>Second dialog</button>` });
    expect(document.activeElement).toBe(second);

    first.remove();
    expect(document.activeElement).toBe(second);

    // The second dialog's previously focused element lived inside the first
    // one, so its removal leaves focus with the page instead of a dead element.
    second.remove();
    expect(document.activeElement).toBe(document.body);
  });
});

interface MountSurfaceOptions {
  content: string;
  configure?: (surface: ModalSurface) => void;
}

async function mountSurface(options: MountSurfaceOptions): Promise<ModalSurface> {
  const surface = new ModalSurface();
  options.configure?.(surface);
  surface.innerHTML = options.content;
  document.body.append(surface);
  await surface.updateComplete;
  return surface;
}

async function mountTrapSurface(): Promise<ModalSurface> {
  return mountSurface({ content: `<button id="one">One</button><button id="two">Two</button><button id="three">Three</button>` });
}

function dialogSection(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector("section[role='dialog']"), "modal-surface dialog section");
}

function backdrop(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector(".backdrop"), "modal-surface backdrop");
}

function contentButton(surface: ModalSurface): HTMLButtonElement {
  return requiredElement(surface.querySelector("button"), "content button");
}

function nestedFocusButton(surface: ModalSurface): HTMLButtonElement {
  const host = requiredElement(surface.querySelector("modal-surface-test-nested"), "nested focus host");
  return requiredElement(host.shadowRoot?.querySelector("button"), "nested shadow button");
}

function appendFocusTarget(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return button;
}

function pressKey(target: Element, key: string, options: { shift?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: options.shift ?? false,
  });
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

class ModalSurfaceTestNested extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.id = "nested";
    button.textContent = "Nested";
    root.append(button);
  }
}

if (customElements.get("modal-surface-test-nested") === undefined) {
  customElements.define("modal-surface-test-nested", ModalSurfaceTestNested);
}
