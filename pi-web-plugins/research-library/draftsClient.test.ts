import { describe, expect, it, vi } from "vitest";
import { loadSyntheticAnswerDrafts, verifySyntheticAnswerDraft, type SyntheticAnswerDraft } from "./draftsClient.js";
import { sha256Hex } from "./researchLibraryClient.js";

const tokenId = "A".repeat(43);

describe("synthetic drafts browser client", () => {
  it("verifies the bounded draft display contract, filename binding, and digest", async () => {
    const draft = await validDraft();
    await expect(verifySyntheticAnswerDraft(draft, tokenId)).resolves.toMatchObject({ status: "draft", answer: "Synthetic answer." });
    await expect(verifySyntheticAnswerDraft({ ...draft, status: "accepted" }, tokenId)).rejects.toThrow("status is invalid");
    await expect(verifySyntheticAnswerDraft({ ...draft, html: "<script>" }, tokenId)).rejects.toThrow("unknown fields");
    await expect(verifySyntheticAnswerDraft({ ...draft, answer: "Modified" }, tokenId)).rejects.toThrow("digest mismatch");
    await expect(verifySyntheticAnswerDraft(draft, "B".repeat(43))).rejects.toThrow("filename does not match");
    await expect(verifySyntheticAnswerDraft({ ...draft, evidenceIds: [draft.evidenceIds[0], draft.evidenceIds[0]] }, tokenId)).rejects.toThrow("unique and sorted");
  });

  it("loads matching drafts and reports malformed files without rendering them", async () => {
    const draft = await validDraft();
    const readFile = vi.fn((path: string) => Promise.resolve(path.endsWith(`${tokenId}.json`)
      ? { content: JSON.stringify(draft), size: 100, truncated: false, binary: false }
      : { content: "{}", size: 2, truncated: false, binary: false }));
    const result = await loadSyntheticAnswerDrafts({
      listFiles: () => Promise.resolve({
        truncated: false,
        entries: [
          { name: `${tokenId}.json`, path: `.pi-web/research-library-runtime/drafts/${tokenId}.json`, type: "file" },
          { name: `${"B".repeat(43)}.json`, path: `.pi-web/research-library-runtime/drafts/${"B".repeat(43)}.json`, type: "file" },
          { name: "ignored.txt", path: ".pi-web/research-library-runtime/drafts/ignored.txt", type: "file" },
        ],
      }),
      readFile,
    }, "synthetic-library");

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") throw new Error("Synthetic drafts did not load");
    expect(result.drafts).toMatchObject([{ answer: "Synthetic answer." }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`${"B".repeat(43)}.json`);
  });
});

async function validDraft(): Promise<SyntheticAnswerDraft> {
  const content = {
    token: `research-library:v1:${tokenId}`,
    libraryId: "synthetic-library",
    paperId: "synthetic-paper",
    passageId: "synthetic-passage",
    question: "Synthetic question?",
    answer: "Synthetic answer.",
    evidenceIds: ["passage:synthetic-paper:synthetic-passage"],
    idempotencyKey: "answer-v1",
  };
  return {
    version: 1,
    synthetic: true,
    status: "draft",
    ...content,
    createdAt: "2026-08-08T08:00:00.000Z",
    contentSha256: await sha256Hex(JSON.stringify(content)),
  };
}
