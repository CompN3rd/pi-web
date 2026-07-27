import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiWebPluginCatalog, type PiPackageProvider } from "./piWebPluginCatalog.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-catalog-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiWebPluginCatalog", () => {
  it("describes browser-only metadata and desired config without changing source or scope", async () => {
    const pluginRoot = join(tempDir, "plugins", "browser-only");
    await writePlugin(pluginRoot, {
      packageJson: { piWeb: { plugins: [{ id: "browser-only", module: "dist/plugin.js" }] } },
      files: { "dist/plugin.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "project" }],
      packageProvider: false,
      configProvider: () => ({ plugins: { "browser-only": { enabled: false, settings: { color: "blue" } } } }),
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.diagnostics).toEqual([]);
    const [plugin] = snapshot.plugins;
    expect(plugin).toMatchObject({
      id: "browser-only",
      packageRoot: await realpath(pluginRoot),
      browserModule: {
        path: "dist/plugin.js",
        filePath: await realpath(join(pluginRoot, "dist/plugin.js")),
      },
      source: "fixture",
      scope: "project",
      machineSpecific: false,
      enabled: false,
      settings: { color: "blue" },
    });
    expect(plugin?.browserModule?.revision).toMatch(/^\d+$/u);
  });

  it("discovers server-only and dual-entry modules without executing them", async () => {
    const marker = "__piWebCatalogExecutedServerModule";
    Reflect.deleteProperty(globalThis, marker);
    await writePlugin(join(tempDir, "plugins", "server-only"), {
      packageJson: { piWeb: { plugins: [{ id: "server-only", serverModule: "server-plugin.js" }] } },
      files: { "server-plugin.js": `globalThis.${marker} = true; throw new Error("must not execute");` },
    });
    await writePlugin(join(tempDir, "plugins", "dual"), {
      packageJson: { piWeb: { plugins: [{ id: "dual", module: "browser.js", serverModule: "server.js" }] } },
      files: { "browser.js": "export default {};", "server.js": "throw new Error('must not execute');" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
    });

    const { plugins } = await catalog.snapshot();

    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    expect(plugins.map((plugin) => plugin.id)).toEqual(["dual", "server-only"]);
    expect(plugins[0]).toMatchObject({
      id: "dual",
      machineSpecific: true,
      browserModule: { path: "browser.js" },
      serverModule: { path: "server.js" },
    });
    expect(plugins[0]?.browserModule?.revision).toMatch(/^\d+$/u);
    expect(plugins[0]?.serverModule?.revision).toMatch(/^\d+$/u);
    expect(plugins[1]).toMatchObject({
      id: "server-only",
      machineSpecific: false,
      serverModule: { path: "server-plugin.js" },
    });
    expect(plugins[1]?.serverModule?.revision).toMatch(/^\d+$/u);
    expect(plugins[1]?.browserModule).toBeUndefined();
  });

  it("attributes unsafe, missing, empty, and incompatible declarations while keeping valid packages", async () => {
    const pluginsRoot = join(tempDir, "plugins");
    await writePlugin(join(pluginsRoot, "valid"), {
      packageJson: { piWeb: { plugins: [{ id: "valid", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(pluginsRoot, "empty"), {
      packageJson: { piWeb: { plugins: [{ id: "empty" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "missing"), {
      packageJson: { piWeb: { plugins: [{ id: "missing", serverModule: "missing.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "unsafe"), {
      packageJson: { piWeb: { plugins: [{ id: "unsafe", serverModule: "../escape.js" }] } },
      files: {},
    });
    await writePlugin(join(pluginsRoot, "dual-unscoped"), {
      packageJson: { piWeb: { plugins: [{ id: "dual-unscoped", module: "browser.js", serverModule: "server.js", machineSpecific: false }] } },
      files: { "browser.js": "export default {};", "server.js": "export default {};" },
    });
    const warnings: string[] = [];
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: pluginsRoot, source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: (message) => { warnings.push(message); },
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["valid"]);
    expect(snapshot.diagnostics).toHaveLength(4);
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("must declare module or serverModule"),
      expect.stringContaining("server module not found for missing"),
      expect.stringContaining("Unsafe PI WEB plugin server module path for unsafe"),
      expect.stringContaining("must be machine-specific"),
    ]));
    expect(snapshot.diagnostics.every((diagnostic) => diagnostic.source.startsWith(pluginsRoot))).toBe(true);
    expect(warnings).toEqual(snapshot.diagnostics.map((diagnostic) => `Skipping PI WEB plugin from ${diagnostic.source}: ${diagnostic.message}`));
  });

  it("uses one duplicate-id winner across browser and server capabilities", async () => {
    const firstRoot = join(tempDir, "first");
    const secondRoot = join(tempDir, "second");
    await writePlugin(join(firstRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", serverModule: "server.js" }] } },
      files: { "server.js": "export default {};" },
    });
    await writePlugin(join(secondRoot, "duplicate"), {
      packageJson: { piWeb: { plugins: [{ id: "duplicate", module: "browser.js" }] } },
      files: { "browser.js": "export default {};" },
    });
    const catalog = new PiWebPluginCatalog({
      roots: [
        { path: firstRoot, source: "first", scope: "bundled" },
        { path: secondRoot, source: "second", scope: "local" },
      ],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]).toMatchObject({ id: "duplicate", source: "first" });
    expect(snapshot.plugins[0]?.serverModule).toBeDefined();
    expect(snapshot.plugins[0]?.browserModule).toBeUndefined();
    expect(snapshot.diagnostics).toEqual([{ source: "second", message: "Duplicate PI WEB plugin id: duplicate" }]);
    await expect(catalog.browserPlugin("duplicate")).resolves.toBeUndefined();
  });

  it("preserves configured Pi-package source and scope for server entries", async () => {
    const packageRoot = join(tempDir, "package");
    await writePlugin(packageRoot, {
      packageJson: { piWeb: { plugins: [{ id: "package-provider", serverModule: "dist/server.js" }] } },
      files: { "dist/server.js": "export default {};" },
    });
    const packageProvider: PiPackageProvider = {
      listPackages: () => [{ source: "npm:@acme/provider", scope: "user", installedPath: packageRoot }],
      getInstalledPath: () => undefined,
    };
    const catalog = new PiWebPluginCatalog({ roots: [], packageProvider });

    await expect(catalog.snapshot()).resolves.toMatchObject({
      plugins: [{ id: "package-provider", source: "npm:@acme/provider", scope: "user", enabled: true }],
      diagnostics: [],
    });
  });

  it("rejects module symlinks that escape the plugin package", async () => {
    const pluginRoot = join(tempDir, "plugins", "escaped");
    const externalModule = join(tempDir, "outside.js");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(externalModule, "export default {};\n");
    await symlink(externalModule, join(pluginRoot, "server.js"));
    await writeFile(join(pluginRoot, "package.json"), `${JSON.stringify({ piWeb: { plugins: [{ id: "escaped", serverModule: "server.js" }] } }, null, 2)}\n`);
    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(tempDir, "plugins"), source: "fixture", scope: "local" }],
      packageProvider: false,
      warningSink: () => undefined,
    });

    const snapshot = await catalog.snapshot();

    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.message).toContain("escapes its package");
  });
});

async function writePlugin(root: string, options: { packageJson: unknown; files: Record<string, string> }): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify(options.packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(options.files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
}
