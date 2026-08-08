import { RESEARCH_LIBRARY_CONFIG_PATH } from "./config.js";
import { loadLocalResearchLibraryPilot, type LoadedLocalResearchLibraryPilot } from "./pilotClient.js";
import { RESEARCH_LIBRARY_PILOT_CONFIG_PATH } from "./pilotConfig.js";
import { loadResearchLibraryFixture, type LoadedResearchLibraryFixture, type ResearchLibraryFileReader } from "./researchLibraryClient.js";

export type LoadedResearchLibrarySource =
  | { mode: "synthetic"; fixture: LoadedResearchLibraryFixture }
  | { mode: "local-pilot"; pilot: LoadedLocalResearchLibraryPilot };

export type ResearchLibrarySourceLoadResult =
  | { kind: "loaded"; source: LoadedResearchLibrarySource }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

export async function loadResearchLibrarySource(files: ResearchLibraryFileReader): Promise<ResearchLibrarySourceLoadResult> {
  const [synthetic, pilot] = await Promise.all([
    loadResearchLibraryFixture(files),
    loadLocalResearchLibraryPilot(files),
  ]);

  if (synthetic.kind === "loaded" && pilot.kind === "loaded") {
    return {
      kind: "unavailable",
      error: `Both ${RESEARCH_LIBRARY_CONFIG_PATH} and ${RESEARCH_LIBRARY_PILOT_CONFIG_PATH} are present. Remove one; PI WEB will not choose an implicit precedence.`,
    };
  }
  if (synthetic.kind === "unavailable" || pilot.kind === "unavailable") {
    return {
      kind: "unavailable",
      error: [
        synthetic.kind === "unavailable" ? `${RESEARCH_LIBRARY_CONFIG_PATH}: ${synthetic.error}` : undefined,
        pilot.kind === "unavailable" ? `${RESEARCH_LIBRARY_PILOT_CONFIG_PATH}: ${pilot.error}` : undefined,
      ].filter((value): value is string => value !== undefined).join("\n"),
    };
  }
  if (synthetic.kind === "loaded") return { kind: "loaded", source: { mode: "synthetic", fixture: synthetic.fixture } };
  if (pilot.kind === "loaded") return { kind: "loaded", source: { mode: "local-pilot", pilot: pilot.pilot } };
  return { kind: "missing" };
}
