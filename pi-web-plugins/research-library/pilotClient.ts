import type { ResearchLibraryFileContent, ResearchLibraryFileReader } from "./researchLibraryClient.js";
import { sha256Hex } from "./researchLibraryClient.js";
import {
  MAX_RESEARCH_LIBRARY_PILOT_BYTES,
  parseLocalPilotConfigText,
  RESEARCH_LIBRARY_PILOT_CONFIG_PATH,
  type LocalResearchLibraryPilotConfig,
} from "./pilotConfig.js";

const missingWorkspaceFileError = "Path does not exist";

export interface LoadedLocalResearchLibraryPilot {
  config: LocalResearchLibraryPilotConfig;
  sha256: string;
}

export type LocalPilotLoadResult =
  | { kind: "loaded"; pilot: LoadedLocalResearchLibraryPilot }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

export async function loadLocalResearchLibraryPilot(files: ResearchLibraryFileReader): Promise<LocalPilotLoadResult> {
  let file: ResearchLibraryFileContent;
  try {
    file = await files.readFile(RESEARCH_LIBRARY_PILOT_CONFIG_PATH);
  } catch (error) {
    if (error instanceof Error && error.message === missingWorkspaceFileError) return { kind: "missing" };
    return { kind: "unavailable", error: `Unable to read ${RESEARCH_LIBRARY_PILOT_CONFIG_PATH}: ${formatUnknownError(error)}` };
  }

  if (file.binary) return { kind: "unavailable", error: `${RESEARCH_LIBRARY_PILOT_CONFIG_PATH} must be UTF-8 text` };
  if (file.truncated || file.size > MAX_RESEARCH_LIBRARY_PILOT_BYTES) {
    return { kind: "unavailable", error: `${RESEARCH_LIBRARY_PILOT_CONFIG_PATH} exceeds ${String(MAX_RESEARCH_LIBRARY_PILOT_BYTES)} bytes` };
  }
  const parsed = parseLocalPilotConfigText(file.content);
  if (!parsed.ok) return { kind: "unavailable", error: parsed.error };
  return { kind: "loaded", pilot: { config: parsed.config, sha256: await sha256Hex(file.content) } };
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
