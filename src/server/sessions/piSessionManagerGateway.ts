import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway } from "./piSessionService.js";

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
  /**
   * One memoized scanner per gateway: its per-file summary memo lives as long
   * as the daemon, so repeated listings answer unchanged files from one stat
   * and re-scan changed ones whole. Invalidation is automatic (file identity +
   * size; see SessionSummaryScanner), with `invalidateSessionFile` for the
   * in-place rewrites those checks cannot see.
   */
  private readonly summaryScanner = new SessionSummaryScanner();

  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    // Lightweight streaming summaries instead of the SDK's full-transcript
    // listing: same fields, but message bodies are never parsed once the first
    // user message is found. The cross-project cleanup listing (listAll) keeps
    // the SDK path.
    const sessions = (await this.summaryScanner.scanSessionSummariesInDir(resolution.sessionDir)).map((session) => ({
      ...session,
      cwd: canonicalizeStoredCwd(session.cwd),
    }));
    return filterSessionsForCwd(sessions, cwd);
  }

  invalidateSessionFile(sessionFile: string): void {
    // Detach is the only flow that rewrites a session file in place (keeping
    // the inode), and the summary memo cannot detect such rewrites from
    // identity + size alone. Drop the entry so the next listing re-reads it.
    this.summaryScanner.invalidate(sessionFile);
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
