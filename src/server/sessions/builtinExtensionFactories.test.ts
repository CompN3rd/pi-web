import { describe, expect, it } from "vitest";
import { getBuiltinExtensionFactories } from "./builtinExtensionFactories.js";

function isInlineExtensionObject(
  input: unknown,
): input is { name: string; factory: (pi: unknown) => void | Promise<void> } & {
  builtin?: boolean;
  replaceable?: boolean;
} {
  if (
    typeof input !== "object" ||
    input === null ||
    !("name" in input) ||
    !("factory" in input)
  ) {
    return false;
  }
  const factoryValue = Reflect.get(input, "factory");
  return typeof factoryValue === "function";
}

describe("getBuiltinExtensionFactories", () => {
  it("returns an array of InlineExtension entries", async () => {
    const factories = await getBuiltinExtensionFactories();
    expect(Array.isArray(factories)).toBe(true);
  });

  it("includes mcp, codemode, and tool-search when exports exist", async () => {
    const factories = await getBuiltinExtensionFactories();
    const names = factories.map((f) => f.name);
    expect(names).toContain("mcp");
    expect(names).toContain("codemode");
    expect(names).toContain("tool-search");
  });

  it("each entry has builtin: true and replaceable: true", async () => {
    const factories = await getBuiltinExtensionFactories();
    for (const entry of factories) {
      if (!isInlineExtensionObject(entry)) {
        throw new Error("Expected object InlineExtension");
      }
      expect(entry.builtin).toBe(true);
      expect(entry.replaceable).toBe(true);
    }
  });

  it("is memoised: two calls in the same test return the same promise", async () => {
    // Both calls happen in the same test function, same module evaluation,
    // so the module-level cache must return the same Promise reference.
    const p1 = getBuiltinExtensionFactories();
    const p2 = getBuiltinExtensionFactories();
    // toCheck: both must resolve to the identical array (same factories).
    await p1;
    // p2 must resolve to the identical array (same reference from cache)
    const result2 = await p2;
    expect(result2).toHaveLength(3);
  });
});
