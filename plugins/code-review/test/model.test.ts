import { describe, expect, it } from "vitest";
import { anchorInSnapshot, ReviewStore, reviewMarkdown, snapshot, storagePrefix, workspaceKey, type Comment } from "../src/browser/model.js";

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const comment = (id: string): Comment => ({ id, path: "src/a.ts", source: "files", side: "new", start: 1, end: 2, hash: "a".repeat(64), body: "**Check** this\n\n```ts\na();\n```", createdAt: 1 });

describe("workspace review persistence", () => {
  it("isolates machines, projects and workspaces, and reads fresh data before each mutation", () => {
    const memory = storage(); const first = new ReviewStore(memory); const second = new ReviewStore(memory);
    first.add("one", comment("a")); second.add("one", comment("b")); first.add("two", comment("c"));
    expect(first.remove("one", "a").map((item) => item.id)).toEqual(["b"]);
    expect(second.load("two").map((item) => item.id)).toEqual(["c"]);
    const context = { machine: { id: "m", name: "M", kind: "local" as const }, workspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true } };
    const keys = [workspaceKey(context), workspaceKey({ ...context, machine: { ...context.machine, id: "other" } }), workspaceKey({ ...context, workspace: { ...context.workspace, projectId: "other" } }), workspaceKey({ ...context, workspace: { ...context.workspace, id: "other" } })];
    expect(new Set(keys).size).toBe(4);
  });
  it("preserves corrupt/unknown data and surfaces persistence failures", () => {
    const memory = storage(); const store = new ReviewStore(memory);
    memory.data.set(storagePrefix + "one", '{"version":99,"comments":[]}');
    expect(() => store.add("one", comment("a"))).toThrow("Unrecognized");
    expect(memory.getItem(storagePrefix + "one")).toContain('"version":99');
    const blocked = new ReviewStore({ ...memory, setItem: () => { throw new Error("quota"); } });
    expect(() => blocked.add("two", comment("b"))).toThrow("quota");
    expect(memory.getItem(storagePrefix + "two")).toBeNull();
  });
  it("refuses duplicate IDs, malformed coordinates, and resurrection of a deleted comment", () => {
    const store = new ReviewStore(storage()); store.add("one", comment("a"));
    expect(() => store.add("one", comment("a"))).toThrow("Duplicate");
    expect(() => store.add("one", { ...comment("b"), end: 0 })).toThrow("Invalid");
    store.remove("one", "a");
    expect(() => store.update("one", comment("a"))).toThrow("removed");
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
