// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesCodeViewer } from "../../../../pi-web-plugins/files/FilesCodeViewer";
import { hashSource } from "../../../../pi-web-plugins/files/reviewHash";
import type { ReviewComment, WorkspaceReview, WorkspaceReviewDraft, WorkspaceReviewLineRef } from "@jmfederico/pi-web/plugin-api";
import "./ReviewThread";
import { EditorView } from "@codemirror/view";
import { reviewGutterDomEventHandlers, type CodeViewerReviewOptions } from "../../../../pi-web-plugins/files/codeViewerReview";
import { initialAppState } from "../appState";
import { ReviewController } from "../controllers/reviewController";

customElements.define("pi-web-files-code-viewer", FilesCodeViewer);

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function fakeReview(overrides: {
  commentsForLine?: (path: string, ref: WorkspaceReviewLineRef) => readonly ReviewComment[];
  draftForLine?: (path: string, ref: WorkspaceReviewLineRef) => WorkspaceReviewDraft | null;
} = {}) {
  const spies = {
    total: vi.fn(() => 0),
    countForFile: vi.fn(() => 0),
    commentsForLine: vi.fn(overrides.commentsForLine ?? (() => [])),
    draftForLine: vi.fn(overrides.draftForLine ?? (() => null)),
    lineState: vi.fn(() => ({ selected: false, commented: false })),
    canAuthor: vi.fn(() => true),
    beginSelection: vi.fn(),
    extendSelection: vi.fn(),
    commitSelection: vi.fn(),
    cancelSelection: vi.fn(),
    setDraftBody: vi.fn(),
    submitDraft: vi.fn(),
    cancelDraft: vi.fn(),
    updateComment: vi.fn(),
    removeComment: vi.fn(),
    invalidateFile: vi.fn(),
  };
  const review: WorkspaceReview & { invalidateFile: typeof spies.invalidateFile } = { ...spies };
  return { review, spies };
}

async function mountCodeViewer(): Promise<FilesCodeViewer> {
  const el = new FilesCodeViewer();
  document.body.append(el);
  await el.updateComplete;
  return el;
}

it("keeps one raw CRLF fingerprint through gestures, review refreshes, and invalidation", async () => {
  let state = initialAppState();
  state = { ...state, selectedSession: { id: "review-session", path: "/session.jsonl", cwd: "/repo", created: "", modified: "", messageCount: 0, firstMessage: "" } };
  const controller = new ReviewController(() => state, (patch) => { state = { ...state, ...patch }; });
  const adapter = (): WorkspaceReview => ({
    total: () => controller.total(), countForFile: (path) => controller.countForFile(path),
    commentsForLine: (path, ref) => controller.commentsForLine(path, ref),
    draftForLine: (path, ref) => controller.draftForLine(path, ref) ?? null,
    lineState: (path, ref) => controller.lineState(path, ref), canAuthor: () => controller.canAuthor(),
    beginSelection: (path, ref) => { controller.beginSelection(path, ref); },
    extendSelection: (ref) => { controller.extendSelection(ref); }, commitSelection: (hash) => { controller.commitSelection(hash); },
    cancelSelection: () => { controller.cancelSelection(); }, cancelDraft: () => { controller.cancelDraft(); },
    setDraftBody: (body) => { controller.setDraftBody(body); }, submitDraft: (anchor) => { controller.submitDraft(anchor); },
    updateComment: (id, body, anchor) => { controller.update(id, body, anchor); }, removeComment: (id) => { controller.remove(id); },
    invalidateFile: (path, hash, source) => { controller.invalidateFile(path, hash, source); },
  });
  controller.beginSelection("a.ts", { source: "git-staged", side: "new", line: 1 });
  controller.commitSelection("git-hash");
  controller.setDraftBody("Git feedback");
  controller.submitDraft();
  const el = await mountCodeViewer();
  el.content = "a\r\nb\r\n";
  el.reviewFilePath = "a.ts";
  const refresh = async () => { el.review = adapter(); await el.updateComplete; };
  await refresh();
  const editor = el.shadowRoot?.querySelector(".cm-editor");
  if (!(editor instanceof HTMLElement)) throw new Error("Expected CodeMirror editor");
  const view = EditorView.findFromDOM(editor);
  const options: unknown = Reflect.get(el, "reviewOptions");
  if (view === null || !isReviewOptions(options)) throw new Error("Expected initialized review boundary");
  expect(hashSource(view.state.doc.toString())).not.toBe(hashSource(el.content));
  expect(options.sourceHash).toBe(hashSource(el.content));
  // Use CM's resolved-line handler boundary: happy-dom has no gutter hit-test geometry.
  const handlers = reviewGutterDomEventHandlers(options);
  const line = view.lineBlockAt(view.state.doc.line(1).from);
  handlers.mousedown(view, line, new MouseEvent("mousedown", { button: 0 }));
  await refresh();
  expect(state.reviewSelection?.sourceHash).toBe(hashSource(el.content));
  handlers.mouseup(view, line, new MouseEvent("mouseup"));
  await refresh();
  expect(controller.draft()?.body).toBe("");
  expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();
  controller.setDraftBody("raw feedback");
  controller.submitDraft();
  await refresh();
  expect(controller.list().map((comment) => comment.body)).toEqual(["Git feedback", "raw feedback"]);
  expect(controller.list()[1]?.sourceHash).toBe(hashSource(el.content));
  expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();
  // Even a line-ending-only source change is genuine; do not normalize it away.
  el.content = "a\nb\n";
  await el.updateComplete;
  expect(controller.list().map((comment) => comment.body)).toEqual(["Git feedback"]);
});

function isReviewOptions(value: unknown): value is CodeViewerReviewOptions {
  return typeof value === "object" && value !== null && "sourceHash" in value && typeof value.sourceHash === "string"
    && "filePath" in value && "review" in value;
}

describe("CodeViewer without review (regression)", () => {
  it("renders content with no gutter click handling and no thread widgets", async () => {
    const el = await mountCodeViewer();
    el.content = "line one\nline two\n";
    el.language = "typescript";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".cm-content")?.textContent).toContain("line one");
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).toBeNull();
  });

  it("still rebuilds on content change with review undefined", async () => {
    const el = await mountCodeViewer();
    el.content = "a\n";
    await el.updateComplete;
    el.content = "b\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".cm-content")?.textContent).toContain("b");
  });
});

describe("CodeViewer with review", () => {
  it("mounts inline comment widgets for the given file", async () => {
    const comment: ReviewComment = {
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "hi",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    };
    const { review } = fakeReview({ commentsForLine: (_path, ref) => (ref.line === 1 ? [comment] : []) });
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "a\nb\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();
  });

  it("invalidates the file's stale comments on every content change", async () => {
    const { review, spies } = fakeReview();
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "first\n";
    await el.updateComplete;
    expect(spies.invalidateFile).toHaveBeenCalledWith("src/a.ts", hashSource("first\n"), "files");
    el.content = "second\n";
    await el.updateComplete;
    expect(spies.invalidateFile).toHaveBeenCalledWith("src/a.ts", hashSource("second\n"), "files");
  });

  it("validates the newly selected review owner without rebuilding an unchanged editor", async () => {
    const { review: reviewA, spies: spiesA } = fakeReview();
    const { review: reviewB, spies: spiesB } = fakeReview();
    const el = await mountCodeViewer();
    el.review = reviewA;
    el.reviewFilePath = "src/a.ts";
    el.content = "same\n";
    await el.updateComplete;
    expect(spiesA.invalidateFile).toHaveBeenCalledTimes(1);

    // Swap to a different `review` instance/reference with content/language/reviewFilePath unchanged.
    el.review = reviewB;
    await el.updateComplete;
    expect(spiesA.invalidateFile).toHaveBeenCalledTimes(1);
    expect(spiesB.invalidateFile).toHaveBeenCalledWith("src/a.ts", hashSource("same\n"), "files");
  });

  it("refreshes inline comment/draft widgets when review data changes externally (e.g. removed via the prompt chip, or cleared after a successful send), without recreating the editor", async () => {
    // Regression: comments removed/cleared through a path that never goes
    // through this CM6 view (the prompt-editor's review chip, or
    // `ReviewController.completeSend` after a successful send) previously
    // left the widget stuck showing stale data until *something else*
    // (e.g. switching tabs, which recreates the editor) forced a rebuild.
    // `review`/its query methods are the same live controller underneath,
    // so a change is only observable by re-querying it -- there is no
    // separate "comments changed" signal here, only the property being
    // reassigned (a fresh adapter object) on every app-level re-render.
    let comments: ReviewComment[] = [{
      id: "review-1",
      anchor: { filePath: "src/a.ts", range: { side: "new", start: 1, end: 1 } },
      body: "hello",
      createdAt: 0,
      updatedAt: 0,
      sourceHash: "x",
    }];
    const { review } = fakeReview({ commentsForLine: (_path, ref) => (ref.line === 1 ? comments : []) });
    const el = await mountCodeViewer();
    el.review = review;
    el.reviewFilePath = "src/a.ts";
    el.content = "a\nb\n";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).not.toBeNull();

    // Comment removed externally; a fresh `review` adapter object (same
    // underlying controller/state) is assigned, as happens on every
    // app-level re-render.
    comments = [];
    el.review = { ...review };
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("pi-web-review-thread")).toBeNull();
  });
});
