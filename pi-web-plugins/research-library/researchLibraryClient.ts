import {
  MAX_RESEARCH_LIBRARY_CONFIG_BYTES,
  parseResearchLibraryConfigText,
  RESEARCH_LIBRARY_CONFIG_PATH,
  RESEARCH_LIBRARY_RUNTIME_ROOT,
  type SyntheticResearchLibraryConfig,
} from "./config.js";

export const RESEARCH_DISPATCH_VERSION = 1;
export const RESEARCH_DISPATCH_TTL_MS = 10 * 60 * 1_000;
export const RESEARCH_MAX_SEARCHES = 3;
export const RESEARCH_MAX_RESULTS_PER_SEARCH = 5;
export const RESEARCH_MAX_RETURNED_CHARACTERS = 12_000;

const missingWorkspaceFileError = "Path does not exist";
const tokenIdPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface ResearchLibraryFileContent {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface ResearchLibraryFileReader {
  readFile(path: string): Promise<ResearchLibraryFileContent>;
}

export interface ResearchLibraryFileWriter {
  writeFile(path: string, content: string | Uint8Array, options?: { createDirs?: boolean; overwrite?: boolean }): Promise<unknown>;
}

export interface ResearchLibraryPrompt {
  insertText(text: string): void;
  getText(): string;
}

export interface LoadedResearchLibraryFixture {
  config: SyntheticResearchLibraryConfig;
  sha256: string;
}

export type ResearchLibraryFixtureLoadResult =
  | { kind: "loaded"; fixture: LoadedResearchLibraryFixture }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

export interface ResearchDispatchIntent {
  version: typeof RESEARCH_DISPATCH_VERSION;
  synthetic: true;
  token: string;
  createdAt: string;
  expiresAt: string;
  fixtureSha256: string;
  libraryId: string;
  paperId: string;
  passageId: string;
  scope: {
    kind: "current-paper" | "synthetic-library";
    paperIds: string[];
    maxSearches: typeof RESEARCH_MAX_SEARCHES;
    maxResultsPerSearch: typeof RESEARCH_MAX_RESULTS_PER_SEARCH;
    maxReturnedCharacters: typeof RESEARCH_MAX_RETURNED_CHARACTERS;
  };
}

export interface PrepareResearchDispatchInput {
  fixture: LoadedResearchLibraryFixture;
  paperId: string;
  passageId: string;
  scopeKind: ResearchDispatchIntent["scope"]["kind"];
}

export interface PrepareResearchDispatchDependencies {
  files: ResearchLibraryFileWriter;
  prompt: ResearchLibraryPrompt;
  now?: () => Date;
  randomBytes?: (target: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

export interface PreparedResearchDispatch {
  token: string;
  intentPath: string;
  expiresAt: string;
}

export async function loadResearchLibraryFixture(files: ResearchLibraryFileReader): Promise<ResearchLibraryFixtureLoadResult> {
  let file: ResearchLibraryFileContent;
  try {
    file = await files.readFile(RESEARCH_LIBRARY_CONFIG_PATH);
  } catch (error) {
    if (error instanceof Error && error.message === missingWorkspaceFileError) return { kind: "missing" };
    return { kind: "unavailable", error: `Unable to read ${RESEARCH_LIBRARY_CONFIG_PATH}: ${formatUnknownError(error)}` };
  }

  if (file.binary) return { kind: "unavailable", error: `${RESEARCH_LIBRARY_CONFIG_PATH} must be UTF-8 text` };
  if (file.truncated || file.size > MAX_RESEARCH_LIBRARY_CONFIG_BYTES) {
    return { kind: "unavailable", error: `${RESEARCH_LIBRARY_CONFIG_PATH} exceeds ${String(MAX_RESEARCH_LIBRARY_CONFIG_BYTES)} bytes` };
  }

  const parsed = parseResearchLibraryConfigText(file.content);
  if (!parsed.ok) return { kind: "unavailable", error: parsed.error };
  return {
    kind: "loaded",
    fixture: {
      config: parsed.config,
      sha256: await sha256Hex(file.content),
    },
  };
}

export async function prepareResearchDispatch(input: PrepareResearchDispatchInput, dependencies: PrepareResearchDispatchDependencies): Promise<PreparedResearchDispatch> {
  const paper = input.fixture.config.papers.find((candidate) => candidate.id === input.paperId);
  if (paper === undefined) throw new Error("Selected paper is no longer available");
  if (!paper.passages.some((candidate) => candidate.id === input.passageId)) throw new Error("Selected passage is no longer available");

  const tokenId = randomTokenId(dependencies.randomBytes);
  const token = `research-library:v1:${tokenId}`;
  const now = dependencies.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + RESEARCH_DISPATCH_TTL_MS);
  const paperIds = input.scopeKind === "current-paper"
    ? [paper.id]
    : input.fixture.config.papers.map((candidate) => candidate.id).sort();
  const intent: ResearchDispatchIntent = {
    version: RESEARCH_DISPATCH_VERSION,
    synthetic: true,
    token,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    fixtureSha256: input.fixture.sha256,
    libraryId: input.fixture.config.libraryId,
    paperId: paper.id,
    passageId: input.passageId,
    scope: {
      kind: input.scopeKind,
      paperIds,
      maxSearches: RESEARCH_MAX_SEARCHES,
      maxResultsPerSearch: RESEARCH_MAX_RESULTS_PER_SEARCH,
      maxReturnedCharacters: RESEARCH_MAX_RETURNED_CHARACTERS,
    },
  };
  const intentPath = `${RESEARCH_LIBRARY_RUNTIME_ROOT}/intents/${tokenId}.json`;
  await dependencies.files.writeFile(intentPath, `${JSON.stringify(intent)}\n`, { createDirs: true, overwrite: false });

  const promptBefore = dependencies.prompt.getText();
  dependencies.prompt.insertText(token);
  const promptAfter = dependencies.prompt.getText();
  if (promptAfter === promptBefore || !promptAfter.includes(token)) {
    throw new Error("The dispatch intent was created, but no mounted PI WEB prompt accepted its token. Select an active session and try again; the orphan intent is harmless and expires automatically.");
  }

  return { token, intentPath, expiresAt: intent.expiresAt };
}

export function tokenIdFromDispatchToken(token: string): string | undefined {
  const prefix = "research-library:v1:";
  if (!token.startsWith(prefix)) return undefined;
  const tokenId = token.slice(prefix.length);
  return tokenIdPattern.test(tokenId) ? tokenId : undefined;
}

export async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomTokenId(randomBytes: PrepareResearchDispatchDependencies["randomBytes"]): string {
  const bytes = new Uint8Array(new ArrayBuffer(32));
  (randomBytes ?? ((target) => crypto.getRandomValues(target)))(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
