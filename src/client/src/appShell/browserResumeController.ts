import { TrailingRefreshCoordinator } from "../controllers/trailingRefreshCoordinator";

interface BrowserEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface ScheduledFrame {
  cancel(): void;
}

export interface BrowserResumeCallbacks {
  onResumeSignal(): void;
  refreshAfterResume(renewSubscription: boolean): void | Promise<void>;
  onRefreshError(error: unknown): void;
}

export interface BrowserResumeControllerOptions {
  windowTarget?: BrowserEventTarget | undefined;
  documentTarget?: BrowserEventTarget | undefined;
  isDocumentVisible?: (() => boolean) | undefined;
  scheduleFrame?: ((callback: () => void) => ScheduledFrame) | undefined;
}

/** Owns browser resume listeners and batches refreshes per frame. */
export class BrowserResumeController {
  private readonly windowTarget: BrowserEventTarget | undefined;
  private readonly documentTarget: BrowserEventTarget | undefined;
  private readonly isDocumentVisible: () => boolean;
  private readonly scheduleFrame: (callback: () => void) => ScheduledFrame;
  private readonly refreshes = new TrailingRefreshCoordinator<"browser-resume">();
  private scheduledRefresh: ScheduledFrame | undefined;
  private connected = false;
  private renewSubscription = false;

  constructor(private readonly callbacks: BrowserResumeCallbacks, options: BrowserResumeControllerOptions = {}) {
    this.windowTarget = options.windowTarget ?? browserWindowTarget();
    this.documentTarget = options.documentTarget ?? browserDocumentTarget();
    this.isDocumentVisible = options.isDocumentVisible ?? documentIsVisible;
    this.scheduleFrame = options.scheduleFrame ?? scheduleBrowserFrame;
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.renewSubscription = !this.isDocumentVisible();
    this.windowTarget?.addEventListener("focus", this.onResume);
    this.windowTarget?.addEventListener("pageshow", this.onResume);
    this.windowTarget?.addEventListener("online", this.onResume);
    this.documentTarget?.addEventListener("visibilitychange", this.onResume);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.windowTarget?.removeEventListener("focus", this.onResume);
    this.windowTarget?.removeEventListener("pageshow", this.onResume);
    this.windowTarget?.removeEventListener("online", this.onResume);
    this.documentTarget?.removeEventListener("visibilitychange", this.onResume);
    this.scheduledRefresh?.cancel();
    this.scheduledRefresh = undefined;
    this.renewSubscription = false;
  }

  private readonly onResume: EventListener = (event) => {
    this.handleResumeSignal(event);
  };

  private handleResumeSignal(event: Event): void {
    if (event.type === "online" || event.type === "pageshow" || !this.isDocumentVisible()) this.renewSubscription = true;
    if (!this.isDocumentVisible()) return;
    this.callbacks.onResumeSignal();
    if (this.scheduledRefresh !== undefined) return;
    this.scheduledRefresh = this.scheduleFrame(() => {
      this.scheduledRefresh = undefined;
      if (!this.connected) return;
      void this.refreshes.request("browser-resume", async () => {
        if (!this.connected) return;
        const renewSubscription = this.renewSubscription;
        this.renewSubscription = false;
        await this.callbacks.refreshAfterResume(renewSubscription);
      }).catch((error: unknown) => { this.callbacks.onRefreshError(error); });
    });
  }
}

function browserWindowTarget(): BrowserEventTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function browserDocumentTarget(): BrowserEventTarget | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function scheduleBrowserFrame(callback: () => void): ScheduledFrame {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    const frame = window.requestAnimationFrame(() => { callback(); });
    return { cancel: () => { window.cancelAnimationFrame(frame); } };
  }
  const timer = globalThis.setTimeout(callback, 0);
  return { cancel: () => { globalThis.clearTimeout(timer); } };
}
