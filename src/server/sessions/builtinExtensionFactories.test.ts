import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.resetModules();
});

async function loadFactories(sdkExports: Record<string, unknown> = {}) {
  // Undefined exports model older SDK namespaces; non-function values model
  // the untyped runtime boundary independently of our development SDK types.
  vi.doMock("@earendil-works/pi-coding-agent", () => ({
    createMcpExtension: undefined,
    createCodemodeExtension: undefined,
    createToolSearchExtension: undefined,
    ...sdkExports,
  }));
  return (await import("./builtinExtensionFactories.js")).getBuiltinExtensionFactories;
}

function builtinCreators() {
  const mcp: ExtensionFactory = () => undefined;
  const codemode: ExtensionFactory = () => undefined;
  const toolSearch: ExtensionFactory = () => undefined;
  return {
    factories: { mcp, codemode, toolSearch },
    exports: {
      createMcpExtension: vi.fn(() => mcp),
      createCodemodeExtension: vi.fn(() => codemode),
      createToolSearchExtension: vi.fn(() => toolSearch),
    },
  };
}

describe("getBuiltinExtensionFactories", () => {
  it("registers the available builtins as named, replaceable extensions", async () => {
    const { factories, exports } = builtinCreators();
    const getFactories = await loadFactories(exports);

    expect(await getFactories()).toEqual([
      { name: "mcp", factory: factories.mcp, builtin: true, replaceable: true },
      { name: "codemode", factory: factories.codemode, builtin: true, replaceable: true },
      { name: "tool-search", factory: factories.toolSearch, builtin: true, replaceable: true },
    ]);
  });

  it("creates factories once for concurrent and subsequent callers", async () => {
    const { exports } = builtinCreators();
    const getFactories = await loadFactories(exports);

    const [first, concurrent] = await Promise.all([getFactories(), getFactories()]);
    expect(concurrent).toBe(first);
    expect(await getFactories()).toBe(first);
    for (const create of Object.values(exports)) {
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("returns an empty array when an older SDK has no builtin exports", async () => {
    const getFactories = await loadFactories();
    expect(await getFactories()).toEqual([]);
  });

  it("ignores non-function exports", async () => {
    const getFactories = await loadFactories({
      createMcpExtension: null,
      createCodemodeExtension: {},
      createToolSearchExtension: "not a factory",
    });
    expect(await getFactories()).toEqual([]);
  });

  it("registers supported builtins independently when only some exports exist", async () => {
    const { factories, exports } = builtinCreators();
    const getFactories = await loadFactories({ createMcpExtension: exports.createMcpExtension });

    expect(await getFactories()).toEqual([
      { name: "mcp", factory: factories.mcp, builtin: true, replaceable: true },
    ]);
  });

  it("propagates factory initialization errors instead of silently disabling builtins", async () => {
    const error = new Error("MCP factory initialization failed");
    const getFactories = await loadFactories({
      createMcpExtension: () => { throw error; },
    });
    await expect(getFactories()).rejects.toBe(error);
  });
});
