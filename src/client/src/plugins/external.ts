import type { PiWebPlugin, PiWebPluginRegistration } from "./types";

interface PluginManifestEntry {
  id: string;
  module: string;
}

interface PluginManifest {
  plugins: PluginManifestEntry[];
}

interface PluginRegistryTarget {
  register(registration: PiWebPluginRegistration): void;
  replace(registration: PiWebPluginRegistration): void;
  unregister(id: string): void;
}

interface ExternalPluginDependencies {
  fetchManifest: (url: string) => Promise<PluginManifest | undefined>;
  importModule: (url: string) => Promise<unknown>;
  baseUrl: () => string;
  revision: () => string;
  warn: (message: string, error: unknown) => void;
}

// Cache-busting only: a counter also keeps same-millisecond refreshes distinct on HTTP.
let reloadRevision = 0;

/** Owns only external registrations; concurrent refresh requests share one reload. */
export class ExternalPluginLoader {
  private readonly ids = new Set<string>();
  private pending: Promise<void> | undefined;

  constructor(
    private readonly registry: PluginRegistryTarget,
    private readonly dependencies: ExternalPluginDependencies = {
      fetchManifest: fetchPluginManifest,
      importModule: (url): Promise<unknown> => import(/* @vite-ignore */ url),
      baseUrl: () => window.location.href,
      revision: () => `${String(Date.now())}-${String(++reloadRevision)}`,
      warn: (message, error) => { console.warn(message, error); },
    },
  ) {}

  reload(manifestUrl = "/pi-web-plugins/manifest.json"): Promise<void> {
    this.pending ??= this.load(manifestUrl).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(manifestUrl: string): Promise<void> {
    const manifest = await this.dependencies.fetchManifest(manifestUrl);
    // A missing endpoint is not an authoritative empty manifest.
    if (manifest === undefined) return;
    const entries = manifest.plugins;
    const desiredIds = new Set(entries.map((entry) => entry.id));
    if (desiredIds.size !== entries.length) throw new Error("Duplicate plugin manifest id");
    const revision = this.dependencies.revision();
    for (const entry of entries) {
      try {
        const moduleUrl = new URL(entry.module, new URL(manifestUrl, this.dependencies.baseUrl()));
        moduleUrl.searchParams.set("pi-web-reload", revision);
        const module = await this.dependencies.importModule(moduleUrl.toString());
        const registration = { id: entry.id, plugin: parsePluginModule(module, moduleUrl.toString()) };
        // Register first so an external manifest cannot overwrite a built-in plugin.
        if (this.ids.has(entry.id)) this.registry.replace(registration);
        else this.registry.register(registration);
        this.ids.add(entry.id);
      } catch (error) {
        this.dependencies.warn(`Failed to reload PI WEB plugin ${entry.id} (${entry.module}); keeping any previous activation`, error);
      }
    }
    for (const id of this.ids) {
      if (desiredIds.has(id)) continue;
      this.registry.unregister(id);
      this.ids.delete(id);
    }
  }
}

async function fetchPluginManifest(manifestUrl: string): Promise<PluginManifest | undefined> {
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Failed to load plugin manifest: ${response.statusText}`);
  return parseManifest(await response.json());
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid plugin manifest");
  return {
    plugins: value["plugins"].map((entry) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "" || typeof entry["module"] !== "string" || entry["module"] === "") throw new Error("Invalid plugin manifest entry");
      return { id: entry["id"], module: entry["module"] };
    }),
  };
}

function parsePluginModule(module: unknown, moduleUrl: string): PiWebPlugin {
  if (!isRecord(module)) throw new Error(`Plugin module ${moduleUrl} did not export an object`);
  const plugin = module["default"];
  if (!isPiWebPlugin(plugin)) throw new Error(`Plugin module ${moduleUrl} default export is not a PiWebPlugin`);
  return plugin;
}

function isPiWebPlugin(value: unknown): value is PiWebPlugin {
  return isRecord(value) && value["apiVersion"] === 1 && typeof value["name"] === "string" && typeof value["activate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
