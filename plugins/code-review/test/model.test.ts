import { describe, expect, it } from "vitest";
import { reviewStorage } from "./storageSupport.js";
import { anchorInSnapshot, ReviewStore, reviewMarkdown, snapshot, storagePrefix, workspaceKey, type Comment } from "../src/browser/model.js";

const comment = (id: string): Comment => ({ id, path: "src/a.ts", source: "files", side: "new", start: 1, end: 2, hash: "a".repeat(64), body: "**Check** this\n\n```ts\na();\n```", createdAt: 1 });

describe("workspace review persistence (prepared; release verification pending)", () => {
  it("serializes concurrent tabs through separate connections without losing comments", async () => {
    const first = reviewStorage(); const second = reviewStorage(first.factory);
    await Promise.all([first.store.add("one", comment("a")), second.store.add("one", comment("b"))]);
    expect((await first.store.load("one")).map((item) => item.id).sort()).toEqual(["a", "b"]);
    await Promise.all([first.store.update("one", { ...comment("a"), body: "edited" }), second.store.remove("one", "b")]);
    expect(await second.store.load("one")).toEqual([{ ...comment("a"), body: "edited" }]);
    await first.store.add("two", comment("c"));
    expect(await second.store.load("two")).toEqual([comment("c")]);
    const context = { machine: { id: "m", name: "M", kind: "local" as const }, workspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true } };
    const keys = [workspaceKey(context), workspaceKey({ ...context, machine: { ...context.machine, id: "other" } }), workspaceKey({ ...context, workspace: { ...context.workspace, projectId: "other" } }), workspaceKey({ ...context, workspace: { ...context.workspace, id: "other" } })];
    expect(new Set(keys).size).toBe(4);
  });
  it("migrates once atomically, retains backup, and never reimports after acknowledgement", async () => {
    const first = reviewStorage(); const second = reviewStorage(first.factory);
    const backup = JSON.stringify({ version: 1, comments: [comment("a")] });
    first.legacyData.set(storagePrefix + "one", backup);
    second.legacyData.set(storagePrefix + "one", backup);
    await Promise.all([first.store.load("one"), second.store.load("one")]);
    expect(await first.store.load("one")).toEqual([comment("a")]);
    await first.store.removeUnchanged("one", [comment("a")]);
    expect(await second.store.load("one")).toEqual([]);
    expect(first.legacy.getItem(storagePrefix + "one")).toBe(backup);
    expect(second.legacy.getItem(storagePrefix + "one")).toBe(backup);
  });
  it("lets existing IDB data win over corrupt legacy data, including empty records", async () => {
    const { store, legacyData } = reviewStorage();
    await store.add("one", comment("a")); await store.load("empty");
    legacyData.set(storagePrefix + "one", "broken"); legacyData.set(storagePrefix + "empty", "broken");
    expect(await store.load("one")).toEqual([comment("a")]);
    expect(await store.load("empty")).toEqual([]);
  });
  it.each(['{"version":99,"comments":[]}', '{"version":1,"comments":[{}]}', "broken"])("reports corrupt migration and permits retry without a marker: %s", async (raw) => {
    const { store, legacyData } = reviewStorage();
    legacyData.set(storagePrefix + "one", raw);
    await expect(store.load("one")).rejects.toThrow();
    expect(legacyData.get(storagePrefix + "one")).toBe(raw);
    legacyData.set(storagePrefix + "one", JSON.stringify({ version: 1, comments: [comment("a")] }));
    expect(await store.load("one")).toEqual([comment("a")]);
  });
  it("reports inaccessible legacy storage without committing an empty migration", async () => {
    const { storage, store } = reviewStorage();
    const blocked = new ReviewStore(storage, { getItem: () => { throw new Error("blocked"); } });
    await expect(blocked.load("one")).rejects.toThrow("blocked");
    await store.add("one", comment("a"));
    expect(await blocked.load("one")).toEqual([comment("a")]);
  });
  it("refuses duplicate IDs, malformed coordinates, and resurrection of a deleted comment", async () => {
    const { store } = reviewStorage(); await store.add("one", comment("a"));
    await expect(store.add("one", comment("a"))).rejects.toThrow("Duplicate");
    await expect(store.add("one", { ...comment("b"), end: 0 })).rejects.toThrow("Invalid");
    expect(await store.load("one")).toEqual([comment("a")]);
    await store.remove("one", "a");
    await expect(store.update("one", comment("a"))).rejects.toThrow("removed");
  });
});

describe("review source coordinates", () => {
  it("keeps staged, unstaged, old/new and file snapshots distinct", () => {
    const text = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@\n old\n-gone\n+new\n\\ No newline at end of file\n";
    const view = snapshot("a", "git-staged", text);
    expect(view.rows.filter((row) => row.line !== undefined)).toEqual([
      { text: " old", kind: "context", side: "new", line: 2 },
      { text: "-gone", kind: "remove", side: "old", line: 3 },
      { text: "+new", kind: "add", side: "new", line: 3 },
    ]);
    const anchor = { path: "a", source: "git-staged" as const, side: "new" as const, start: 2, end: 3 };
    expect(anchorInSnapshot(anchor, view)).toBe(true);
    expect(anchorInSnapshot({ ...anchor, source: "git-unstaged" }, view)).toBe(false);
    expect(anchorInSnapshot({ ...anchor, side: "old" }, view)).toBe(false);
    expect(snapshot("a", "files", "one\r\ntwo\n").rows.map((row) => row.line)).toEqual([1, 2]);
    expect(snapshot("a", "files", "new\n").hash).not.toBe(view.hash);
  });
  it("does not attach metadata, binary diffs, or omitted hunk lines to comments", () => {
    const view = snapshot("a", "git-unstaged", "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n c\n");
    const anchor = { path: "a", source: "git-unstaged" as const, side: "new" as const, start: 1, end: 10 };
    expect(anchorInSnapshot(anchor, view)).toBe(false);
    expect(anchorInSnapshot({ ...anchor, end: Number.MAX_SAFE_INTEGER }, view)).toBe(false);
    const binary = snapshot("a", "git-staged", "Binary files a/a and b/a differ\n");
    expect(binary.rows.every((row) => row.line === undefined)).toBe(true);
  });
  it("rejects huge line counts instead of creating an unbounded DOM", () => {
    expect(() => snapshot("a", "files", "x\n".repeat(5_001))).toThrow("too many lines");
  });
  it("preserves independent Markdown blocks and identifies deleted coordinates", () => {
    const markdown = reviewMarkdown([comment("a"), { ...comment("b"), path: "other[1].ts", source: "git-staged", side: "old" }]);
    expect(markdown).toContain("### Code review comments (2)");
    expect(markdown).toContain("Git staged, deleted");
    expect(markdown).toContain("other\\[1\\].ts");
    expect(markdown).toContain("\n\n```ts\na();\n```\n\n*-- end of C");
    expect(reviewMarkdown([])).toBe("");
  });
});
