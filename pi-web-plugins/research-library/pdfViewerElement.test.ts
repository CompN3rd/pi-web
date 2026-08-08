// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedOutputScale,
  defineResearchLibraryPdfViewerElement,
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
