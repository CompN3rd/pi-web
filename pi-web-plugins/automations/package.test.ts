import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected package metadata object");
  return Object.fromEntries(Object.entries(value));
}

describe("bundled Automations package metadata", () => {
  it("declares a machine-specific paired browser/server plugin and scoped runtime dependencies", async () => {
    const metadata: unknown = JSON.parse(await readFile("pi-web-plugins/automations/package.json", "utf8"));
    const packageRecord = record(metadata);
    expect(packageRecord["private"]).toBe(true);
    expect(packageRecord["type"]).toBe("module");
    expect(record(packageRecord["dependencies"])).toMatchObject({ "better-sqlite3": "^13.0.3", croner: "^10.0.1" });
    expect(record(packageRecord["piWeb"])["plugins"]).toEqual([{
      id: "automations",
      browserRoot: "browser",
      module: "browser/pi-web-plugin.js",
      serverModule: "server-plugin.js",
      machineSpecific: true,
    }]);
  });
});
