// @vitest-environment happy-dom

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { type SyntheticAnswerDraft } from "./draftsClient.js";
import { clearResearchLibraryFixtureCache, researchLibraryPanelVisible } from "./fixtureCache.js";
import { sha256Hex, tokenIdFromDispatchToken } from "./researchLibraryClient.js";
import { defineResearchLibraryPanelElement, researchLibraryPanelTagName } from "./researchLibraryPanelElement.js";

const hostileFixture = JSON.stringify({
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [
    {
      id: "synthetic-paper-a",
      title: "<img src=x onerror=alert(1)> Synthetic A",
      authors: ["Ada Example"],
      tags: ["synthetic"],
      collections: ["Demo"],
      passages: [{ id: "synthetic-passage-a", page: 2, quote: "</blockquote><script>alert(1)</script>", question: "Why remain bounded?" }],
      cites: ["synthetic-paper-b"],
    },
    {
      id: "synthetic-paper-b",
      title: "Synthetic B",
      authors: ["Ben Example"],
      tags: [],
      collections: [],
      passages: [],
      cites: [],
    },
  ],
});

beforeAll(() => { defineResearchLibraryPanelElement(); });
beforeEach(() => {
  clearResearchLibraryFixtureCache();
  Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: vi.fn(() => false) });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("PI WEB research library panel", () => {
  it("renders escaped metadata, citation connections, and a deferred PDF notice", async () => {
    const { context } = createContext();
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();

    const root = requiredShadowRoot(element);
    expect(root.textContent).toContain("Synthetic A");
    expect(root.textContent).toContain("Cited by");
    expect(root.textContent).toContain("Actual PDF streaming/rendering is intentionally deferred");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
  });

  it("creates a bounded intent and inserts only its opaque token after explicit confirmation", async () => {
    const { context, writeFile, insertText } = createContext();
    vi.mocked(window.confirm).mockReturnValue(true);
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();

    expect(writeFile).not.toHaveBeenCalled();
    expect(insertText).not.toHaveBeenCalled();
    element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-passage-id]")?.click();
    await flush();
    await flush();

    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0];
    if (call === undefined) throw new Error("Expected one dispatch intent write");
    const [path, content, options] = call;
    expect(path).toMatch(/^\.pi-web\/research-library-runtime\/intents\/[A-Za-z0-9_-]{43}\.json$/u);
    expect(options).toEqual({ createDirs: true, overwrite: false });
    expect(String(content)).not.toContain("Why remain bounded?");
    expect(String(content)).not.toContain("script");
    expect(insertText).toHaveBeenCalledTimes(1);
    const inserted = insertText.mock.calls[0]?.[0];
    expect(inserted).toMatch(/^research-library:v1:[A-Za-z0-9_-]{43}$/u);
    expect(element.shadowRoot?.textContent).toContain("Inserted only the opaque token");
  });

  it("renders verified runtime drafts as escaped untrusted text", async () => {
    const draft = await answerDraft("<img src=x onerror=alert(1)> Draft answer");
    const { context } = createContext(draft);
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();
    await flush();

    const root = requiredShadowRoot(element);
    expect(root.textContent).toContain("<img src=x onerror=alert(1)> Draft answer");
    expect(root.querySelector("img")).toBeNull();
  });

  it("does not write or insert when the user cancels", async () => {
    const { context, writeFile, insertText } = createContext();
    vi.mocked(window.confirm).mockReturnValue(false);
    await loadVisibility(context);
    const element = mountPanel(context);
    await flush();

    element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-passage-id]")?.click();
    await flush();

    expect(writeFile).not.toHaveBeenCalled();
    expect(insertText).not.toHaveBeenCalled();
  });
});

function createContext(draft?: SyntheticAnswerDraft): {
  context: WorkspacePanelContext;
  writeFile: Mock<WorkspacePanelContext["files"]["writeFile"]>;
  insertText: Mock<(text: string) => void>;
} {
  let promptText = "";
  const writeFile = vi.fn<WorkspacePanelContext["files"]["writeFile"]>((path: string, content: string | Uint8Array) => Promise.resolve({ path, size: typeof content === "string" ? content.length : content.byteLength, modifiedAt: new Date(0).toISOString(), created: true }));
  const insertText = vi.fn((text: string) => { promptText += text; });
  const draftTokenId = draft === undefined ? undefined : tokenIdFromDispatchToken(draft.token);
  const draftPath = draftTokenId === undefined ? undefined : `.pi-web/research-library-runtime/drafts/${draftTokenId}.json`;
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true, isGitRepo: true, isGitWorktree: false },
    files: {
      readFile: vi.fn<WorkspacePanelContext["files"]["readFile"]>((path) => {
        if (path === ".pi-web/research-library.synthetic.json") return Promise.resolve({ path, content: hostileFixture, encoding: "utf8", size: hostileFixture.length, modifiedAt: new Date(0).toISOString(), truncated: false, binary: false });
        if (draft !== undefined && path === draftPath) {
          const content = JSON.stringify(draft);
          return Promise.resolve({ path, content, encoding: "utf8", size: content.length, modifiedAt: draft.createdAt, truncated: false, binary: false });
        }
        return Promise.reject(new Error("Path does not exist"));
      }),
      listFiles: vi.fn<WorkspacePanelContext["files"]["listFiles"]>((path) => {
        if (draft !== undefined && draftPath !== undefined && draftTokenId !== undefined && path === ".pi-web/research-library-runtime/drafts") {
          return Promise.resolve({ path, scannedAt: new Date(0).toISOString(), truncated: false, entries: [{ name: `${draftTokenId}.json`, path: draftPath, type: "file", size: JSON.stringify(draft).length, modifiedAt: draft.createdAt }] });
        }
        return Promise.reject(new Error("Path does not exist"));
      }),
      writeFile,
      deleteFile: vi.fn<WorkspacePanelContext["files"]["deleteFile"]>((path) => Promise.resolve({ path, existed: false })),
      moveFile: vi.fn<WorkspacePanelContext["files"]["moveFile"]>((fromPath, toPath) => Promise.resolve({ fromPath, toPath, size: 0, modifiedAt: new Date(0).toISOString() })),
    },
    prompt: { insertText, getText: () => promptText, getSelection: () => null },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
  };
  return { context, writeFile, insertText };
}

async function answerDraft(answer: string): Promise<SyntheticAnswerDraft> {
  const tokenId = "D".repeat(43);
  const content = {
    token: `research-library:v1:${tokenId}`,
    libraryId: "synthetic-library",
    paperId: "synthetic-paper-a",
    passageId: "synthetic-passage-a",
    question: "Why remain bounded?",
    answer,
    evidenceIds: ["passage:synthetic-paper-a:synthetic-passage-a"],
    idempotencyKey: "panel-draft-v1",
  };
  return { version: 1, synthetic: true, status: "draft", ...content, createdAt: "2026-08-08T08:00:00.000Z", contentSha256: await sha256Hex(JSON.stringify(content)) };
}

async function loadVisibility(context: WorkspacePanelContext): Promise<void> {
  expect(researchLibraryPanelVisible(context)).toBe(false);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flush();
    if (researchLibraryPanelVisible(context)) return;
  }
  throw new Error("Timed out waiting for research-library visibility");
}

function mountPanel(context: WorkspacePanelContext): HTMLElement {
  const element = document.createElement(researchLibraryPanelTagName);
  Object.assign(element, { context });
  document.body.append(element);
  return element;
}

function requiredShadowRoot(element: HTMLElement): ShadowRoot {
  const root = element.shadowRoot;
  if (root === null) throw new Error("Research-library panel has no shadow root");
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
