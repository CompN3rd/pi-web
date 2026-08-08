import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadResearchLibraryFixture, prepareResearchDispatch } from "../../pi-web-plugins/research-library/researchLibraryClient.js";
import { getResearchContext } from "./core.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("browser plugin to Pi extension contract", () => {
  it("round-trips a plugin-created opaque intent without placing context in the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-browser-extension-contract-"));
    roots.push(root);
    const internalState = join(root, "internal-state");
    await mkdir(internalState);
    await symlink(internalState, join(root, ".pi-web"), "junction");
    const configPath = join(root, ".pi-web", "research-library.synthetic.json");
    const text = await readFile("pi-web-plugins/research-library/example.synthetic.json", "utf8");
    await writeFile(configPath, text);
    const loaded = await loadResearchLibraryFixture({
      readFile: () => Promise.resolve({ content: text, size: Buffer.byteLength(text), truncated: false, binary: false }),
    });
    if (loaded.kind !== "loaded") throw new Error("example fixture did not load");

    let prompt = "";
    const now = new Date("2026-08-08T08:00:00.000Z");
    const dispatch = await prepareResearchDispatch({
      fixture: loaded.fixture,
      paperId: "synthetic-paper-alpha",
      passageId: "synthetic-passage-alpha",
      scopeKind: "current-paper",
    }, {
      files: {
        async writeFile(path, content, options) {
          expect(options).toEqual({ createDirs: true, overwrite: false });
          const target = join(root, ...path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, { flag: "wx" });
        },
      },
      prompt: {
        getText: () => prompt,
        insertText: (value) => { prompt += value; },
      },
      now: () => now,
      randomBytes: (target) => target.fill(9),
    });

    expect(prompt).toBe(dispatch.token);
    expect(prompt).not.toContain("Citation edges are useful");
    const context = await getResearchContext(root, "session-contract", dispatch.token, now);
    expect(context).toMatchObject({
      synthetic: true,
      paper: { id: "synthetic-paper-alpha" },
      passage: { id: "synthetic-passage-alpha" },
      searchScope: { kind: "current-paper", paperIds: ["synthetic-paper-alpha"] },
    });
  });
});
