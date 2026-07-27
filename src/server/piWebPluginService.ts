import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope } from "../shared/apiTypes.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";
import {
  PiWebPluginCatalog,
  type PiWebPluginCatalogEntry,
  type PiWebPluginCatalogOptions,
} from "./piWebPluginCatalog.js";

export type { PiWebPluginInfo, PiWebPluginsResponse, PiWebPluginScope } from "../shared/apiTypes.js";
export {
  DefaultPiPackageProvider,
  PiWebPluginCatalog,
  type ConfiguredPiPackage,
  type LocalPluginRoot,
  type PiPackageProvider,
  type PiWebPluginCatalogDiagnostic,
  type PiWebPluginCatalogEntry,
  type PiWebPluginCatalogModule,
  type PiWebPluginCatalogOptions,
  type PiWebPluginCatalogSnapshot,
  type PiWebPluginPackageEntry,
} from "./piWebPluginCatalog.js";

export interface PiWebPluginManifest {
  plugins: PiWebPluginManifestEntry[];
}

export interface PiWebPluginManifestEntry {
  id: string;
  module: string;
  source: string;
  scope: PiWebPluginScope;
  machineSpecific: boolean;
}

export interface PiWebPluginServiceOptions extends PiWebPluginCatalogOptions {
  catalog?: PiWebPluginCatalog;
}

/** Browser manifest and asset adapter over the process-neutral package catalog. */
export class PiWebPluginService {
  private readonly catalog: PiWebPluginCatalog;

  constructor(options: PiWebPluginServiceOptions = {}) {
    this.catalog = options.catalog ?? new PiWebPluginCatalog(options);
  }

  async manifest(): Promise<PiWebPluginManifest> {
    const { plugins } = await this.catalog.snapshot();
    return {
      plugins: plugins.flatMap((plugin) => {
        if (!plugin.enabled || plugin.browserModule === undefined) return [];
        return [{
          id: plugin.id,
          module: browserModuleUrl(plugin),
          source: plugin.source,
          scope: plugin.scope,
          machineSpecific: plugin.machineSpecific,
        }];
      }),
    };
  }

  async plugins(): Promise<PiWebPluginsResponse> {
    const { plugins } = await this.catalog.snapshot();
    return { plugins: plugins.map(pluginInfo) };
  }

  async readAsset(pluginId: string, assetPath: string): Promise<{ content: Buffer; contentType: string } | undefined> {
    if (!isPiWebPluginId(pluginId)) return undefined;
    const plugin = await this.catalog.browserPlugin(pluginId);
    if (plugin === undefined) return undefined;

    const resolved = resolve(plugin.packageRoot, assetPath);
    const [realRoot, realAsset] = await Promise.all([
      realpath(plugin.packageRoot),
      realpath(resolved).catch(() => undefined),
    ]);
    if (realAsset === undefined || !isWithin(realRoot, realAsset)) return undefined;

    const assetStat = await stat(realAsset).catch(() => undefined);
    if (assetStat?.isFile() !== true) return undefined;

    return { content: await readFile(realAsset), contentType: contentTypeFor(realAsset) };
  }
}

function pluginInfo(plugin: PiWebPluginCatalogEntry): PiWebPluginInfo {
  return {
    id: plugin.id,
    ...(plugin.browserModule === undefined ? {} : { module: browserModuleUrl(plugin) }),
    source: plugin.source,
    scope: plugin.scope,
    machineSpecific: plugin.machineSpecific,
    enabled: plugin.enabled,
  };
}

function browserModuleUrl(plugin: PiWebPluginCatalogEntry): string {
  const browserModule = plugin.browserModule;
  if (browserModule === undefined) throw new Error(`PI WEB plugin has no browser module: ${plugin.id}`);
  const path = browserModule.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `/pi-web-plugins/${encodeURIComponent(plugin.id)}/${path}?${pluginModuleQuery(plugin.id, browserModule.revision)}`;
}

function pluginModuleQuery(pluginId: string, revision: string): string {
  const params = new URLSearchParams({ v: revision });
  const dockerMode = pluginId === "updates" ? dockerModeFromEnv() : undefined;
  if (dockerMode !== undefined) params.set("piWebDockerMode", dockerMode);
  return params.toString();
}

function dockerModeFromEnv(): "runtime" | "dev" | undefined {
  if (!isTruthyEnv("PI_WEB_DOCKER_RUNTIME")) return undefined;
  const mode = process.env["PI_WEB_DOCKER_MODE"];
  if (mode === "runtime" || mode === "dev") return mode;
  if (firstNonEmptyEnv("PI_WEB_DOCKER_DEV_REPO_ROOT") !== undefined) return "dev";
  if (firstNonEmptyEnv("PI_WEB_DOCKER_INSTALL_DIR") !== undefined) return "runtime";
  return undefined;
}

function firstNonEmptyEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function isTruthyEnv(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function contentTypeFor(path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (lowerPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
