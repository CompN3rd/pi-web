import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getBuiltinExtensionFactories } from "./builtinExtensionFactories.js";

// Verify that the builtin extension factories wired through piWebResourceLoaderOptions
// actually load built-in extensions (e.g. /mcp command present) in the resource loader.
describe("builtin extension factories load through DefaultResourceLoader", () => {
  let directory: string;

  it("loads mcp, codemode, and tool-search builtins when factories are provided", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-builtin-integration-"));
    try {
      // Create an empty mcp.json so MCP servers don't try to connect to the network.
      await writeFile(join(directory, "mcp.json"), JSON.stringify({ servers: {} }), "utf-8");

      const factories = await getBuiltinExtensionFactories();
      expect(factories).toHaveLength(3);

      const eventBus = createEventBus();
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        eventBus,
        extensionFactories: factories,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });

      await loader.reload();

      // The loader should have resolved builtin extension paths.
      const extensionsResult = loader.getExtensions();
      const builtinPaths = extensionsResult.extensions
        .map((ext) => ext.path)
        .filter((p) => p.startsWith("builtin:"));

      expect(builtinPaths).toContain("builtin:mcp");
      expect(builtinPaths).toContain("builtin:codemode");
      expect(builtinPaths).toContain("builtin:tool-search");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns [] when no factories are provided", async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-web-builtin-empty-"));
    try {
      const factories: import("@earendil-works/pi-coding-agent").InlineExtension[] = [];
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        extensionFactories: factories,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });

      await loader.reload();
      // No builtin paths should be loaded when no factories exist.
      const extensionsResult = loader.getExtensions();
      const builtinPaths = extensionsResult.extensions
        .map((ext) => ext.path)
        .filter((p) => p.startsWith("builtin:"));
      expect(builtinPaths).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
