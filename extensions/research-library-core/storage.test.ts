import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonExclusive } from "./storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("research-library runtime storage", () => {
  it("publishes exactly one complete value under concurrent exclusive writers", async () => {
    const root = await tempRoot();
    const results = await Promise.all(Array.from({ length: 12 }, (_value, index) =>
      writeJsonExclusive(root, [".pi-web", "research-library-runtime", "claims"], "token.json", { writer: index })));

    expect(results.filter(Boolean)).toHaveLength(1);
    const stored: unknown = JSON.parse(await readFile(join(root, ".pi-web", "research-library-runtime", "claims", "token.json"), "utf8"));
    if (!isRecord(stored) || typeof stored["writer"] !== "number") throw new Error("Stored exclusive value is malformed");
    expect(stored["writer"]).toBe(results.findIndex(Boolean));
    expect((await readdir(join(root, ".pi-web", "research-library-runtime", "claims"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("allows a symlinked runtime ancestor only when it resolves inside the workspace", async () => {
    const root = await tempRoot();
    const internal = join(root, "internal-pi-web");
    await mkdir(internal);
    await symlink(internal, join(root, ".pi-web"), "junction");

    await expect(writeJsonExclusive(root, [".pi-web", "research-library-runtime", "claims"], "token.json", { safe: true })).resolves.toBe(true);
    await expect(readFile(join(internal, "research-library-runtime", "claims", "token.json"), "utf8")).resolves.toContain("\"safe\":true");
  });

  it("rejects a symlinked runtime ancestor that escapes the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(join(root, ".pi-web"), { recursive: true });
    await symlink(outside, join(root, ".pi-web", "research-library-runtime"), "junction");

    await expect(writeJsonExclusive(root, [".pi-web", "research-library-runtime", "claims"], "token.json", { safe: false })).rejects.toThrow("escapes the workspace");
    await expect(readFile(join(outside, "claims", "token.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-research-storage-"));
  roots.push(root);
  return root;
}
