// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedOutputScale,
  defineResearchLibraryPdfViewerElement,
  researchPdfAnnotationEventName,
  researchPdfSelectionEventName,
  type ResearchPdfSelectionDetail,
  MAX_PDF_RENDER_DIMENSION,
  MAX_PDF_RENDER_PIXELS,
  isPdfJsModule,
  ResearchLibraryPdfViewerElement,
  researchLibraryPdfViewerTagName,
  type PdfJsModule,
} from "./pdfViewerElement";

beforeEach(() => {
  defineResearchLibraryPdfViewerElement();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ResearchLibraryPdfViewerElement", () => {
  it("loads with hardened options, renders one page, and bounds page/zoom controls", async () => {
    const harness = fakePdfJs(2);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 2");

    const loadInput = harness.getDocument.mock.calls[0]?.[0];
    expect(loadInput?.url).toContain("paper.pdf");
    expect(loadInput).toMatchObject({ isEvalSupported: false, enableXfa: false, disableAutoFetch: false, disableStream: false, maxImageSize: MAX_PDF_RENDER_PIXELS });
    expect(harness.workerOptions.workerSrc).toContain("/pdfjs/pdf.worker.min.mjs");
    expect(pageAt(harness.pages, 0).render).toHaveBeenCalledTimes(1);

    shadowButton(element, "[data-previous]").click();
    expect(harness.document.getPage).toHaveBeenCalledTimes(1);
    shadowButton(element, "[data-next]").click();
    await statusIncludes(element, "Page 2 of 2");
    shadowButton(element, "[data-next]").click();
    expect(harness.document.getPage).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 20; index += 1) {
      shadowButton(element, "[data-zoom-in]").click();
      await settle();
    }
    await statusIncludes(element, "300%");
    expect(shadowButton(element, "[data-zoom-in]").disabled).toBe(true);

    const fallback = shadow(element, "[data-open-pdf]", HTMLAnchorElement);
    expect(fallback.href).toContain("paper.pdf");
    expect(fallback.hidden).toBe(false);
    expect(fallback.target).toBe("_blank");
    expect(fallback.rel).toContain("noopener");
    expect(shadow(element, "canvas", HTMLCanvasElement).getAttribute("aria-label")).toContain("page 2 of 2");
  });

  it("does not load while detached and reloads a retained source after reconnect", async () => {
    const harness = fakePdfJs(1);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    element.sourceUrl = "paper.pdf";
    await settle();
    expect(harness.loader).not.toHaveBeenCalled();
    expect(shadow(element, "[data-open-pdf]", HTMLAnchorElement).hidden).toBe(true);

    document.body.append(element);
    await statusIncludes(element, "Page 1 of 1");
    expect(harness.loader).toHaveBeenCalledTimes(1);
    element.remove();
    await waitFor(() => harness.document.destroy.mock.calls.length === 1);
    document.body.append(element);
    await statusIncludes(element, "Page 1 of 1");
    expect(harness.loader).toHaveBeenCalledTimes(2);
  });

  it("cancels and destroys work on source replacement and disconnect", async () => {
    const first = fakePdfJs(1);
    const second = fakePdfJs(1);
    const loaders = [first.loader, second.loader];
    const element = createViewer();
    element.pdfJsLoader = async () => await (loaders.shift() ?? second.loader)();
    document.body.append(element);
    element.sourceUrl = "first.pdf";
    await statusIncludes(element, "Page 1 of 1");

    element.sourceUrl = "second.pdf";
    await statusIncludes(element, "Page 1 of 1");
    expect(first.document.destroy).toHaveBeenCalled();
    expect(pageAt(first.pages, 0).cleanup).toHaveBeenCalled();

    element.remove();
    await settle();
    expect(second.document.destroy).toHaveBeenCalled();
  });

  it("cancels an in-flight render when the source is cleared", async () => {
    let finishRender: (() => void) | undefined;
    const renderPromise = new Promise<void>((resolve) => { finishRender = resolve; });
    const harness = fakePdfJs(1, renderPromise);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await waitFor(() => pageAt(harness.pages, 0).render.mock.calls.length === 1);

    element.sourceUrl = undefined;
    await waitFor(() => pageAt(harness.renderTasks, 0).cancel.mock.calls.length === 1);
    expect(pageAt(harness.pages, 0).cleanup).toHaveBeenCalled();
    finishRender?.();
  });

  it("destroys an in-flight loading task when the source is cleared", async () => {
    const loadingTask = { promise: new Promise<never>(() => undefined), destroy: vi.fn(() => Promise.resolve()) };
    const getDocument = vi.fn<PdfJsModule["getDocument"]>(() => loadingTask);
    const module: PdfJsModule = { GlobalWorkerOptions: { workerSrc: "" }, getDocument };
    const element = createViewer();
    element.pdfJsLoader = vi.fn(() => Promise.resolve(module));
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await waitFor(() => getDocument.mock.calls.length === 1);
    element.sourceUrl = undefined;
    await waitFor(() => loadingTask.destroy.mock.calls.length === 1);
  });

  it("surfaces page and render failures through the handled status path", async () => {
    const pageFailure = fakePdfJs(2);
    const element = createViewer();
    element.pdfJsLoader = pageFailure.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 2");
    pageFailure.document.getPage.mockRejectedValueOnce(new Error("page failed"));
    shadowButton(element, "[data-next]").click();
    await statusIncludes(element, "page failed");

    pageFailure.document.getPage.mockImplementation((page: number) => Promise.resolve(pageAt(pageFailure.pages, page - 1)));
    pageAt(pageFailure.pages, 1).render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("render failed")), cancel: vi.fn() }));
    shadowButton(element, "[data-zoom-in]").click();
    await statusIncludes(element, "render failed");
  });

  it("rejects absurd CSS viewport dimensions", async () => {
    const harness = fakePdfJs(1);
    pageAt(harness.pages, 0).getViewport.mockReturnValue({ width: MAX_PDF_RENDER_DIMENSION + 1, height: 10 });
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "safe render limit");
  });

  it("shows a safe error state and refuses a cross-origin fallback", async () => {
    const element = createViewer();
    element.pdfJsLoader = vi.fn(() => Promise.reject(new Error("should not load")));
    document.body.append(element);
    element.sourceUrl = "https://elsewhere.example/paper.pdf";
    await statusIncludes(element, "same-origin");

    const fallback = shadow(element, "[data-open-pdf]", HTMLAnchorElement);
    expect(fallback.hasAttribute("href")).toBe(false);
    expect(fallback.hidden).toBe(true);
    expect(fallback.getAttribute("aria-disabled")).toBe("true");
    expect(shadow(element, "[data-status]", HTMLElement).dataset["state"]).toBe("error");
  });

  it("surfaces loader failures without unsafe URL interpolation", async () => {
    const element = createViewer();
    element.pdfJsLoader = vi.fn(() => Promise.reject(new Error("broken <module>")));
    document.body.append(element);
    element.sourceUrl = "paper.pdf?x=%3Cscript%3E";
    await statusIncludes(element, "broken <module>");

    expect(shadowRoot(element).querySelector("script")).toBeNull();
    expect(shadow(element, "[data-status]", HTMLElement).textContent).toContain("broken <module>");
  });
});

describe("region marking", () => {
  it("reports a dragged region with the page text it covers", async () => {
    const harness = fakePdfJs(1);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 1");
    const selections: ResearchPdfSelectionDetail[] = [];
    element.addEventListener(researchPdfSelectionEventName, (event) => { selections.push(selectionDetail(event)); });

    shadowButton(element, "[data-mark]").click();
    expect(shadowButton(element, "[data-mark]").getAttribute("aria-pressed")).toBe("true");
    dragRegion(element, { fromX: 60, fromY: 80, toX: 300, toY: 160 });
    await waitFor(() => selections.length === 1);

    expect(selections[0]).toEqual({ page: 1, rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, quote: "Inside the region" });
    expect(shadowButton(element, "[data-mark]").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps a too-small drag out of the annotation flow", async () => {
    const harness = fakePdfJs(1);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 1");
    const selections: Event[] = [];
    element.addEventListener(researchPdfSelectionEventName, (event) => { selections.push(event); });

    shadowButton(element, "[data-mark]").click();
    dragRegion(element, { fromX: 60, fromY: 80, toX: 61, toY: 81 });
    await settle();

    expect(selections).toEqual([]);
    await statusIncludes(element, "too small to mark");
  });

  it("ignores drags while marking is disarmed", async () => {
    const harness = fakePdfJs(1);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 1");
    const selections: Event[] = [];
    element.addEventListener(researchPdfSelectionEventName, (event) => { selections.push(event); });

    dragRegion(element, { fromX: 60, fromY: 80, toX: 300, toY: 160 });
    await settle();

    expect(selections).toEqual([]);
  });

  it("paints stored annotations for the visible page and reports taps on them", async () => {
    const harness = fakePdfJs(2);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 2");

    element.annotations = [
      { id: "ann-1", page: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, kind: "question", status: "open", label: "Why?" },
      { id: "ann-2", page: 2, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, kind: "note", status: "resolved", label: "Later" },
    ];
    element.activeAnnotationId = "ann-1";

    const markers = shadowRoot(element).querySelectorAll("[data-annotation-id]");
    expect([...markers].map((marker) => marker.getAttribute("data-annotation-id"))).toEqual(["ann-1"]);
    const marker = markers[0];
    if (!(marker instanceof HTMLElement)) throw new Error("Expected a rendered marker");
    expect(marker.dataset["active"]).toBe("true");
    expect(marker.style.left).toBe("10%");
    expect(marker.getAttribute("aria-label")).toContain("Question on page 1: Why?");

    const activated: string[] = [];
    element.addEventListener(researchPdfAnnotationEventName, (event) => { activated.push(activatedAnnotationId(event)); });
    marker.click();
    expect(activated).toEqual(["ann-1"]);

    shadowButton(element, "[data-next]").click();
    await statusIncludes(element, "Page 2 of 2");
    expect([...shadowRoot(element).querySelectorAll("[data-annotation-id]")].map((entry) => entry.getAttribute("data-annotation-id"))).toEqual(["ann-2"]);
  });

  it("jumps to a page on request and clamps out-of-range requests", async () => {
    const harness = fakePdfJs(3);
    const element = createViewer();
    element.pdfJsLoader = harness.loader;
    document.body.append(element);
    element.sourceUrl = "paper.pdf";
    await statusIncludes(element, "Page 1 of 3");

    element.showPage(3);
    await statusIncludes(element, "Page 3 of 3");
    element.showPage(99);
    await settle();
    expect(element.currentPage).toBe(3);
    expect(element.pageCount).toBe(3);
  });
});

describe("PDF.js module validation", () => {
  it("accepts PDF.js 6's function-shaped GlobalWorkerOptions export", () => {
    const GlobalWorkerOptions = Object.assign(() => undefined, { workerSrc: "" });
    expect(isPdfJsModule({ GlobalWorkerOptions, getDocument: () => ({}) })).toBe(true);
  });
});

describe("boundedOutputScale", () => {
  it("caps render pixels and DPR", () => {
    const scale = boundedOutputScale(10_000, 10_000, 2);
    expect(scale).toBeCloseTo(Math.sqrt(MAX_PDF_RENDER_PIXELS / 100_000_000));
    expect(10_000 * 10_000 * scale * scale).toBeLessThanOrEqual(MAX_PDF_RENDER_PIXELS + 1);
    expect(boundedOutputScale(100, 100, 2)).toBe(2);
  });
});

function fakePdfJs(numPages: number, renderPromise: Promise<unknown> = Promise.resolve()) {
  const renderTasks: { promise: Promise<unknown>; cancel: ReturnType<typeof vi.fn> }[] = [];
  const pages = Array.from({ length: numPages }, () => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
    getTextContent: vi.fn(() => Promise.resolve({
      items: [
        { str: "Inside the region", transform: [10, 0, 0, 10, 100, 700], width: 100, height: 10 },
        { str: "Outside the region", transform: [10, 0, 0, 10, 100, 200], width: 100, height: 10 },
      ],
    })),
    render: vi.fn(() => {
      const task = { promise: renderPromise, cancel: vi.fn() };
      renderTasks.push(task);
      return task;
    }),
    cleanup: vi.fn(),
  }));
  const document = {
    numPages,
    getPage: vi.fn((page: number) => {
      const value = pages[page - 1];
      if (value === undefined) return Promise.reject(new Error("Page out of range"));
      return Promise.resolve(value);
    }),
    destroy: vi.fn(() => Promise.resolve()),
  };
  const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn(() => Promise.resolve()) };
  const workerOptions = { workerSrc: "" };
  const getDocument = vi.fn<PdfJsModule["getDocument"]>(() => loadingTask);
  const module: PdfJsModule = { GlobalWorkerOptions: workerOptions, getDocument };
  return { pages, renderTasks, document, loadingTask, workerOptions, getDocument, loader: vi.fn(() => Promise.resolve(module)) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Condition did not become true");
}

async function statusIncludes(element: ResearchLibraryPdfViewerElement, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (shadow(element, "[data-status]", HTMLElement).textContent.includes(text)) return;
    await settle();
  }
  throw new Error(`Status did not include ${text}: ${shadow(element, "[data-status]", HTMLElement).textContent}`);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createViewer(): ResearchLibraryPdfViewerElement {
  const value = document.createElement(researchLibraryPdfViewerTagName);
  if (!(value instanceof ResearchLibraryPdfViewerElement)) throw new Error("PDF viewer element was not registered");
  value.canvasContextFactory = () => ({});
  return value;
}

function pageAt<T>(pages: T[], index: number): T {
  const page = pages[index];
  if (page === undefined) throw new Error("Missing fake page");
  return page;
}

function shadowRoot(element: ResearchLibraryPdfViewerElement): ShadowRoot {
  const root = element.shadowRoot;
  if (root === null) throw new Error("PDF viewer shadow root is missing");
  return root;
}

function shadowButton(element: ResearchLibraryPdfViewerElement, selector: string): HTMLButtonElement {
  return shadow(element, selector, HTMLButtonElement);
}

function shadow<T extends Element>(element: ResearchLibraryPdfViewerElement, selector: string, type: abstract new (...args: never[]) => T): T {
  const value = shadowRoot(element).querySelector(selector);
  if (!(value instanceof type)) throw new Error(`Missing ${selector}`);
  return value;
}

/** Drive one pointer drag across the overlay, whose layout happy-dom cannot provide. */
function dragRegion(element: ResearchLibraryPdfViewerElement, drag: { fromX: number; fromY: number; toX: number; toY: number }): void {
  const overlay = shadow(element, "[data-overlay]", HTMLElement);
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, toJSON: () => ({}),
  });
  overlay.setPointerCapture = vi.fn();
  overlay.releasePointerCapture = vi.fn();
  overlay.hasPointerCapture = vi.fn(() => true);
  overlay.dispatchEvent(pointerEvent("pointerdown", drag.fromX, drag.fromY));
  overlay.dispatchEvent(pointerEvent("pointermove", drag.toX, drag.toY));
  overlay.dispatchEvent(pointerEvent("pointerup", drag.toX, drag.toY));
}

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return event;
}

function selectionDetail(event: Event): ResearchPdfSelectionDetail {
  const detail = eventDetail(event);
  const rect = detail["rect"];
  if (typeof detail["page"] !== "number" || typeof detail["quote"] !== "string" || !isRecord(rect)) throw new Error("Unexpected selection detail");
  const bounds = ["x", "y", "width", "height"].map((key) => {
    const value = rect[key];
    if (typeof value !== "number") throw new Error(`Unexpected selection rect ${key}`);
    return value;
  });
  return { page: detail["page"], quote: detail["quote"], rect: { x: bounds[0] ?? 0, y: bounds[1] ?? 0, width: bounds[2] ?? 0, height: bounds[3] ?? 0 } };
}

function activatedAnnotationId(event: Event): string {
  const id = eventDetail(event)["id"];
  if (typeof id !== "string") throw new Error("Unexpected annotation detail");
  return id;
}

function eventDetail(event: Event): Record<string, unknown> {
  if (!(event instanceof CustomEvent)) throw new Error("Expected a CustomEvent");
  const detail: unknown = event.detail;
  if (!isRecord(detail)) throw new Error("Expected an event detail object");
  return detail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
