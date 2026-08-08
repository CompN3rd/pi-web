import { normalizedRect, type ResearchAnnotationRect } from "./annotationModel.js";
import { quoteFromTextItems, textItemsToQuoteItems, type PdfTextContentItem } from "./annotationQuote.js";
import type { PDFDocumentProxy } from "pdfjs-dist";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MAX_DEVICE_PIXEL_RATIO = 2;
export const MAX_PDF_RENDER_DIMENSION = 16_384;
export const MAX_PDF_RENDER_PIXELS = 16_000_000;

export const researchLibraryPdfViewerTagName = "pi-web-research-library-pdf-viewer";
export const researchPdfSelectionEventName = "research-pdf-region-selected";
export const researchPdfAnnotationEventName = "research-pdf-annotation-activated";

/** Smallest drag the viewer accepts, as a fraction of the page box. */
const MIN_SELECTION_FRACTION = 0.01;

/** A region the reader marked on the current page, with any text it covers. */
export interface ResearchPdfSelectionDetail {
  page: number;
  rect: ResearchAnnotationRect;
  quote: string;
}

/** An existing annotation the viewer paints over the page. */
export interface ResearchPdfAnnotationMarker {
  id: string;
  page: number;
  rect: ResearchAnnotationRect;
  kind: "question" | "note";
  status: "open" | "resolved";
  label: string;
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfRenderTask {
  promise: Promise<unknown>;
  cancel(): void;
}

interface PdfPage {
  getViewport(input: { scale: number }): PdfViewport;
  render(input: { canvasContext: unknown; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
  getTextContent?(): Promise<{ items: PdfTextContentItem[] }>;
  cleanup?(): void;
}

interface PdfDocument extends Pick<PDFDocumentProxy, "numPages"> {
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

export interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(input: {
    url: string;
    isEvalSupported: false;
    enableXfa: false;
    disableAutoFetch: false;
    disableStream: false;
    maxImageSize: typeof MAX_PDF_RENDER_PIXELS;
  }): PdfLoadingTask;
}

export type PdfJsModuleLoader = () => Promise<PdfJsModule>;

export function defineResearchLibraryPdfViewerElement(): void {
  if (!customElements.get(researchLibraryPdfViewerTagName)) customElements.define(researchLibraryPdfViewerTagName, ResearchLibraryPdfViewerElement);
}

export class ResearchLibraryPdfViewerElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private readonly canvas: HTMLCanvasElement;
  private readonly statusElement: HTMLElement;
  private readonly fallback: HTMLAnchorElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly markButton: HTMLButtonElement;
  private readonly overlay: HTMLElement;
  private readonly marquee: HTMLElement;
  private markers: ResearchPdfAnnotationMarker[] = [];
  private activeMarkerId: string | undefined;
  private marking = false;
  private dragPointerId: number | undefined;
  private dragOrigin: { x: number; y: number } | undefined;
  private source: string | undefined;
  private generation = 0;
  private renderGeneration = 0;
  private pageNumber = 1;
  private zoom = 1;
  private document: PdfDocument | undefined;
  private loadingTask: PdfLoadingTask | undefined;
  private renderTask: PdfRenderTask | undefined;
  private renderedPage: PdfPage | undefined;
  private moduleLoader: PdfJsModuleLoader = loadBundledPdfJs;
  private contextFactory: (canvas: HTMLCanvasElement) => unknown = (canvas) => canvas.getContext("2d", { alpha: false });

  constructor() {
    super();
    this.root.innerHTML = template();
    this.canvas = required(this.root.querySelector("canvas"), HTMLCanvasElement);
    this.statusElement = required(this.root.querySelector("[data-status]"), HTMLElement);
    this.fallback = required(this.root.querySelector("[data-open-pdf]"), HTMLAnchorElement);
    this.previousButton = required(this.root.querySelector("[data-previous]"), HTMLButtonElement);
    this.nextButton = required(this.root.querySelector("[data-next]"), HTMLButtonElement);
    this.zoomOutButton = required(this.root.querySelector("[data-zoom-out]"), HTMLButtonElement);
    this.zoomInButton = required(this.root.querySelector("[data-zoom-in]"), HTMLButtonElement);
    this.markButton = required(this.root.querySelector("[data-mark]"), HTMLButtonElement);
    this.overlay = required(this.root.querySelector("[data-overlay]"), HTMLElement);
    this.marquee = required(this.root.querySelector("[data-marquee]"), HTMLElement);
    this.previousButton.addEventListener("click", () => { this.runInteraction(() => this.goToPage(this.pageNumber - 1)); });
    this.nextButton.addEventListener("click", () => { this.runInteraction(() => this.goToPage(this.pageNumber + 1)); });
    this.zoomOutButton.addEventListener("click", () => { this.runInteraction(() => this.setZoom(this.zoom - ZOOM_STEP)); });
    this.zoomInButton.addEventListener("click", () => { this.runInteraction(() => this.setZoom(this.zoom + ZOOM_STEP)); });
    this.markButton.addEventListener("click", () => { this.setMarking(!this.marking); });
    this.overlay.addEventListener("pointerdown", (event) => { this.startSelection(event); });
    this.overlay.addEventListener("pointermove", (event) => { this.updateSelection(event); });
    this.overlay.addEventListener("pointerup", (event) => { this.runInteraction(() => this.finishSelection(event)); });
    this.overlay.addEventListener("pointercancel", () => { this.cancelSelection(); });
    this.overlay.addEventListener("click", (event) => { this.activateMarker(event); });
    this.hideFallback();
    this.updateControls();
  }

  /** Existing annotations to paint over their pages. */
  set annotations(markers: readonly ResearchPdfAnnotationMarker[]) {
    this.markers = [...markers];
    this.renderMarkers();
  }

  /** Emphasize one annotation without changing the stored list. */
  set activeAnnotationId(id: string | undefined) {
    this.activeMarkerId = id;
    this.renderMarkers();
  }

  get currentPage(): number {
    return this.pageNumber;
  }

  get pageCount(): number {
    return this.document?.numPages ?? 0;
  }

  /** Bring one page into view; out-of-range pages are clamped, not rejected. */
  showPage(page: number): void {
    this.runInteraction(() => this.goToPage(page));
  }

  /** Arm or disarm region marking; disarming always releases a pointer capture. */
  setMarking(marking: boolean): void {
    const armed = marking && this.document !== undefined;
    if (armed === this.marking) {
      if (!armed) this.cancelSelection();
      return;
    }
    this.marking = armed;
    if (!armed) this.cancelSelection();
    this.updateControls();
  }

  set pdfJsLoader(loader: PdfJsModuleLoader) {
    this.moduleLoader = loader;
  }

  set canvasContextFactory(factory: (canvas: HTMLCanvasElement) => unknown) {
    this.contextFactory = factory;
  }

  set sourceUrl(value: string | undefined) {
    if (value === this.source) return;
    this.source = value;
    if (this.isConnected) void this.loadSource(value);
  }

  get sourceUrl(): string | undefined {
    return this.source;
  }

  connectedCallback(): void {
    if (this.source !== undefined && this.source !== "" && this.document === undefined && this.loadingTask === undefined) {
      void this.loadSource(this.source);
    }
  }

  disconnectedCallback(): void {
    this.hideFallback();
    void this.dispose(++this.generation);
  }

  private async loadSource(value: string | undefined): Promise<void> {
    const generation = ++this.generation;
    this.setStatus(value === undefined || value === "" ? "No PDF selected." : "Loading PDF…", value === undefined || value === "" ? "idle" : "loading");
    this.hideFallback();
    await this.dispose(generation);
    if (generation !== this.generation || !this.isConnected) return;
    this.pageNumber = 1;
    this.zoom = 1;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.style.width = "";
    this.canvas.style.height = "";
    this.canvas.setAttribute("aria-label", "PDF visual preview. No page rendered; use Open PDF when available for the complete document.");
    this.overlay.style.width = "";
    this.overlay.style.height = "";
    this.setMarking(false);
    this.renderMarkers();
    this.updateControls();
    if (value === undefined || value === "") {
      this.setStatus("No PDF selected.", "idle");
      return;
    }

    let url: URL;
    try {
      url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin) throw new Error("PDF preview URL must be same-origin");
    } catch (error) {
      this.setStatus(formatError(error), "error");
      return;
    }
    this.showFallback(url.href);
    this.setStatus("Loading PDF…", "loading");

    try {
      const pdfjs = await this.moduleLoader();
      if (generation !== this.generation) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      const loadingTask = pdfjs.getDocument({
        url: url.href,
        isEvalSupported: false,
        enableXfa: false,
        disableAutoFetch: false,
        disableStream: false,
        maxImageSize: MAX_PDF_RENDER_PIXELS,
      });
      this.loadingTask = loadingTask;
      loadingTask.onProgress = ({ loaded, total }) => {
        if (generation !== this.generation || total <= 0) return;
        this.setStatus(`Loading PDF… ${String(Math.min(100, Math.round((loaded / total) * 100)))}%`, "loading");
      };
      const document = await loadingTask.promise;
      if (generation !== this.generation) {
        await document.destroy();
        return;
      }
      this.loadingTask = undefined;
      this.document = document;
      await this.renderCurrentPage(generation);
    } catch (error) {
      this.handleOperationError(error, generation);
    } finally {
      if (generation === this.generation) this.updateControls();
    }
  }

  private async goToPage(next: number): Promise<void> {
    if (this.document === undefined) return;
    const bounded = Math.max(1, Math.min(this.document.numPages, next));
    if (bounded === this.pageNumber) return;
    this.pageNumber = bounded;
    await this.renderCurrentPage(this.generation);
  }

  private async setZoom(next: number): Promise<void> {
    const bounded = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next / ZOOM_STEP) * ZOOM_STEP));
    if (bounded === this.zoom || this.document === undefined) return;
    this.zoom = bounded;
    await this.renderCurrentPage(this.generation);
  }

  private async renderCurrentPage(generation: number): Promise<void> {
    const document = this.document;
    if (document === undefined) return;
    const renderGeneration = ++this.renderGeneration;
    this.renderTask?.cancel();
    this.renderedPage?.cleanup?.();
    this.renderTask = undefined;
    this.renderedPage = undefined;
    this.setStatus(`Rendering page ${String(this.pageNumber)}…`, "loading");
    const page = await document.getPage(this.pageNumber);
    if (generation !== this.generation || renderGeneration !== this.renderGeneration) {
      page.cleanup?.();
      return;
    }
    this.renderedPage = page;
    const viewport = page.getViewport({ scale: this.zoom });
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("PDF page dimensions are invalid");
    if (viewport.width > MAX_PDF_RENDER_DIMENSION || viewport.height > MAX_PDF_RENDER_DIMENSION) throw new Error("PDF page dimensions exceed the safe render limit");
    const desiredDpr = Math.min(MAX_DEVICE_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
    const outputScale = boundedOutputScale(viewport.width, viewport.height, desiredDpr);
    this.canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    this.canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    this.canvas.style.width = `${String(Math.floor(viewport.width))}px`;
    this.canvas.style.height = `${String(Math.floor(viewport.height))}px`;
    this.overlay.style.width = this.canvas.style.width;
    this.overlay.style.height = this.canvas.style.height;
    const context = this.contextFactory(this.canvas);
    if (context === null || context === undefined) throw new Error("Canvas rendering is unavailable");
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      ...(outputScale === 1 ? {} : { transform: [outputScale, 0, 0, outputScale, 0, 0] }),
    });
    this.renderTask = renderTask;
    try {
      await renderTask.promise;
    } finally {
      if (this.renderTask === renderTask) this.renderTask = undefined;
    }
    if (generation !== this.generation || renderGeneration !== this.renderGeneration) return;
    this.canvas.setAttribute("aria-label", `Visual preview of PDF page ${String(this.pageNumber)} of ${String(document.numPages)}. Use Open PDF for the complete accessible document.`);
    this.setStatus(`Page ${String(this.pageNumber)} of ${String(document.numPages)} · ${String(Math.round(this.zoom * 100))}%`, "ready");
    this.renderMarkers();
    this.updateControls();
  }

  private async dispose(expectedGeneration: number): Promise<void> {
    this.renderGeneration += 1;
    this.renderTask?.cancel();
    this.renderTask = undefined;
    this.renderedPage?.cleanup?.();
    this.renderedPage = undefined;
    const loadingTask = this.loadingTask;
    const document = this.document;
    this.loadingTask = undefined;
    this.document = undefined;
    const cleanup = document === undefined ? loadingTask?.destroy() : document.destroy();
    if (cleanup !== undefined) await Promise.allSettled([cleanup]);
    if (expectedGeneration === this.generation) this.updateControls();
  }

  private runInteraction(operation: () => Promise<void>): void {
    const generation = this.generation;
    void operation().catch((error: unknown) => { this.handleOperationError(error, generation); });
  }

  private handleOperationError(error: unknown, generation: number): void {
    if (generation !== this.generation || !this.isConnected || isCancellationError(error)) return;
    this.setStatus(`Unable to render PDF: ${formatError(error)}`, "error");
    this.updateControls();
  }

  private hideFallback(): void {
    this.fallback.removeAttribute("href");
    this.fallback.hidden = true;
    this.fallback.setAttribute("aria-disabled", "true");
    this.fallback.tabIndex = -1;
  }

  private showFallback(url: string): void {
    this.fallback.href = url;
    this.fallback.hidden = false;
    this.fallback.removeAttribute("aria-disabled");
    this.fallback.removeAttribute("tabindex");
  }

  private setStatus(message: string, state: "idle" | "loading" | "ready" | "error"): void {
    this.statusElement.textContent = message;
    this.statusElement.dataset["state"] = state;
  }

  private updateControls(): void {
    const pages = this.document?.numPages ?? 0;
    this.previousButton.disabled = pages === 0 || this.pageNumber <= 1;
    this.nextButton.disabled = pages === 0 || this.pageNumber >= pages;
    this.zoomOutButton.disabled = pages === 0 || this.zoom <= MIN_ZOOM;
    this.zoomInButton.disabled = pages === 0 || this.zoom >= MAX_ZOOM;
    this.markButton.disabled = pages === 0;
    this.markButton.textContent = this.marking ? "Cancel marking" : "Mark region";
    this.markButton.setAttribute("aria-pressed", this.marking ? "true" : "false");
    this.overlay.dataset["marking"] = this.marking ? "on" : "off";
  }

  private startSelection(event: PointerEvent): void {
    if (!this.marking || !event.isPrimary || this.dragPointerId !== undefined) return;
    const origin = this.pointFromEvent(event);
    if (origin === undefined) return;
    this.dragPointerId = event.pointerId;
    this.dragOrigin = origin;
    this.overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.paintMarquee(origin, origin);
  }

  private updateSelection(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId || this.dragOrigin === undefined) return;
    const point = this.pointFromEvent(event);
    if (point === undefined) return;
    event.preventDefault();
    this.paintMarquee(this.dragOrigin, point);
  }

  private async finishSelection(event: PointerEvent): Promise<void> {
    if (this.dragPointerId !== event.pointerId || this.dragOrigin === undefined) return;
    const origin = this.dragOrigin;
    const point = this.pointFromEvent(event) ?? origin;
    this.cancelSelection();
    const rect = normalizedRect({ x: origin.x, y: origin.y, width: point.x - origin.x, height: point.y - origin.y });
    if (rect.width < MIN_SELECTION_FRACTION || rect.height < MIN_SELECTION_FRACTION) {
      this.setStatus("That region was too small to mark. Drag across the passage you want.", "idle");
      return;
    }
    this.setMarking(false);
    const detail: ResearchPdfSelectionDetail = { page: this.pageNumber, rect, quote: await this.quoteForRect(rect) };
    this.dispatchEvent(new CustomEvent<ResearchPdfSelectionDetail>(researchPdfSelectionEventName, { detail, bubbles: true, composed: true }));
  }

  private cancelSelection(): void {
    if (this.dragPointerId !== undefined && this.overlay.hasPointerCapture(this.dragPointerId)) {
      this.overlay.releasePointerCapture(this.dragPointerId);
    }
    this.dragPointerId = undefined;
    this.dragOrigin = undefined;
    this.marquee.hidden = true;
  }

  /** Read the text under a marked region; an unreadable page yields no quote. */
  private async quoteForRect(rect: ResearchAnnotationRect): Promise<string> {
    const page = this.renderedPage;
    if (page?.getTextContent === undefined) return "";
    try {
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      return quoteFromTextItems(textItemsToQuoteItems(content.items, viewport.width, viewport.height), rect);
    } catch {
      return "";
    }
  }

  private activateMarker(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest("[data-annotation-id]") : null;
    const id = target?.getAttribute("data-annotation-id");
    if (id === null || id === undefined) return;
    this.dispatchEvent(new CustomEvent<{ id: string }>(researchPdfAnnotationEventName, { detail: { id }, bubbles: true, composed: true }));
  }

  private paintMarquee(origin: { x: number; y: number }, point: { x: number; y: number }): void {
    const rect = normalizedRect({ x: origin.x, y: origin.y, width: point.x - origin.x, height: point.y - origin.y });
    this.marquee.hidden = false;
    applyRectStyle(this.marquee, rect);
  }

  private pointFromEvent(event: PointerEvent): { x: number; y: number } | undefined {
    const bounds = this.overlay.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return undefined;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  private renderMarkers(): void {
    const visible = this.document === undefined ? [] : this.markers.filter((marker) => marker.page === this.pageNumber);
    const elements = visible.map((marker) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "marker";
      element.dataset["annotationId"] = marker.id;
      element.dataset["kind"] = marker.kind;
      element.dataset["status"] = marker.status;
      if (marker.id === this.activeMarkerId) element.dataset["active"] = "true";
      element.title = marker.label;
      element.setAttribute("aria-label", `${marker.kind === "question" ? "Question" : "Note"} on page ${String(marker.page)}: ${marker.label}`);
      applyRectStyle(element, marker.rect);
      return element;
    });
    this.overlay.replaceChildren(this.marquee, ...elements);
  }
}

function applyRectStyle(element: HTMLElement, rect: ResearchAnnotationRect): void {
  element.style.left = `${String(rect.x * 100)}%`;
  element.style.top = `${String(rect.y * 100)}%`;
  element.style.width = `${String(rect.width * 100)}%`;
  element.style.height = `${String(rect.height * 100)}%`;
}

export function boundedOutputScale(width: number, height: number, desiredScale: number): number {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pixelBound = Math.sqrt(MAX_PDF_RENDER_PIXELS / (safeWidth * safeHeight));
  const dimensionBound = Math.min(MAX_PDF_RENDER_DIMENSION / safeWidth, MAX_PDF_RENDER_DIMENSION / safeHeight);
  return Math.min(desiredScale, pixelBound, dimensionBound);
}

async function loadBundledPdfJs(): Promise<PdfJsModule> {
  const moduleUrl = new URL("./pdfjs/pdf.min.mjs", import.meta.url).href;
  const value: unknown = await import(moduleUrl);
  if (!isPdfJsModule(value)) throw new Error("Bundled PDF.js module has an invalid contract");
  return value;
}

export function isPdfJsModule(value: unknown): value is PdfJsModule {
  return isRecord(value)
    && isPropertyContainer(value["GlobalWorkerOptions"])
    && typeof value["GlobalWorkerOptions"]["workerSrc"] === "string"
    && typeof value["getDocument"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPropertyContainer(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function required<T>(value: Element | null, type: abstract new (...args: never[]) => T): T {
  if (!(value instanceof type)) throw new Error("Research PDF viewer template is incomplete");
  return value;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (error.name === "RenderingCancelledException" || error.name === "AbortException");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function template(): string {
  return `
    <style>
      :host { display: block; min-width: 0; }
      .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin-bottom: .5rem; }
      button, a { border: 1px solid var(--border-color, #7776); border-radius: .35rem; background: var(--surface-raised, #fff1); color: inherit; padding: .3rem .55rem; font: inherit; text-decoration: none; }
      button:disabled { opacity: .45; }
      [hidden] { display: none !important; }
      [data-status] { flex: 1; min-width: 10rem; font-size: .85rem; }
      [data-state="error"] { color: var(--danger-color, #c33); }
      .viewport { overflow: auto; max-height: min(70vh, 900px); border: 1px solid var(--border-color, #7776); background: #7772; text-align: center; }
      .page { position: relative; display: inline-block; line-height: 0; }
      canvas { display: inline-block; max-width: none; background: white; }
      .overlay { position: absolute; inset: 0; pointer-events: none; }
      .overlay[data-marking="on"] { pointer-events: auto; cursor: crosshair; touch-action: none; }
      .marker, .marquee { position: absolute; box-sizing: border-box; padding: 0; }
      .marquee { border: 2px dashed var(--pi-accent, #58a6ff); background: #58a6ff33; }
      .marker { border: 2px solid var(--pi-warning, #d29922); background: #d2992226; cursor: pointer; pointer-events: auto; }
      .marker[data-kind="note"] { border-color: var(--pi-purple, #d2a8ff); background: #d2a8ff26; }
      .marker[data-status="resolved"] { border-style: dashed; opacity: .65; }
      .marker[data-active="true"] { border-color: var(--pi-accent, #58a6ff); background: #58a6ff40; }
      .overlay[data-marking="on"] .marker { pointer-events: none; }
    </style>
    <div class="toolbar">
      <button type="button" data-previous aria-label="Previous PDF page">Previous</button>
      <button type="button" data-next aria-label="Next PDF page">Next</button>
      <button type="button" data-zoom-out aria-label="Zoom PDF out">−</button>
      <button type="button" data-zoom-in aria-label="Zoom PDF in">+</button>
      <button type="button" data-mark aria-pressed="false">Mark region</button>
      <span data-status role="status" aria-live="polite">No PDF selected.</span>
      <a data-open-pdf target="_blank" rel="noopener noreferrer" hidden aria-disabled="true" tabindex="-1">Open PDF</a>
    </div>
    <div class="viewport">
      <div class="page">
        <canvas aria-label="PDF visual preview. No page rendered; use Open PDF when available for the complete document."></canvas>
        <div class="overlay" data-overlay data-marking="off"><div class="marquee" data-marquee hidden></div></div>
      </div>
    </div>
  `;
}
