import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT, TranscriptBranchCache } from "./transcriptBranchCache.js";

describe("TranscriptBranchCache", () => {
  it("returns the memoized branch while the file signature matches", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    const branch = [{ id: "m1" }];
    cache.set("/sessions/a.jsonl", "sig-1", branch);

    expect(cache.get("/sessions/a.jsonl", "sig-1")).toBe(branch);
  });

  it("misses unknown paths and stale signatures", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", "sig-1", [{ id: "m1" }]);

    expect(cache.get("/sessions/missing.jsonl", "sig-1")).toBeUndefined();
    expect(cache.get("/sessions/a.jsonl", "sig-2")).toBeUndefined();
  });

  it("replaces the memoized branch when a new signature is stored", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", "sig-1", [{ id: "m1" }]);
    const updated = [{ id: "m1" }, { id: "m2" }];
    cache.set("/sessions/a.jsonl", "sig-2", updated);

    expect(cache.get("/sessions/a.jsonl", "sig-2")).toBe(updated);
    expect(cache.get("/sessions/a.jsonl", "sig-1")).toBeUndefined();
  });

  it("evicts the least recently used entry beyond the limit", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", "sig", ["a"]);
    cache.set("/sessions/b.jsonl", "sig", ["b"]);
    cache.set("/sessions/c.jsonl", "sig", ["c"]);

    expect(cache.get("/sessions/a.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/b.jsonl", "sig")).toEqual(["b"]);
    expect(cache.get("/sessions/c.jsonl", "sig")).toEqual(["c"]);
  });

  it("keeps a recently read entry when other sessions churn through the bound", () => {
    // The steady-state shape this cache exists for: one session polled every
    // few seconds must stay memoized while one-off reads of other sessions
    // pass through the same bound.
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/polled.jsonl", "sig", ["polled"]);
    cache.set("/sessions/other.jsonl", "sig", ["other"]);

    expect(cache.get("/sessions/polled.jsonl", "sig")).toEqual(["polled"]);
    cache.set("/sessions/third.jsonl", "sig", ["third"]);

    expect(cache.get("/sessions/polled.jsonl", "sig")).toEqual(["polled"]);
    expect(cache.get("/sessions/other.jsonl", "sig")).toBeUndefined();
  });

  it("treats a re-stored entry as recently used", () => {
    const cache = new TranscriptBranchCache({ limit: 2 });
    cache.set("/sessions/a.jsonl", "sig-1", ["a"]);
    cache.set("/sessions/b.jsonl", "sig", ["b"]);
    // A grew on disk and was re-parsed: storing the fresh snapshot must count
    // as use, so the next insert evicts b, not a.
    cache.set("/sessions/a.jsonl", "sig-2", ["a", "a2"]);
    cache.set("/sessions/c.jsonl", "sig", ["c"]);

    expect(cache.get("/sessions/a.jsonl", "sig-2")).toEqual(["a", "a2"]);
    expect(cache.get("/sessions/b.jsonl", "sig")).toBeUndefined();
  });

  it("bounds growth at the default limit", () => {
    const cache = new TranscriptBranchCache();
    for (let i = 0; i < DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 5; i += 1) {
      cache.set(`/sessions/s${String(i)}.jsonl`, "sig", [i]);
    }

    expect(cache.get("/sessions/s0.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/s4.jsonl", "sig")).toBeUndefined();
    expect(cache.get("/sessions/s5.jsonl", "sig")).toEqual([5]);
    expect(cache.get(`/sessions/s${String(DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 4)}.jsonl`, "sig")).toEqual([DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT + 4]);
  });
});
