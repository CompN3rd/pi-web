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
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

interface DigestProvider {
  digest(algorithm: "SHA-256", data: ArrayBuffer): Promise<ArrayBuffer>;
}

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

export async function sha256Hex(
  text: string,
  subtle: DigestProvider | null = browserSubtleCrypto(),
): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  if (subtle !== null) {
    const buffer = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(buffer).set(encoded);
    const digest = await subtle.digest("SHA-256", buffer);
    return bytesToHex(new Uint8Array(digest));
  }
  return bytesToHex(portableSha256(encoded));
}

function browserSubtleCrypto(): DigestProvider | null {
  const runtime = Reflect.get(globalThis, "crypto");
  if (!isObjectLike(runtime)) return null;
  const subtle = Reflect.get(runtime, "subtle");
  if (!isObjectLike(subtle)) return null;
  const digest = Reflect.get(subtle, "digest");
  if (typeof digest !== "function") return null;
  return {
    digest: async (algorithm, data) => {
      const result: unknown = await Reflect.apply(digest, subtle, [algorithm, data]);
      if (!(result instanceof ArrayBuffer)) throw new Error("SubtleCrypto returned an invalid SHA-256 digest");
      return result;
    },
  };
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function portableSha256(input: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const bitLength = input.byteLength * 8;
  const data = new DataView(padded.buffer);
  data.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  data.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = data.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  for (const [index, value] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) outputView.setUint32(index * 4, value);
  return output;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
