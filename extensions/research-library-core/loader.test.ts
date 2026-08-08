import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installed-shape research-library extension discovery", () => {
  it("loads the raw entry and helper imports from the package extensions directory", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-extension-loader-"));
    tempDirs.push(agentDir);

    const result = await discoverAndLoadExtensions([resolve("extensions")], process.cwd(), agentDir);

    expect(result.errors).toEqual([]);
    const researchExtension = result.extensions.find((extension) => extension.resolvedPath.endsWith("research-library.ts"));
    expect(researchExtension).toBeDefined();
    expect(researchExtension?.commands.has("research-library")).toBe(true);
    expect(result.extensions.some((extension) => extension.resolvedPath.includes("research-library-core"))).toBe(false);
  });
});
