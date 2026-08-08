import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { loadResearchLibrarySource, type ResearchLibrarySourceLoadResult } from "./researchLibrarySourceClient.js";

export type ResearchLibrarySourceState = { kind: "loading" } | ResearchLibrarySourceLoadResult;

const sourceCache = new Map<string, ResearchLibrarySourceState>();
const sourceLoadVersions = new Map<string, number>();
let nextLoadVersion = 0;

export function researchLibraryPanelVisible(context: WorkspacePanelContext): boolean {
  const state = getOrLoadResearchLibrarySource(context);
  return state.kind === "loaded" || state.kind === "unavailable";
}

export function getOrLoadResearchLibrarySource(context: WorkspacePanelContext): ResearchLibrarySourceState {
  const key = sourceCacheKey(context);
  const cached = sourceCache.get(key);
  if (cached !== undefined) return cached;

  sourceCache.set(key, { kind: "loading" });
  const version = beginLoad(key);
  void loadAndCache(context, key, version);
  return { kind: "loading" };
}

export async function refreshResearchLibrarySource(context: WorkspacePanelContext): Promise<ResearchLibrarySourceState> {
  const key = sourceCacheKey(context);
  sourceCache.set(key, { kind: "loading" });
  const version = beginLoad(key);
  context.host.requestRender();
  return loadAndCache(context, key, version);
}

export function clearResearchLibraryFixtureCache(): void {
  nextLoadVersion += 1;
  sourceCache.clear();
  sourceLoadVersions.clear();
}

async function loadAndCache(context: WorkspacePanelContext, key: string, version: number): Promise<ResearchLibrarySourceState> {
  const state = await loadResearchLibrarySource(context.files).catch((error: unknown): ResearchLibrarySourceState => ({
    kind: "unavailable",
    error: error instanceof Error ? error.message : String(error),
  }));
  if (sourceLoadVersions.get(key) !== version) return sourceCache.get(key) ?? state;
  sourceCache.set(key, state);
  context.host.requestRender();
  return state;
}

function beginLoad(key: string): number {
  const version = ++nextLoadVersion;
  sourceLoadVersions.set(key, version);
  return version;
}

function sourceCacheKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}
