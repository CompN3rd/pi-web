import { describe, expect, it, vi } from "vitest";
import { RESEARCH_LIBRARY_CONFIG_PATH } from "./config.js";
import {
  loadResearchLibraryFixture,
  prepareResearchDispatch,
  RESEARCH_DISPATCH_TTL_MS,
  tokenIdFromDispatchToken,
  type LoadedResearchLibraryFixture,
  type ResearchLibraryFileContent,
  type ResearchLibraryFileWriter,
  type ResearchLibraryPrompt,
} from "./researchLibraryClient.js";

const fixtureValue = {
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [
    {
      id: "synthetic-paper-a",
      title: "Synthetic Paper A",
      authors: ["Ada Example"],
      tags: ["synthetic"],
      collections: ["Demo"],
      passages: [{ id: "synthetic-passage-a", page: 2, quote: "Generated evidence.", question: "What follows?" }],
      cites: [],
    },
  ],
};

describe("research library browser client", () => {
  it("loads and hashes a bounded synthetic fixture", async () => {
    const text = JSON.stringify(fixtureValue);
    const readFile = vi.fn(() => Promise.resolve(fileContent(text)));

    const result = await loadResearchLibraryFixture({ readFile });

    expect(readFile).toHaveBeenCalledWith(RESEARCH_LIBRARY_CONFIG_PATH);
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") throw new Error("Valid fixture did not load");
    expect(result.fixture.config.libraryId).toBe("synthetic-library");
    expect(result.fixture.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("distinguishes a missing fixture from invalid and truncated fixtures", async () => {
    await expect(loadResearchLibraryFixture({ readFile: () => Promise.reject(new Error("Path does not exist")) })).resolves.toEqual({ kind: "missing" });
    const invalid = await loadResearchLibraryFixture({ readFile: () => Promise.resolve(fileContent("{}")) });
    expect(invalid.kind).toBe("unavailable");
    const truncated = await loadResearchLibraryFixture({ readFile: () => Promise.resolve({ ...fileContent("{}"), truncated: true }) });
    expect(truncated.kind).toBe("unavailable");
    if (truncated.kind !== "unavailable") throw new Error("Truncated fixture unexpectedly loaded");
    expect(truncated.error).toContain("exceeds");
  });

  it("writes a create-only bounded intent before inserting only its token", async () => {
    const loaded = await loadedFixture();
    let promptText = "";
    const insertText = vi.fn((value: string) => { promptText += value; });
    const prompt: ResearchLibraryPrompt = { getText: () => promptText, insertText };
    const writeFile = vi.fn<ResearchLibraryFileWriter["writeFile"]>(() => Promise.resolve(undefined));
    const now = new Date("2026-08-08T08:00:00.000Z");

    const result = await prepareResearchDispatch({
      fixture: loaded,
      paperId: "synthetic-paper-a",
      passageId: "synthetic-passage-a",
      scopeKind: "current-paper",
    }, {
      files: { writeFile },
      prompt,
      now: () => now,
      randomBytes: (target) => target.fill(1),
    });

    expect(result.token).toMatch(/^research-library:v1:[A-Za-z0-9_-]{43}$/u);
    expect(tokenIdFromDispatchToken(result.token)).toHaveLength(43);
    expect(insertText).toHaveBeenCalledExactlyOnceWith(result.token);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0];
    if (call === undefined) throw new Error("Expected one intent write");
    const [path, serialized, options] = call;
    expect(path).toBe(result.intentPath);
    expect(options).toEqual({ createDirs: true, overwrite: false });
    const intent: unknown = JSON.parse(String(serialized));
    expect(intent).toMatchObject({
      version: 1,
      synthetic: true,
      token: result.token,
      paperId: "synthetic-paper-a",
      passageId: "synthetic-passage-a",
      expiresAt: new Date(now.getTime() + RESEARCH_DISPATCH_TTL_MS).toISOString(),
      scope: { kind: "current-paper", paperIds: ["synthetic-paper-a"] },
    });
    expect(serialized).not.toContain("Generated evidence");
  });

  it("does not insert a token after a failed intent write", async () => {
    const loaded = await loadedFixture();
    const insertText = vi.fn<(text: string) => void>();
    const prompt = { getText: () => "", insertText };

    await expect(prepareResearchDispatch({
      fixture: loaded,
      paperId: "synthetic-paper-a",
      passageId: "synthetic-passage-a",
      scopeKind: "synthetic-library",
    }, {
      files: { writeFile: () => Promise.reject(new Error("write refused")) },
      prompt,
      randomBytes: (target) => target.fill(2),
    })).rejects.toThrow("write refused");
    expect(insertText).not.toHaveBeenCalled();
  });

  it("surfaces an orphan intent when no mounted prompt accepts the token", async () => {
    const loaded = await loadedFixture();

    await expect(prepareResearchDispatch({
      fixture: loaded,
      paperId: "synthetic-paper-a",
      passageId: "synthetic-passage-a",
      scopeKind: "current-paper",
    }, {
      files: { writeFile: () => Promise.resolve(undefined) },
      prompt: { getText: () => "", insertText: () => undefined },
      randomBytes: (target) => target.fill(3),
    })).rejects.toThrow("orphan intent is harmless");
  });
});

async function loadedFixture(): Promise<LoadedResearchLibraryFixture> {
  const text = JSON.stringify(fixtureValue);
  const result = await loadResearchLibraryFixture({ readFile: () => Promise.resolve(fileContent(text)) });
  if (result.kind !== "loaded") throw new Error("Valid test fixture did not load");
  return result.fixture;
}

function fileContent(content: string): ResearchLibraryFileContent {
  return { content, size: content.length, truncated: false, binary: false };
}
