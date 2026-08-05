import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import type { SessionHeaderReader } from "./parentSessionLocator.js";
import { scanSessionSummariesInDir } from "./sessionSummaryScanner.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway, ResolvedSessionFile } from "./piSessionService.js";

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  sessionDirEnvKeys: readonly string[];
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly envSessionDir: string | undefined;
  private readonly homeDir: string;

  constructor(options: SessionDirResolverOptions) {
    this.agentDir = options.agentDir;
    this.envSessionDir = options.sessionDirEnvKeys
      .map((key) => options.env[key])
      .find((value) => value !== undefined && value !== "");
    const configuredHome = options.env["HOME"];
    this.homeDir = configuredHome !== undefined && configuredHome !== "" && isAbsolute(configuredHome) ? configuredHome : homedir();
  }

  defaultSessionsRoot(): string {
    return defaultPiSessionsRoot(this.agentDir);
  }

  globalEnvSessionDir(): string | undefined {
    if (this.envSessionDir === undefined) return undefined;
    const expanded = expandTildePath(this.envSessionDir, this.homeDir);
    return isAbsolute(expanded) ? expanded : undefined;
  }

  resolve(cwd: string): SessionDirResolution {
    if (this.envSessionDir !== undefined) {
      return { source: "env", sessionDir: resolveConfiguredPath(this.envSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    // Lightweight streaming summaries instead of the SDK's full-transcript
    // listing: same fields, but message bodies are never parsed once the first
    // user message is found. The cross-project cleanup listing (listAll) keeps
    // the SDK path.
    const sessions = (await scanSessionSummariesInDir(resolution.sessionDir)).map((session) => ({
      ...session,
      cwd: canonicalizeStoredCwd(session.cwd),
    }));
    return filterSessionsForCwd(sessions, cwd);
  }

  async listParentSessionPaths(cwd: string, readHeader: SessionHeaderReader): Promise<string[]> {
    const resolution = this.resolver.resolve(cwd);
    return listParentSessionPathsInDir(resolution.sessionDir, cwd, readHeader);
  }

  async resolveSessionFile(cwd: string, sessionId: string, readHeader: SessionHeaderReader): Promise<ResolvedSessionFile | undefined> {
    const resolution = this.resolver.resolve(cwd);
    return resolveSessionFileInDir(resolution.sessionDir, cwd, sessionId, readHeader);
  }

  create(cwd: string, options?: { parentSession?: string }): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir, options?.parentSession === undefined ? undefined : { parentSession: options.parentSession });
  }

  async listAll(): Promise<PiSessionListEntry[]> {
    const envSessionDir = this.resolver.globalEnvSessionDir();
    const [defaultSessions, envSessions] = await Promise.all([
      listSessionsInDefaultPiStore(this.resolver.defaultSessionsRoot()),
      envSessionDir === undefined ? Promise.resolve([]) : listSessionsInDir(envSessionDir),
    ]);
    return uniqueSessionsByPath([...defaultSessions, ...envSessions]);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  // listAll(sessionDir) lists without the SDK's internal cwd filter, which would
  // otherwise compare against this process's cwd and drop other projects' sessions.
  // Cwd filtering is applied explicitly by filterSessionsForCwd where needed.
  // Session file headers are written by external tools (Pi CLI, SDK consumers),
  // so their cwd is canonicalized here before it enters pi-web.
  const sessions = await SessionManager.listAll(sessionDir);
  return sessions.map((session) => ({ ...session, cwd: canonicalizeStoredCwd(session.cwd) }));
}

export async function listSessionsInDefaultPiStore(storeRoot: string): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(storeRoot, entry.name));
  const sessions = (await Promise.all(sessionDirs.map((dir) => listSessionsInDir(dir)))).flat();
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  // Sessions with an empty cwd (old session files) are excluded: resolve("") would
  // resolve to this process's cwd and produce false matches.
  return sessions.filter((session) => session.cwd !== "" && cwdPathsEqual(session.cwd, cwd));
}

/**
 * Collect the `parentSessionPath` values recorded in a session directory's
 * files, reading only each file's single-line JSON header — never the
 * transcripts. The header is the only place a child records its parent, so
 * this yields exactly what a full listing would report for the relationship.
 *
 * Unreadable headers contribute nothing (matching how a listing skips invalid
 * files), and headers whose cwd does not belong to `cwd` are excluded exactly
 * like `filterSessionsForCwd` would exclude them from a listing.
 */
export async function listParentSessionPathsInDir(sessionDir: string, cwd: string, readHeader: SessionHeaderReader): Promise<string[]> {
  const sessionFiles = await listSessionFiles(sessionDir);
  const headers = await Promise.all(sessionFiles.map((sessionFile) => readHeader(sessionFile)));
  const parentSessionPaths: string[] = [];
  for (const header of headers) {
    // A header without a cwd (very old session files) would also be dropped by
    // filterSessionsForCwd, so it contributes no parent here either.
    if (header?.parentSession === undefined || header.cwd === undefined || !cwdPathsEqual(header.cwd, cwd)) continue;
    parentSessionPaths.push(header.parentSession);
  }
  return parentSessionPaths;
}

/**
 * Locate a session file by id without parsing transcripts.
 *
 * Session filenames embed the session id (`<timestamp>_<sessionId>.jsonl`), so
 * exact and prefix matches are normally found from the directory names alone
 * and confirmed by one header read. When no filename matches (renamed or
 * hand-named files), every header in the directory is checked instead, keeping
 * the outcome identical to picking the session out of a full listing. Headers
 * decide: a file whose header id or cwd does not match is not the session.
 *
 * The header's cwd is returned canonicalized, matching what `list` reports.
 */
export async function resolveSessionFileInDir(
  sessionDir: string,
  cwd: string,
  sessionId: string,
  readHeader: SessionHeaderReader,
): Promise<ResolvedSessionFile | undefined> {
  const sessionFiles = await listSessionFiles(sessionDir);
  const filenameMatches = sessionFiles.filter((sessionFile) => fileNameMatchesSessionId(basename(sessionFile), sessionId));
  // Deterministic among multiple prefix matches: newest-embedded timestamp first.
  const candidates = (filenameMatches.length > 0 ? filenameMatches : sessionFiles).slice().sort((a, b) => b.localeCompare(a));
  for (const sessionFile of candidates) {
    const header = await readHeader(sessionFile);
    if (header?.cwd === undefined) continue;
    if (header.id !== sessionId && !header.id.startsWith(sessionId)) continue;
    if (!cwdPathsEqual(header.cwd, cwd)) continue;
    return { id: header.id, cwd: canonicalizeStoredCwd(header.cwd), path: sessionFile };
  }
  return undefined;
}

/** Whether a `.jsonl` file name embeds `sessionId` (exactly or as a prefix). */
function fileNameMatchesSessionId(fileName: string, sessionId: string): boolean {
  const embeddedId = embeddedFileNameSessionId(fileName);
  return embeddedId !== undefined && (embeddedId === sessionId || embeddedId.startsWith(sessionId));
}

/**
 * The session id embedded in a SDK-style session file name
 * (`<timestamp>_<sessionId>.jsonl`). The timestamp never contains `_`, so the
 * id is everything after the first separator; files without one fall back to
 * the whole stem, and header verification discards false guesses.
 */
function embeddedFileNameSessionId(fileName: string): string | undefined {
  const stem = fileName.slice(0, -".jsonl".length);
  const separatorIndex = stem.indexOf("_");
  const candidate = separatorIndex === -1 ? stem : stem.slice(separatorIndex + 1);
  return candidate === "" ? undefined : candidate;
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    const names = await readdir(sessionDir);
    return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
  } catch {
    // Matches the SDK listing behavior: an unreadable directory lists nothing.
    return [];
  }
}

function uniqueSessionsByPath(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const byPath = new Map<string, PiSessionListEntry>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function defaultPiSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir: string): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string, homeDir: string): string {
  const expanded = expandTildePath(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}
