import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getResearchContext,
  publishSyntheticAnswerDraft,
  RESEARCH_MAX_SEARCHES,
  searchClaimedResearch,
} from "./core.js";

const roots: string[] = [];
const now = new Date("2026-08-08T08:00:00.000Z");
const tokenId = "A".repeat(43);
const token = `research-library:v1:${tokenId}`;

const fixture = {
  version: 1,
  synthetic: true,
  libraryId: "synthetic-library",
  papers: [
    {
      id: "synthetic-paper-a",
      title: "Synthetic Paper A",
      authors: ["Ada Example"],
      year: 2026,
      abstract: "Generated graph evidence.",
      tags: ["synthetic"],
      collections: ["Demo"],
      passages: [{ id: "synthetic-passage-a", page: 2, quote: "Generated evidence quote.", question: "Why retain provenance?" }],
      cites: ["synthetic-paper-b"],
    },
    {
      id: "synthetic-paper-b",
      title: "Synthetic Paper B",
      authors: ["Ben Example"],
      tags: ["context"],
      collections: ["Demo"],
      passages: [{ id: "synthetic-passage-b", page: 4, quote: "Bounded context text.", question: "Why bound context?" }],
      cites: [],
    },
  ],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("synthetic research-library core", () => {
  it("claims a digest-bound intent for one Pi session and freezes its snapshot", async () => {
    const root = await workspaceWithIntent("current-paper");

    const context = await getResearchContext(root, "session-one", token, now);

    expect(context.paper.id).toBe("synthetic-paper-a");
    expect("passages" in context.paper).toBe(false);
    expect(context.passage.id).toBe("synthetic-passage-a");
    expect(context.citedPapers).toEqual([{ id: "synthetic-paper-b", title: "Synthetic Paper B" }]);
    expect(context.allowedEvidenceIds).toContain("passage:synthetic-paper-a:synthetic-passage-a");
    expect(context.allowedEvidenceIds).not.toContain("passage:synthetic-paper-b:synthetic-passage-b");
    await expect(getResearchContext(root, "session-two", token, now)).rejects.toThrow("another Pi session");

    const firstPaper = fixture.papers[0];
    const secondPaper = fixture.papers[1];
    if (firstPaper === undefined || secondPaper === undefined) throw new Error("Synthetic test fixture is incomplete");
    const changed = { ...fixture, papers: [{ ...firstPaper, title: "Changed after claim" }, secondPaper] };
    await writeFile(join(root, ".pi-web", "research-library.synthetic.json"), JSON.stringify(changed));
    const replay = await getResearchContext(root, "session-one", token, now);
    expect(replay.paper.title).toBe("Synthetic Paper A");
  });

  it("rejects fixture drift before the first claim", async () => {
    const root = await workspaceWithIntent("current-paper");
    await writeFile(join(root, ".pi-web", "research-library.synthetic.json"), `${JSON.stringify(fixture)}\n`);

    await expect(getResearchContext(root, "session-one", token, now)).rejects.toThrow("fixture changed");
  });

  it("persists literal scoped search receipts and enforces idempotency and budgets", async () => {
    const root = await workspaceWithIntent("synthetic-library");
    await getResearchContext(root, "session-one", token, now);

    const first = await searchClaimedResearch(root, "session-one", token, "synthetic", 5, "call-one", now);
    expect(first.results.map((result) => result.paperId)).toEqual(["synthetic-paper-a", "synthetic-paper-b"]);
    expect(first.replayed).toBe(false);
    const replay = await searchClaimedResearch(root, "session-one", token, "synthetic", 5, "call-one", now);
    expect(replay).toMatchObject({ replayed: true, results: first.results });
    await expect(searchClaimedResearch(root, "session-one", token, "different", 5, "call-one", now)).rejects.toThrow("retry does not match");

    for (let index = 1; index < RESEARCH_MAX_SEARCHES; index += 1) {
      await searchClaimedResearch(root, "session-one", token, "example", 5, `call-${String(index + 1)}`, now);
    }
    await expect(searchClaimedResearch(root, "session-one", token, "example", 5, "call-over-budget", now)).rejects.toThrow("budget is exhausted");
  });

  it("rejects altered persisted claim and receipt authority", async () => {
    const claimRoot = await workspaceWithIntent("current-paper");
    await getResearchContext(claimRoot, "session-one", token, now);
    const claimPath = join(claimRoot, ".pi-web", "research-library-runtime", "claims", `${tokenId}.json`);
    const claim = await readJsonRecord(claimPath);
    claim["paperId"] = "synthetic-paper-b";
    await writeFile(claimPath, JSON.stringify(claim));
    await expect(getResearchContext(claimRoot, "session-one", token, now)).rejects.toThrow("claim content digest mismatch");

    const receiptRoot = await workspaceWithIntent("synthetic-library");
    await getResearchContext(receiptRoot, "session-one", token, now);
    await searchClaimedResearch(receiptRoot, "session-one", token, "synthetic", 5, "tamper-call", now);
    const receiptName = `${createHash("sha256").update("tamper-call").digest("hex")}.json`;
    const receiptPath = join(receiptRoot, ".pi-web", "research-library-runtime", "searches", tokenId, receiptName);
    const receipt = await readJsonRecord(receiptPath);
    receipt["returnedCharacters"] = 0;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(searchClaimedResearch(receiptRoot, "session-one", token, "synthetic", 5, "tamper-call", now)).rejects.toThrow("character accounting is invalid");
  });

  it("atomically caps concurrent distinct searches at three persisted slots", async () => {
    const root = await workspaceWithIntent("synthetic-library");
    await getResearchContext(root, "session-one", token, now);

    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_value, index) =>
      searchClaimedResearch(root, "session-one", token, "synthetic", 5, `concurrent-${String(index)}`, now)));

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    for (const failure of attempts.filter((result) => result.status === "rejected")) {
      expect(failure.reason).toBeInstanceOf(Error);
      if (!(failure.reason instanceof Error)) throw new Error("Expected search budget rejection to be an Error");
      expect(failure.reason.message).toContain("budget is exhausted");
    }
    const slotNames = await readdir(join(root, ".pi-web", "research-library-runtime", "search-slots", tokenId));
    const receiptNames = await readdir(join(root, ".pi-web", "research-library-runtime", "searches", tokenId));
    expect(slotNames).toHaveLength(3);
    expect(receiptNames).toHaveLength(3);
    let returnedCharacters = 0;
    for (const receiptName of receiptNames) {
      const receipt: unknown = JSON.parse(await readFile(join(root, ".pi-web", "research-library-runtime", "searches", tokenId, receiptName), "utf8"));
      if (!isRecord(receipt) || typeof receipt["returnedCharacters"] !== "number") throw new Error("Synthetic search receipt is malformed");
      returnedCharacters += receipt["returnedCharacters"];
    }
    expect(returnedCharacters).toBeLessThanOrEqual(12_000);
  });

  it("publishes one additive draft and treats identical retries idempotently", async () => {
    const root = await workspaceWithIntent("current-paper");
    await getResearchContext(root, "session-one", token, now);
    const input = {
      answer: "A synthetic answer with provenance.",
      evidenceIds: ["passage:synthetic-paper-a:synthetic-passage-a"],
      idempotencyKey: "answer-v1",
    };

    const published = await publishSyntheticAnswerDraft(root, "session-one", token, input, now);
    expect(published.status).toBe("published");
    await expect(publishSyntheticAnswerDraft(root, "session-one", token, input, new Date(now.getTime() + 1_000))).resolves.toMatchObject({ status: "already-published" });
    await expect(publishSyntheticAnswerDraft(root, "session-one", token, { ...input, answer: "Different answer" }, now)).rejects.toThrow("different synthetic answer draft");
    await expect(publishSyntheticAnswerDraft(root, "session-one", token, { ...input, evidenceIds: ["passage:synthetic-paper-b:synthetic-passage-b"] }, now)).rejects.toThrow("outside the claimed context");

    const stored: unknown = JSON.parse(await readFile(join(root, ".pi-web", "research-library-runtime", "drafts", `${tokenId}.json`), "utf8"));
    expect(stored).toMatchObject({ status: "draft", answer: input.answer });
    if (!isRecord(stored) || typeof stored["contentSha256"] !== "string") throw new Error("Stored synthetic draft has no digest");
    expect(stored["contentSha256"]).toMatch(/^[a-f0-9]{64}$/u);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error("Expected a JSON object in synthetic test runtime");
  return value;
}

async function workspaceWithIntent(scopeKind: "current-paper" | "synthetic-library"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-research-library-"));
  roots.push(root);
  const piWeb = join(root, ".pi-web");
  const intents = join(piWeb, "research-library-runtime", "intents");
  await mkdir(intents, { recursive: true });
  const fixtureText = JSON.stringify(fixture);
  await writeFile(join(piWeb, "research-library.synthetic.json"), fixtureText);
  const paperIds = scopeKind === "current-paper" ? ["synthetic-paper-a"] : ["synthetic-paper-a", "synthetic-paper-b"];
  const intent = {
    version: 1,
    synthetic: true,
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60 * 1_000).toISOString(),
    fixtureSha256: createHash("sha256").update(fixtureText).digest("hex"),
    libraryId: "synthetic-library",
    paperId: "synthetic-paper-a",
    passageId: "synthetic-passage-a",
    scope: {
      kind: scopeKind,
      paperIds,
      maxSearches: 3,
      maxResultsPerSearch: 5,
      maxReturnedCharacters: 12_000,
    },
  };
  await writeFile(join(intents, `${tokenId}.json`), `${JSON.stringify(intent)}\n`);
  return root;
}
