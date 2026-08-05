import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionDirEnvKeys } from "../../config.js";
import { createPiSessionManagerGateway, defaultPiSessionDir, defaultPiSessionsRoot, filterSessionsForCwd, SessionDirResolver } from "./piSessionManagerGateway.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { PiSessionManager } from "./piSessionService.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";
import { sep } from "node:path";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-gateway-test-"));
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "workspace");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionDirResolver", () => {
  it("uses Pi default session storage when no Pi override is configured", () => {
    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "pi-default", sessionDir: defaultPiSessionDir(cwd, agentDir), usesConfiguredSessionDir: false });
    expect(defaultPiSessionsRoot(agentDir)).toBe(join(agentDir, "sessions"));
  });

  it("uses Pi sessionDir settings and resolves relative paths against the session cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".pi", "sessions"), usesConfiguredSessionDir: true });
  });

  it("lets project-local Pi sessionDir settings override global Pi settings for that cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "global-sessions") }, null, 2)}\n`, "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify({ sessionDir: ".workspace-sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".workspace-sessions"), usesConfiguredSessionDir: true });
  });

  it("lets the Pi sessionDir environment override Pi settings", async () => {
    const envDir = join(tempDir, "env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("uses PI WEB sessionDir environment overrides before settings", async () => {
    const envDir = join(tempDir, "pi-web-env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_WEB_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("snapshots the daemon epoch's injected session-directory environment", () => {
    const firstDir = join(tempDir, "first-env-sessions");
    const env = { PI_WEB_AGENT_SESSION_DIR: firstDir };
    const sessionDirEnvKeys = ["PI_WEB_AGENT_SESSION_DIR"];
    const resolver = new SessionDirResolver({ agentDir, env, sessionDirEnvKeys });

    env.PI_WEB_AGENT_SESSION_DIR = join(tempDir, "mutated-env-sessions");
    sessionDirEnvKeys[0] = "OTHER_SESSION_DIR";

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: firstDir, usesConfiguredSessionDir: true });
  });
});

describe("Pi session manager gateway", () => {
  it("lists sessions across the default Pi session store", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-a", cwd);
    await writeSessionFile(defaultPiSessionDir(otherCwd, agentDir), "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "session-a", cwd }), expect.objectContaining({ id: "session-b", cwd: otherCwd })]));
  });

  it("includes an absolute env-configured session directory in global listing", async () => {
    const envSessionDir = join(tempDir, "env-sessions");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "default-session", cwd);
    await writeSessionFile(envSessionDir, "env-session", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envSessionDir }));

    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "default-session", cwd }), expect.objectContaining({ id: "env-session", cwd })]));
  });

  it("includes generic env session directories in global listing", async () => {
    for (const envKey of ["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
      const envSessionDir = join(tempDir, `${envKey.toLowerCase()}-sessions`);
      await writeSessionFile(envSessionDir, `${envKey.toLowerCase()}-session`, cwd);
      const gateway = createPiSessionManagerGateway({
        agentDir,
        env: { [envKey]: envSessionDir },
        sessionDirEnvKeys: [envKey],
      });

      await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: `${envKey.toLowerCase()}-session`, cwd })]));
    }
  });

  it("lists only sessions for the requested cwd when a custom Pi sessionDir is shared", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(sharedSessionDir, "session-a", cwd);
    await writeSessionFile(sharedSessionDir, "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-a", cwd }]);
    const created = gateway.create(cwd);
    expect(hasSessionDir(created)).toBe(true);
    if (!hasSessionDir(created)) throw new Error("Expected SDK session manager");
    expect(created.getSessionDir()).toBe(sharedSessionDir);
  });

  it("lists sessions for cwds that differ from the server process cwd", async () => {
    // Regression: SessionManager.list("", dir) filtered against process.cwd(),
    // hiding every session outside the daemon's own launch directory.
    expect(cwd).not.toBe(process.cwd());
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-elsewhere", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-elsewhere", cwd }]);
  });

  it("summarizes sessions whose transcript bodies contain unreadable lines", async () => {
    // The lightweight listing reads header + summary fields only; a corrupt or
    // half-written transcript line must not break the listing.
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await mkdir(sharedSessionDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "session-rough", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      '{"type":"message","id":"half-written"',
      JSON.stringify({ type: "message", id: "m1", parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    ];
    await writeFile(join(sharedSessionDir, "rough.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-rough", cwd, messageCount: 1, firstMessage: "hello" }]);
  });

  it("keeps repeated listings fresh by folding appended transcript tails", async () => {
    // The gateway keeps one memoized scanner for its lifetime, so a second
    // listing of the same directory must reflect appends, not stale cache.
    const sharedSessionDir = join(tempDir, "memo-sessions");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const path = await writeNamedSessionFile(sharedSessionDir, "memo.jsonl", { id: "memo-session", cwd });
    await appendFile(path, `${message("m1", "user", "hello")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "memo-session", cwd, messageCount: 1, firstMessage: "hello" }]);

    await appendFile(path, `${message("m2", "assistant", "hi there")}\n${message("m3", "user", "follow-up")}\n`, "utf8");

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "memo-session", cwd, messageCount: 3, firstMessage: "hello" }]);
  });

  it("invalidateSessionFile drops the memo for a header rewritten in place", async () => {
    // Detach rewrites the header with a truncate+write that keeps the inode
    // (mirrored here), while appended entries keep the file growing — a
    // rewrite invisible to the memo key without an explicit invalidation.
    const sharedSessionDir = join(tempDir, "detach-sessions");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const path = await writeNamedSessionFile(sharedSessionDir, "detached.jsonl", { id: "detached-session", cwd, parentSession: "/parents/detached.jsonl" });
    await appendFile(path, `${message("m1", "user", "first")}\n${message("m2", "assistant", "second")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "detached-session", cwd, messageCount: 2, parentSessionPath: "/parents/detached.jsonl" }]);

    await appendFile(path, `${message("m3", "user", "padding so the rewrite still grows the file")}\n`, "utf8");
    await rewriteHeaderWithoutParentSession(path);
    gateway.invalidateSessionFile(path);

    const [listed] = await gateway.list(cwd);
    expect(listed).toMatchObject({ id: "detached-session", cwd, messageCount: 3 });
    expect(listed).not.toHaveProperty("parentSessionPath");
    // Invalidating a path that was never memoized is a no-op.
    expect(() => {
      gateway.invalidateSessionFile(join(sharedSessionDir, "missing.jsonl"));
    }).not.toThrow();
  });
});

describe("gateway header-only parent paths", () => {
  it("collects parent paths only from sessions belonging to the requested cwd", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeNamedSessionFile(sharedSessionDir, "child-a.jsonl", { id: "child-a", cwd, parentSession: "/parents/main.jsonl" });
    await writeNamedSessionFile(sharedSessionDir, "child-b.jsonl", { id: "child-b", cwd: otherCwd, parentSession: "/parents/other.jsonl" });
    await writeNamedSessionFile(sharedSessionDir, "no-parent.jsonl", { id: "no-parent", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.listParentSessionPaths(cwd, readSessionHeaderSummary)).resolves.toEqual(["/parents/main.jsonl"]);
  });

  it("skips unreadable headers instead of failing the scan", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await mkdir(sharedSessionDir, { recursive: true });
    await writeNamedSessionFile(sharedSessionDir, "child.jsonl", { id: "child", cwd, parentSession: "/parents/child.jsonl" });
    await writeFile(join(sharedSessionDir, "broken.jsonl"), "not a session header\n", "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.listParentSessionPaths(cwd, readSessionHeaderSummary)).resolves.toEqual(["/parents/child.jsonl"]);
  });

  it("lists nothing when the session directory does not exist", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: join(tempDir, "missing-sessions") }));

    await expect(gateway.listParentSessionPaths(cwd, readSessionHeaderSummary)).resolves.toEqual([]);
  });

  it("reads headers with bounded concurrency and still collects every parent", async () => {
    // Unbounded concurrent opens could exhaust the daemon's file-descriptor
    // budget on a directory with many sessions; EMFILE would then surface as
    // "unreadable" headers and silently drop children from the counts.
    const sharedSessionDir = join(tempDir, "bounded-sessions");
    const fileCount = 25;
    for (let index = 0; index < fileCount; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeNamedSessionFile(sharedSessionDir, `child-${suffix}.jsonl`, {
        id: `child-${suffix}`,
        cwd,
        parentSession: `/parents/child-${suffix}.jsonl`,
      });
    }
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    let activeReads = 0;
    let maxActiveReads = 0;
    const readHeader = async (sessionFile: string) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        return await readSessionHeaderSummary(sessionFile);
      } finally {
        activeReads -= 1;
      }
    };

    const parents = await gateway.listParentSessionPaths(cwd, readHeader);

    expect(parents).toHaveLength(fileCount);
    expect(maxActiveReads).toBeLessThanOrEqual(10);
    // The bound must not serialize the scan: workers really overlap.
    expect(maxActiveReads).toBeGreaterThan(1);
  });
});

describe("gateway session-file resolution by id", () => {
  it("resolves a session from the id embedded in its file name without scanning other headers", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-id.jsonl", { id: "target-id", cwd });
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-01-000Z_other-id.jsonl", { id: "other-id", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    const readPaths: string[] = [];
    const readHeader = async (sessionFile: string) => {
      readPaths.push(sessionFile);
      return readSessionHeaderSummary(sessionFile);
    };

    await expect(gateway.resolveSessionFile(cwd, "target-id", readHeader)).resolves.toEqual({ id: "target-id", cwd, path: targetPath });
    expect(readPaths).toEqual([targetPath]);
  });

  it("resolves an id prefix the same way a listing match would", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_0199f3a2-prefix-session.jsonl", { id: "0199f3a2-prefix-session", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "0199f3a2", readSessionHeaderSummary)).resolves.toEqual({ id: "0199f3a2-prefix-session", cwd, path: targetPath });
  });

  it("falls back to header reads when the file name does not embed the id", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "hand-renamed.jsonl", { id: "renamed-session", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "renamed-session", readSessionHeaderSummary)).resolves.toEqual({ id: "renamed-session", cwd, path: renamedPath });
  });

  it("trusts the header over a file name that embeds a different session id", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const copiedPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_original-id.jsonl", { id: "copied-id", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "original-id", readSessionHeaderSummary)).resolves.toBeUndefined();
    await expect(gateway.resolveSessionFile(cwd, "copied-id", readSessionHeaderSummary)).resolves.toEqual({ id: "copied-id", cwd, path: copiedPath });
  });

  it("does not let a failing filename candidate shadow a renamed file that really holds the session", async () => {
    // A copy whose name embeds the requested id but whose header holds another
    // session must not end the search: the remaining files are checked too.
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-session.jsonl", { id: "unrelated-session", cwd });
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "hand-renamed.jsonl", { id: "target-session", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "target-session", readSessionHeaderSummary)).resolves.toEqual({ id: "target-session", cwd, path: renamedPath });
  });

  it("prefers an exact header id over a newer prefix match", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-02T00-00-00-000Z_abc123-extended.jsonl", { id: "abc123-extended", cwd });
    const exactPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_abc123.jsonl", { id: "abc123", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "abc123", readSessionHeaderSummary)).resolves.toEqual({ id: "abc123", cwd, path: exactPath });
  });

  it("prefers an exact header id in a renamed file over a prefix-matching filename candidate", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-session.jsonl", { id: "target-session-extended", cwd });
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "archived.jsonl", { id: "target-session", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "target-session", readSessionHeaderSummary)).resolves.toEqual({ id: "target-session", cwd, path: renamedPath });
  });

  it("resolves ambiguous prefixes deterministically by newest embedded timestamp, then plain name order", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    // Written newest-last on purpose: readdir order must not influence the outcome.
    const newestPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-02T00-00-00-000Z_abc-two.jsonl", { id: "abc-two", cwd });
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_abc-one.jsonl", { id: "abc-one", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "abc", readSessionHeaderSummary)).resolves.toEqual({ id: "abc-two", cwd, path: newestPath });

    // Same embedded timestamp: plain (non-locale) code-unit order decides, so
    // the lowercase id sorts after the uppercase one and wins.
    const tiedDir = join(tempDir, "tied-sessions");
    await writeNamedSessionFile(tiedDir, "2026-01-03T00-00-00-000Z_abc-AAA.jsonl", { id: "abc-AAA", cwd });
    const tiedWinnerPath = await writeNamedSessionFile(tiedDir, "2026-01-03T00-00-00-000Z_abc-aaa.jsonl", { id: "abc-aaa", cwd });
    const tiedGateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: tiedDir }));

    await expect(tiedGateway.resolveSessionFile(cwd, "abc", readSessionHeaderSummary)).resolves.toEqual({ id: "abc-aaa", cwd, path: tiedWinnerPath });
  });

  it("does not resolve sessions that belong to another cwd", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_elsewhere.jsonl", { id: "elsewhere", cwd: otherCwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "elsewhere", readSessionHeaderSummary)).resolves.toBeUndefined();
  });

  it("ignores sessions whose header has no cwd, like a listing would", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_legacy.jsonl", { id: "legacy" });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "legacy", readSessionHeaderSummary)).resolves.toBeUndefined();
  });

  it("canonicalizes the header cwd it reports", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_messy.jsonl", { id: "messy", cwd: `${cwd}${sep}.${sep}` });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "messy", readSessionHeaderSummary)).resolves.toMatchObject({ id: "messy", cwd });
  });

  it("resolves nothing when the session directory does not exist", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: join(tempDir, "missing-sessions") }));

    await expect(gateway.resolveSessionFile(cwd, "any-session", readSessionHeaderSummary)).resolves.toBeUndefined();
  });
});

describe("filterSessionsForCwd", () => {
  it("matches cwds that differ only by trailing separator or redundant segments", () => {
    const sessions = [sessionEntry("a", cwd)];

    expect(filterSessionsForCwd(sessions, `${cwd}${sep}`)).toHaveLength(1);
    expect(filterSessionsForCwd(sessions, join(cwd, "."))).toHaveLength(1);
  });

  it("excludes sessions with an empty cwd instead of matching the process cwd", () => {
    expect(filterSessionsForCwd([sessionEntry("a", "")], process.cwd())).toHaveLength(0);
  });

  it("excludes sessions from other cwds", () => {
    expect(filterSessionsForCwd([sessionEntry("a", join(tempDir, "other"))], cwd)).toHaveLength(0);
  });
});

describe("session listing canonicalization", () => {
  it("canonicalizes session header cwds written by external tools", async () => {
    // Headers are written by the Pi CLI / SDK consumers and may contain
    // unnormalized paths (trailing separators, redundant segments).
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-messy", `${cwd}${sep}.${sep}`);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-messy", cwd }]);
  });
});

function piProfileOptions(env: NodeJS.ProcessEnv = {}) {
  return { agentDir, env, sessionDirEnvKeys: agentSessionDirEnvKeys() };
}

function hasSessionDir(manager: PiSessionManager): manager is PiSessionManager & { getSessionDir(): string } {
  return "getSessionDir" in manager && typeof manager.getSessionDir === "function";
}

function sessionEntry(id: string, sessionCwd: string): PiSessionListEntry {
  return { path: join(tempDir, `${id}.jsonl`), id, cwd: sessionCwd, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

async function writeSessionFile(dir: string, id: string, sessionCwd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd })}\n`, "utf8");
}

async function writeNamedSessionFile(dir: string, fileName: string, header: { id: string; cwd?: string; parentSession?: string }): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  const line = { type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", ...header };
  await writeFile(path, `${JSON.stringify(line)}\n`, "utf8");
  return path;
}

/**
 * Mimics piSessionService's clearParentSession: rewrite the header in place
 * (truncate + write keeps the inode) with the parent link removed.
 */
async function rewriteHeaderWithoutParentSession(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const newlineIndex = content.indexOf("\n");
  const parsed: unknown = JSON.parse(content.slice(0, newlineIndex));
  if (!isRecord(parsed)) throw new Error("Invalid session file header");
  delete parsed["parentSession"];
  await writeFile(path, `${JSON.stringify(parsed)}${content.slice(newlineIndex)}`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
