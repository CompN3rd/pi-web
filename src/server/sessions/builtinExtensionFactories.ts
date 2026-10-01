import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Lazily resolve built-in extension factories from the pi coding-agent package.
 *
 * When the installed version supports `createMcpExtension`,
 * `createCodemodeExtension`, and `createToolSearchExtension` (0.99+), the
 * factories are returned so the session resource loader can wire up the
 * built-in `/mcp`, `codemode`, and `tool_search` commands. When those exports
 * do not exist (older versions), `[]` is returned — degradation to the
 * previous behaviour with no built-in extensions loaded.
 *
 * Memoised: the factory lookup runs once; all callers get the same result.
 */
let cachedPromise: Promise<InlineExtension[]> | undefined;

export async function getBuiltinExtensionFactories(): Promise<InlineExtension[]> {
  cachedPromise ??= resolveBuiltinFactories();
  return cachedPromise;
}

async function resolveBuiltinFactories(): Promise<InlineExtension[]> {
  const pkg = await import("@earendil-works/pi-coding-agent");

  const factories: InlineExtension[] = [];

  if (typeof pkg.createMcpExtension === "function") {
    factories.push({
      name: "mcp",
      factory: pkg.createMcpExtension(),
      builtin: true,
      replaceable: true,
    });
  }

  if (typeof pkg.createCodemodeExtension === "function") {
    factories.push({
      name: "codemode",
      factory: pkg.createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    });
  }

  if (typeof pkg.createToolSearchExtension === "function") {
    factories.push({
      name: "tool-search",
      factory: pkg.createToolSearchExtension(),
      builtin: true,
      replaceable: true,
    });
  }

  return factories;
}
