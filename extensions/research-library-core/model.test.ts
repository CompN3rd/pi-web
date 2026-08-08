import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResearchLibraryConfigText as parseBrowserConfig } from "../../pi-web-plugins/research-library/config.js";
import { parseResearchLibraryConfigText as parseRuntimeConfig } from "./model.js";

describe("research-library fixture contract", () => {
  it("keeps the browser and extension validators aligned on the shipped synthetic example", async () => {
    const text = await readFile(resolve("pi-web-plugins/research-library/example.synthetic.json"), "utf8");

    const browser = parseBrowserConfig(text);
    const runtime = parseRuntimeConfig(text);

    expect(browser).toEqual(runtime);
    expect(runtime).toMatchObject({ ok: true, config: { synthetic: true, libraryId: "synthetic-demo-library" } });
  });

  it("makes both trust boundaries reject unknown root fields", () => {
    const text = JSON.stringify({ version: 1, synthetic: true, libraryId: "synthetic-library", papers: [], extra: true });

    const runtime = parseRuntimeConfig(text);
    expect(parseBrowserConfig(text)).toEqual(runtime);
    expect(runtime.ok).toBe(false);
    if (runtime.ok) throw new Error("Runtime unexpectedly accepted unknown fields");
    expect(runtime.error).toContain("unknown fields");
  });
});
