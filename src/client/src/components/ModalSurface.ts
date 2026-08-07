import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query } from "lit/decorators.js";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, a[href], [tabindex]";
const connectedModalSurfaces = new Set<ModalSurface>();
const modalSurfaceConnectionOrders = new WeakMap<ModalSurface, number>();
let modalSurfaceConnectionOrder = 0;

/**
 * Shared modal surface for the client's custom overlay dialogs. It owns the
 * cross-cutting modal behaviors so each dialog only renders its own content:
 *
 * - moves focus into the dialog on open (the `initialFocus` target, or the
 *   `role="dialog"` section itself when no target matches),
 * - routes Escape and backdrop presses to `onClose`, unless the host sets the
 *   `busy` opt-out (Escape is then routed to the optional `onBusyEscape`),
 * - traps Tab/Shift+Tab within the dialog's focusable elements, including
 *   controls inside nested shadow roots,
 * - keeps focus and modal accessibility ownership on the visually top surface,
 * - restores focus to the previous control or surviving lower dialog on disconnect.
 *
 * The host dialog keeps its own fixed positioning and z-index, renders its
 * content as this element's children, and tunes the shared backdrop/section
 * shell through the `--modal-surface-*` custom properties in `styles`.
 */
@customElement("modal-surface")
export class ModalSurface extends LitElement {
  /** Called when Escape or a backdrop press requests closing. Not called while `busy`. */
  @property({ attribute: false }) onClose?: () => void;
  /**
   * Busy/opt-out contract: while true, Escape and backdrop presses do not call
   * `onClose`; Escape is routed to `onBusyEscape` instead, so hosts can abort
   * in-flight work (or swallow the key) explicitly.
   */
  @property({ type: Boolean }) busy = false;
  /** Optional Escape route used only while `busy`. */
  @property({ attribute: false }) onBusyEscape?: () => void;
  /** Selector of the content element focused on open; falls back to the dialog section. */
  @property({ attribute: false }) initialFocus?: string;
  /** Accessible name applied as `aria-label` on the dialog section. */
  @property({ attribute: false }) label?: string;

  @query("section") private section?: HTMLElement;

  private focusRestorationPath: HTMLElement[] = [];

  override connectedCallback(): void {
    super.connectedCallback();
    const previous = deepActiveElement();
    if (previous instanceof HTMLElement) {
      const lowerSurface = containingModalSurface(previous);
      // Copy a lower dialog's path so its opener remains available even if the
      // lower surface disconnects while this newer dialog still owns focus.
      this.focusRestorationPath = [previous, ...(lowerSurface?.focusRestorationPath ?? [])];
    } else {
      this.focusRestorationPath = [];
    }
    modalSurfaceConnectionOrders.set(this, ++modalSurfaceConnectionOrder);
    connectedModalSurfaces.add(this);
    requestModalSurfaceUpdates(this.ownerDocument);
    // Key handling lives on the host, not the shadow section: slotted dialog
    // content bubbles key events up its light-DOM tree to this element, and
    // key presses inside the surface's own shadow section reach it as composed
    // events. One listener therefore covers the whole dialog.
    this.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("keydown", this.handleKeyDown);
    connectedModalSurfaces.delete(this);
    requestModalSurfaceUpdates(this.ownerDocument);
    super.disconnectedCallback();
    const restorationPath = this.focusRestorationPath;
    this.focusRestorationPath = [];
    // Restore only when focus still belongs to this dialog: either it sits
    // inside the subtree being removed, or the removal already reset it to the
    // page. When a newer dialog owns focus, leave it alone.
    const active = deepActiveElement();
    const focusWasReset = active === null || active === document.body || active === document.documentElement;
    if (!focusWasReset && !composedContains(this, active)) return;

    // A lower visible modal takes precedence over an opener behind it. Prefer
    // the exact remembered control when it still belongs to that modal, then
    // fall back to the lower modal's own initial-focus contract.
    const lowerSurface = topModalSurface(this.ownerDocument);
    if (lowerSurface !== undefined) {
      if (restoreFocus(restorationPath.filter((target) => composedContains(lowerSurface, target)))) return;
      lowerSurface.focusDialog();
      return;
    }
    restoreFocus(restorationPath);
  }

  protected override firstUpdated(): void {
    this.focusDialog();
  }

  /**
   * Moves focus into the dialog: the `initialFocus` target when one matches,
   * otherwise the dialog section. Hosts call this after swapping content that
   * held focus (for example a step change) so keys keep reaching the dialog.
   */
  focusDialog(): void {
    // Async dialog data can resolve after a visually higher modal has opened.
    // Only the actual top layer may claim focus; when that layer closes,
    // disconnectedCallback asks the next surface to apply this contract.
    if (!isTopModalSurface(this)) return;
    const initialTarget = this.initialFocusTarget();
    if (initialTarget !== null && focusElement(initialTarget)) return;
    if (this.section !== undefined) focusElement(this.section);
  }

  override render(): TemplateResult {
    const isTop = isTopModalSurface(this);
    return html`
      <div class="backdrop" @mousedown=${(event: MouseEvent) => { this.handleBackdropMouseDown(event); }}>
        <section
          role="dialog"
          aria-modal=${isTop ? "true" : "false"}
          aria-hidden=${isTop ? nothing : "true"}
          aria-busy=${this.busy ? "true" : "false"}
          aria-label=${this.label ?? nothing}
          tabindex="-1"
        ><slot></slot></section>
      </div>
    `;
  }

  private initialFocusTarget(): HTMLElement | null {
    if (this.initialFocus === undefined) return null;
    try {
      return this.querySelector<HTMLElement>(this.initialFocus);
    } catch {
      // An invalid selector is a host authoring error; fall back to the section.
      return null;
    }
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab") {
      this.trapTabFocus(event);
      return;
    }
    if (event.key !== "Escape") return;
    // A modal owns Escape completely: it either closes or exercises the busy
    // contract, but it never leaks the key to global shortcut handlers.
    event.preventDefault();
    event.stopPropagation();
    if (this.busy) {
      this.onBusyEscape?.();
      return;
    }
    this.onClose?.();
  };

  private trapTabFocus(event: KeyboardEvent): void {
    const focusable = modalSurfaceFocusableElements(this);
    if (focusable.length === 0) {
      event.preventDefault();
      this.section?.focus();
      return;
    }
    const active = deepActiveElement();
    const activeIndex = focusable.findIndex((element) => element === active);
    if (activeIndex === -1) {
      // Focus rests on the dialog section itself (or an untracked element):
      // enter the cycle at the edge matching the direction.
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      return;
    }
    const wrapForward = !event.shiftKey && activeIndex === focusable.length - 1;
    const wrapBackward = event.shiftKey && activeIndex === 0;
    if (!wrapForward && !wrapBackward) return;
    event.preventDefault();
    (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
  }

  private handleBackdropMouseDown(event: MouseEvent): void {
    // Presses that start on dialog content bubble through the slot; only a
    // press targeting the backdrop itself counts as a dismissal.
    if (event.target !== event.currentTarget || this.busy) return;
    this.onClose?.();
  }

  static override styles = css`
    /* Host dialogs tune this shell with custom properties (defaults match a
       centered 720px dialog):
         --modal-surface-place-items      backdrop grid alignment (default center)
         --modal-surface-backdrop-padding backdrop padding (default 0)
         --modal-surface-width / --modal-surface-max-width
         --modal-surface-height / --modal-surface-max-height / --modal-surface-min-height
         --modal-surface-border / --modal-surface-radius / --modal-surface-shadow */
    :host { display: block; width: 100%; height: 100%; }
    .backdrop { box-sizing: border-box; width: 100%; height: 100%; display: grid; place-items: var(--modal-surface-place-items, center); padding: var(--modal-surface-backdrop-padding, 0); background: var(--pi-overlay); overflow: hidden; }
    section[role="dialog"] { box-sizing: border-box; width: var(--modal-surface-width, min(720px, 100%)); max-width: var(--modal-surface-max-width, 100%); height: var(--modal-surface-height, auto); max-height: var(--modal-surface-max-height, 100%); min-height: var(--modal-surface-min-height, auto); display: flex; flex-direction: column; border: var(--modal-surface-border, 1px solid var(--pi-border)); border-radius: var(--modal-surface-radius, 12px); background: var(--pi-bg); box-shadow: var(--modal-surface-shadow, 0 20px 60px var(--pi-shadow-strong)); overflow: hidden; }
  `;
}

/** Deepest element holding focus, resolving through nested shadow roots. */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement) {
    const deeper: Element | null = active.shadowRoot?.activeElement ?? null;
    if (deeper === null) return active;
    active = deeper;
  }
  // happy-dom reports activeElement as undefined when nothing is focused;
  // the runtime value is normalized even though the type says Element | null.
  return active ?? null;
}

/**
 * Focusable elements inside the surface's dialog content in flattened Tab-cycle
 * order. Open shadow roots replace a host's light children, and slots insert
 * their assigned children where the slot is rendered.
 */
function modalSurfaceFocusableElements(surface: ModalSurface): HTMLElement[] {
  const focusable: HTMLElement[] = [];
  const collect = (element: Element): void => {
    if (element instanceof HTMLElement && isSequentiallyFocusable(element)) focusable.push(element);
    for (const child of flattenedChildElements(element)) collect(child);
  };
  for (const child of flattenedChildElements(surface)) collect(child);
  return focusable;
}

function isSequentiallyFocusable(element: HTMLElement): boolean {
  if (element.matches(":disabled") || isHiddenOrInertInComposedTree(element)) return false;
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  // Native controls match by tag even when an explicit negative tabindex has
  // removed them from sequential keyboard navigation.
  return element.matches(FOCUSABLE_SELECTOR) && element.tabIndex >= 0;
}

/** Hidden/inert content is absent from the browser's sequential focus order. */
function isHiddenOrInertInComposedTree(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  const elementStyle = view?.getComputedStyle(element);
  if (elementStyle?.visibility === "hidden" || elementStyle?.visibility === "collapse") return true;

  let current: Element | null = element;
  while (current !== null) {
    if (current.hasAttribute("hidden") || current.hasAttribute("inert")) return true;
    const style = view?.getComputedStyle(current);
    if (style?.display === "none" || style?.getPropertyValue("content-visibility") === "hidden") return true;
    current = composedParentElement(current);
  }
  return false;
}

function composedParentElement(element: Element): Element | null {
  const assignedSlot = element.assignedSlot;
  if (assignedSlot instanceof HTMLSlotElement) return assignedSlot;
  const parent = element.parentElement;
  if (parent instanceof Element) return parent;
  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
}

function flattenedChildElements(parent: Element | ShadowRoot): Element[] {
  if (parent instanceof HTMLSlotElement) {
    const assigned = parent.assignedNodes({ flatten: true });
    // Preserve fallback content when a DOM implementation reports an empty
    // assigned list; assigned text keeps the list nonempty and suppresses it.
    const rendered = assigned.length === 0 ? parent.childNodes : assigned;
    return Array.from(rendered).filter((node): node is Element => node instanceof Element);
  }
  const renderedRoot = parent instanceof Element ? parent.shadowRoot ?? parent : parent;
  return Array.from(renderedRoot.children);
}

function requestModalSurfaceUpdates(ownerDocument: Document): void {
  for (const surface of connectedModalSurfaces) {
    if (surface.ownerDocument === ownerDocument) surface.requestUpdate();
  }
}

function topModalSurface(ownerDocument: Document): ModalSurface | undefined {
  let top: ModalSurface | undefined;
  for (const surface of connectedModalSurfaces) {
    if (!surface.isConnected || surface.ownerDocument !== ownerDocument) continue;
    if (top === undefined || compareModalPaintOrder(surface, top) > 0) top = surface;
  }
  return top;
}

function isTopModalSurface(surface: ModalSurface): boolean {
  return topModalSurface(surface.ownerDocument) === surface;
}

/** Compare the app's fixed modal hosts by z-index, then DOM paint order. */
function compareModalPaintOrder(left: ModalSurface, right: ModalSurface): number {
  const leftHost = modalLayerHost(left);
  const rightHost = modalLayerHost(right);
  const layerDifference = modalLayerZIndex(leftHost) - modalLayerZIndex(rightHost);
  if (layerDifference !== 0) return layerDifference;
  if (leftHost !== rightHost) {
    const position = leftHost.compareDocumentPosition(rightHost);
    if ((position & Node.DOCUMENT_POSITION_DISCONNECTED) === 0) {
      if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
      if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
    }
  }
  return (modalSurfaceConnectionOrders.get(left) ?? 0) - (modalSurfaceConnectionOrders.get(right) ?? 0);
}

function modalLayerHost(surface: ModalSurface): HTMLElement {
  const root = surface.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : surface;
}

function modalLayerZIndex(host: HTMLElement): number {
  const value = host.ownerDocument.defaultView?.getComputedStyle(host).zIndex ?? "";
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function restoreFocus(path: readonly HTMLElement[]): boolean {
  for (const target of path) {
    if (focusElement(target)) return true;
  }
  return false;
}

function focusElement(target: HTMLElement): boolean {
  if (!target.isConnected || target.matches(":disabled") || isHiddenOrInertInComposedTree(target)) return false;
  target.focus();
  const active = deepActiveElement();
  return active === target || (active !== null && composedContains(target, active));
}

/** Nearest modal surface containing `node`, crossing open shadow boundaries. */
function containingModalSurface(node: Element): ModalSurface | undefined {
  let current: Node = node;
  for (;;) {
    if (current instanceof ModalSurface) return current;
    const parent: Node | null = current.parentNode;
    if (parent != null && parent !== current) {
      current = parent;
      continue;
    }
    const root = current instanceof ShadowRoot ? current : current.getRootNode();
    if (!(root instanceof ShadowRoot)) return undefined;
    current = root.host;
  }
}

/** Whether `node` is contained in `host` across shadow boundaries. */
function composedContains(host: Element, node: Element): boolean {
  let current: Node = node;
  for (;;) {
    if (current === host) return true;
    // happy-dom reports missing or bogus parents (undefined, or even the node
    // itself) at shadow boundaries, so guard the plain DOM climb carefully.
    const parent: Node | null = current.parentNode;
    if (parent != null && parent !== current) {
      current = parent;
      continue;
    }
    // A shadow tree's top node reports no usable parent; hop to the shadow host.
    const root = current instanceof ShadowRoot ? current : current.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    current = root.host;
  }
}
