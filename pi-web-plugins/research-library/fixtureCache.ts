import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { loadResearchLibraryFixture, type ResearchLibraryFixtureLoadResult } from "./researchLibraryClient.js";

export type ResearchLibraryFixtureState = { kind: "loading" } | ResearchLibraryFixtureLoadResult;

const fixtureCache = new Map<string, ResearchLibraryFixtureState>();
const fixtureLoadVersions = new Map<string, number>();
let nextLoadVersion = 0;

export function researchLibraryPanelVisible(context: WorkspacePanelContext): boolean {
  const state = getOrLoadResearchLibraryFixture(context);
  return state.kind === "loaded" || state.kind === "unavailable";
}

export function getOrLoadResearchLibraryFixture(context: WorkspacePanelContext): ResearchLibraryFixtureState {
  const key = fixtureCacheKey(context);
  const cached = fixtureCache.get(key);
  if (cached !== undefined) return cached;

  fixtureCache.set(key, { kind: "loading" });
  const version = beginLoad(key);
  void loadAndCache(context, key, version);
  return { kind: "loading" };
}

export async function refreshResearchLibraryFixture(context: WorkspacePanelContext): Promise<ResearchLibraryFixtureState> {
  const key = fixtureCacheKey(context);
  fixtureCache.set(key, { kind: "loading" });
  const version = beginLoad(key);
  context.host.requestRender();
  return loadAndCache(context, key, version);
}

export function clearResearchLibraryFixtureCache(): void {
  nextLoadVersion += 1;
  fixtureCache.clear();
  fixtureLoadVersions.clear();
}

async function loadAndCache(context: WorkspacePanelContext, key: string, version: number): Promise<ResearchLibraryFixtureState> {
  const state = await loadResearchLibraryFixture(context.files).catch((error: unknown): ResearchLibraryFixtureState => ({
    kind: "unavailable",
    error: error instanceof Error ? error.message : String(error),
  }));
  if (fixtureLoadVersions.get(key) !== version) return fixtureCache.get(key) ?? state;
  fixtureCache.set(key, state);
  context.host.requestRender();
  return state;
}

function beginLoad(key: string): number {
  const version = ++nextLoadVersion;
  fixtureLoadVersions.set(key, version);
  return version;
}

function fixtureCacheKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}
