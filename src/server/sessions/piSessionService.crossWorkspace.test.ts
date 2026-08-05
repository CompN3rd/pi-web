import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionService, type PiSessionListEntry } from "./piSessionService.js";
import { createPiSessionManagerGateway, listParentSessionPathsInDir } from "./piSessionManagerGateway.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionRecord, sessionRef, testModelRuntime, type SessionGateway } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const CHILD_CWD = "/srv/dev/pi-web";
// Resolved because the service canonicalizes header cwds before annotating: a
// bare "/srv/..." is drive-relative on Windows and would land on the runner's
// current drive.
const PARENT_CWD = resolve("/srv/dev/pi-web-feature");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-parent-location-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PiSessionService.list parent locations", () => {
  it("reports the cwd and id of a parent living in another worktree", async () => {
    const parentFile = await parentSessionFile({ id: "parent-id", cwd: PARENT_CWD });
    const service = serviceListing([childRecord(parentFile)]);

    const [child] = await service.list(CHILD_CWD);

    expect(child).toMatchObject({ id: "child", parentSessionCwd: PARENT_CWD, parentSessionId: "parent-id" });
  });

  it("leaves sessions untouched when the parent is in the same workspace listing", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const child = { ...sessionRecord("child", CHILD_CWD), parentSessionPath: parent.path };
    const service = serviceListing([parent, child]);

    const listed = await service.list(CHILD_CWD);

    expect(listed.find((session) => session.id === "child")).not.toHaveProperty("parentSessionCwd");
  });

  it("does not annotate a parent whose file records the same cwd, since it is not elsewhere", async () => {
    const parentFile = await parentSessionFile({ id: "parent-id", cwd: CHILD_CWD });
    const service = serviceListing([childRecord(parentFile)]);

    const [child] = await service.list(CHILD_CWD);

    expect(child).not.toHaveProperty("parentSessionCwd");
    expect(child).toHaveProperty("parentSessionPath", parentFile);
  });

  it("still lists a child whose parent file is gone, without location fields", async () => {
    const service = serviceListing([childRecord(join(tempDir, "deleted-parent.jsonl"))]);

    const [child] = await service.list(CHILD_CWD);

    expect(child).toMatchObject({ id: "child" });
    expect(child).not.toHaveProperty("parentSessionCwd");
    expect(child).not.toHaveProperty("parentSessionId");
  });

  it("re-reads a cached parent header when the file at that path is replaced", async () => {
    // The header cache is keyed by path but verified against the file's
    // identity: a replacement landed at a cached path must be served, not the
    // header of the file that used to live there.
    const parentFile = await parentSessionFile({ id: "parent-id", cwd: PARENT_CWD });
    const service = serviceListing([childRecord(parentFile)]);
    await service.list(CHILD_CWD);

    const replacementFile = join(tempDir, "replacement-parent.jsonl");
    await writeFile(replacementFile, `${JSON.stringify({ type: "session", version: 3, id: "replacement-id", cwd: PARENT_CWD })}\n`, "utf8");
    await rename(replacementFile, parentFile);
    const [child] = await service.list(CHILD_CWD);

    expect(child).toMatchObject({ parentSessionCwd: PARENT_CWD, parentSessionId: "replacement-id" });
  });

  it("drops a cached parent annotation when the parent file is deleted", async () => {
    const parentFile = await parentSessionFile({ id: "parent-id", cwd: PARENT_CWD });
    const service = serviceListing([childRecord(parentFile)]);
    await service.list(CHILD_CWD);

    await rm(parentFile);
    const [child] = await service.list(CHILD_CWD);

    expect(child).not.toHaveProperty("parentSessionCwd");
    expect(child).not.toHaveProperty("parentSessionId");
  });

  it("releases cached headers on dispose so the cache cannot outlive the service", async () => {
    const parentFile = await parentSessionFile({ id: "parent-id", cwd: PARENT_CWD });
    const service = serviceListing([childRecord(parentFile)]);
    await service.list(CHILD_CWD);

    await service.dispose();
    await rm(parentFile);
    const [child] = await service.list(CHILD_CWD);

    expect(child).not.toHaveProperty("parentSessionCwd");
  });
});

describe("PiSessionService.list children in sibling workspaces", () => {
  it("counts children that live in other workspaces of the same project", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const service = serviceListing({
      [CHILD_CWD]: [parent],
      [PARENT_CWD]: [{ ...sessionRecord("child-a", PARENT_CWD), parentSessionPath: parent.path }, { ...sessionRecord("child-b", PARENT_CWD), parentSessionPath: parent.path }],
    }, [CHILD_CWD, PARENT_CWD]);

    const [listed] = await service.list(CHILD_CWD);

    expect(listed).toMatchObject({ id: "parent", childSessionsElsewhere: 2 });
  });

  it("does not count children nested in the same workspace listing", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const service = serviceListing({
      [CHILD_CWD]: [parent, { ...sessionRecord("child", CHILD_CWD), parentSessionPath: parent.path }],
      [PARENT_CWD]: [],
    }, [CHILD_CWD, PARENT_CWD]);

    const listed = await service.list(CHILD_CWD);

    expect(listed.find((session) => session.id === "parent")).not.toHaveProperty("childSessionsElsewhere");
  });

  it("skips sibling scanning when the cwd belongs to no registered project", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const service = serviceListing({
      [CHILD_CWD]: [parent],
      [PARENT_CWD]: [{ ...sessionRecord("child", PARENT_CWD), parentSessionPath: parent.path }],
    }, undefined);

    const [listed] = await service.list(CHILD_CWD);

    expect(listed).not.toHaveProperty("childSessionsElsewhere");
  });

  it("still lists sessions when a sibling workspace cannot be scanned", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const service = serviceListing({ [CHILD_CWD]: [parent] }, [CHILD_CWD, PARENT_CWD], {
      scanCwd: (cwd) => {
        if (cwd === PARENT_CWD) throw new Error("sibling workspace is gone");
        return undefined;
      },
    });

    const [listed] = await service.list(CHILD_CWD);

    expect(listed).toMatchObject({ id: "parent" });
    expect(listed).not.toHaveProperty("childSessionsElsewhere");
  });

  it("counts sibling children from header parent paths even when sibling listings fail", async () => {
    const parent = sessionRecord("parent", CHILD_CWD);
    const service = serviceListing({
      [CHILD_CWD]: [parent],
      [PARENT_CWD]: [{ ...sessionRecord("child", PARENT_CWD), parentSessionPath: parent.path }],
    }, [CHILD_CWD, PARENT_CWD], {
      // A throwing sibling listing must not matter: the scan reads headers only.
      listCwd: (cwd) => {
        if (cwd === PARENT_CWD) throw new Error("sibling listing is unavailable");
        return undefined;
      },
    });

    const [listed] = await service.list(CHILD_CWD);

    expect(listed).toMatchObject({ id: "parent", childSessionsElsewhere: 1 });
  });

  it("stops counting a sibling child as soon as its parent link is detached", async () => {
    // The sibling scan reuses the service's memoized header reads, so detach —
    // the only flow that rewrites a header — must drop the cached entry.
    const parent = sessionRecord("parent", CHILD_CWD);
    const siblingDir = join(tempDir, "sibling-sessions");
    await mkdir(siblingDir, { recursive: true });
    const childFile = join(siblingDir, "child.jsonl");
    await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: PARENT_CWD, parentSession: parent.path })}\n`, "utf8");
    const child = fakeRuntime("child", { sessionFile: childFile });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(child.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (cwd: string) => Promise.resolve(cwd === CHILD_CWD ? [parent] : []),
        listAll: () => Promise.resolve([]),
        listParentSessionPaths: (siblingCwd: string, readHeader) => siblingCwd === PARENT_CWD
          ? listParentSessionPathsInDir(siblingDir, siblingCwd, readHeader)
          : Promise.resolve([]),
        invalidateSessionFile: () => undefined,
        resolveSessionFile: (refCwd: string, sessionId: string) => Promise.resolve(
          sessionId === "child" && refCwd === PARENT_CWD ? { id: "child", cwd: PARENT_CWD, path: childFile } : undefined,
        ),
        open: () => fakeSessionManager(PARENT_CWD, { getSessionId: () => "child" }),
      },
      heartbeatIntervalMs: 60_000,
      projectWorkspaces: { forCwd: () => Promise.resolve([CHILD_CWD, PARENT_CWD]) },
    });

    const [before] = await service.list(CHILD_CWD);
    expect(before).toMatchObject({ id: "parent", childSessionsElsewhere: 1 });

    await service.detachParent(sessionRef("child", PARENT_CWD));

    const [after] = await service.list(CHILD_CWD);
    expect(after).toMatchObject({ id: "parent" });
    expect(after).not.toHaveProperty("childSessionsElsewhere");
    await service.dispose();
  });

  it("reports both an out-of-workspace parent and children elsewhere on one listing", async () => {
    const grandparentFile = await parentSessionFile({ id: "grandparent-id", cwd: PARENT_CWD });
    const middle = { ...sessionRecord("middle", CHILD_CWD), parentSessionPath: grandparentFile };
    const service = serviceListing({
      [CHILD_CWD]: [middle],
      [PARENT_CWD]: [{ ...sessionRecord("grandchild", PARENT_CWD), parentSessionPath: middle.path }],
    }, [CHILD_CWD, PARENT_CWD]);

    const [listed] = await service.list(CHILD_CWD);

    expect(listed).toMatchObject({ id: "middle", parentSessionCwd: PARENT_CWD, parentSessionId: "grandparent-id", childSessionsElsewhere: 1 });
  });
});

describe("PiSessionService header cache on replaced session files", () => {
  it("lists and opens the session that replaced a cached path instead of serving the stale header", async () => {
    // The header cache memoizes reads per path while the summary scanner
    // notices identity replacements. If the cached reader kept serving the
    // old header for a replaced path, the replacement would appear in the
    // listing but stay permanently unopenable ("Session not found").
    const sessionDir = join(tempDir, "replace-sessions");
    await mkdir(sessionDir, { recursive: true });
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const header = (id: string, sessionCwd: string, parentSession?: string) =>
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd, ...(parentSession === undefined ? {} : { parentSession }) });
    const originalPath = join(sessionDir, "2026-01-01T00-00-00-000Z_original-id.jsonl");
    await writeFile(originalPath, `${header("original-id", CHILD_CWD)}\n${message("m1", "user", "original transcript")}\n`, "utf8");
    // A child living in the sibling worktree records the original file as its
    // parent, so the sibling scan reports it — proof that the scan really
    // read (and cached) the headers.
    await writeFile(join(sessionDir, "2026-01-01T00-00-01-000Z_child-id.jsonl"), `${header("child-id", PARENT_CWD, originalPath)}\n`, "utf8");

    const realGateway = createPiSessionManagerGateway({
      agentDir: TEST_AGENT_DIR,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      sessionDirEnvKeys: ["PI_CODING_AGENT_SESSION_DIR"],
    });
    const replacementRuntime = fakeRuntime("replacement-id", {
      sessionManager: fakeSessionManager(CHILD_CWD, {
        getSessionId: () => "replacement-id",
        getBranch: () => [{ type: "message", id: "r1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "replacement transcript" } }],
      }),
    });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(replacementRuntime.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (refCwd: string) => realGateway.list(refCwd),
        listAll: () => realGateway.listAll(),
        listParentSessionPaths: (refCwd: string, readHeader) => realGateway.listParentSessionPaths(refCwd, readHeader),
        resolveSessionFile: (refCwd: string, sessionId: string, readHeader) => realGateway.resolveSessionFile(refCwd, sessionId, readHeader),
        invalidateSessionFile: (sessionFile: string) => {
          realGateway.invalidateSessionFile(sessionFile);
        },
        open: () => fakeSessionManager(CHILD_CWD, { getSessionId: () => "replacement-id" }),
      },
      heartbeatIntervalMs: 60_000,
      projectWorkspaces: { forCwd: () => Promise.resolve([CHILD_CWD, PARENT_CWD]) },
    });

    // Cold listing: the sibling scan reads (and caches) every header in the dir.
    const cold = await service.list(CHILD_CWD);
    expect(cold.find((session) => session.id === "original-id")).toMatchObject({ childSessionsElsewhere: 1 });

    // Atomic replacement: a new file is renamed over the cached path.
    const replacementFile = join(sessionDir, "2026-01-02T00-00-00-000Z_replacement-id.jsonl");
    await writeFile(replacementFile, `${header("replacement-id", CHILD_CWD)}\n${message("r1", "user", "replacement transcript")}\n`, "utf8");
    await rename(replacementFile, originalPath);

    const warm = await service.list(CHILD_CWD);
    expect(warm.map((session) => session.id)).toEqual(["replacement-id"]);

    // The open path must agree with the listing...
    const page = await service.messages(sessionRef("replacement-id", CHILD_CWD));
    expect(page.messages).toEqual([{ role: "user", content: "replacement transcript" }]);
    // ...and the replaced session is really gone.
    await expect(service.messages(sessionRef("original-id", CHILD_CWD))).rejects.toThrow("Session not found");
    await service.dispose();
  });
});

describe("PiSessionService.detachParent summary memo", () => {
  it("invalidates the gateway summary memo so warm listings re-read the rewritten header", async () => {
    // The gateway keeps one memoized scanner for its lifetime. Detach rewrites
    // the header in place (same inode), which the memo's identity+size key
    // cannot detect, so detach must invalidate the entry or the warm listing
    // serves the pre-detach parent link and message count forever. This test
    // lists through the real gateway/scanner path on purpose: fakes cannot see
    // the memo.
    const sessionDir = join(tempDir, "detach-sessions");
    await mkdir(sessionDir, { recursive: true });
    const parentPath = join(sessionDir, "parent.jsonl");
    await writeFile(parentPath, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: CHILD_CWD })}\n`, "utf8");
    const childPath = join(sessionDir, "child.jsonl");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    await writeFile(childPath, [
      JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: CHILD_CWD, parentSession: parentPath }),
      message("m1", "user", "hello"),
      message("m2", "assistant", "hi there"),
    ].join("\n") + "\n", "utf8");

    const realGateway = createPiSessionManagerGateway({
      agentDir: TEST_AGENT_DIR,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      sessionDirEnvKeys: ["PI_CODING_AGENT_SESSION_DIR"],
    });
    const child = fakeRuntime("child", { sessionFile: childPath });
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(child.runtime),
      archiveStore: emptyArchiveStore(),
      sessionManager: {
        create: () => fakeSessionManager(),
        list: (refCwd: string) => realGateway.list(refCwd),
        listAll: () => realGateway.listAll(),
        listParentSessionPaths: (refCwd: string, readHeader) => realGateway.listParentSessionPaths(refCwd, readHeader),
        resolveSessionFile: (refCwd: string, sessionId: string, readHeader) => realGateway.resolveSessionFile(refCwd, sessionId, readHeader),
        invalidateSessionFile: (sessionFile: string) => {
          realGateway.invalidateSessionFile(sessionFile);
        },
        open: () => fakeSessionManager(CHILD_CWD, { getSessionId: () => "child" }),
      },
      heartbeatIntervalMs: 60_000,
    });

    const before = await service.list(CHILD_CWD);
    expect(before.find((session) => session.id === "child")).toMatchObject({ id: "child", messageCount: 2, parentSessionPath: parentPath });

    // Grow the file after the cold listing so the memo takes its append-growth
    // path — the shape in which the in-place rewrite went unnoticed.
    await appendFile(childPath, `${message("m3", "user", "padding so the rewrite still grows the file")}\n`, "utf8");

    await service.detachParent(sessionRef("child", CHILD_CWD));

    const after = await service.list(CHILD_CWD);
    const detached = after.find((session) => session.id === "child");
    expect(detached).toMatchObject({ id: "child", messageCount: 3 });
    expect(detached).not.toHaveProperty("parentSessionPath");
    await service.dispose();
  });
});

function childRecord(parentSessionPath: string) {
  return { ...sessionRecord("child", CHILD_CWD), parentSessionPath };
}

async function parentSessionFile(header: { id: string; cwd: string }): Promise<string> {
  const path = join(tempDir, `${header.id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, ...header }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null }),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

type SessionRecord = PiSessionListEntry;

/**
 * Build a service over per-cwd session listings. `projectCwds` is the workspace
 * set of the containing project, or undefined to model an unregistered cwd.
 */
function serviceListing(
  recordsByCwd: SessionRecord[] | Record<string, SessionRecord[]>,
  projectCwds?: string[],
  options: { listCwd?: (cwd: string) => void; scanCwd?: (cwd: string) => void } = {},
): PiSessionService {
  const listings = Array.isArray(recordsByCwd) ? { [CHILD_CWD]: recordsByCwd } : recordsByCwd;
  const gateway: SessionGateway = {
    create: () => fakeSessionManager(),
    list: (cwd: string) => {
      options.listCwd?.(cwd);
      return Promise.resolve(listings[cwd] ?? []);
    },
    listAll: () => Promise.resolve(Object.values(listings).flat()),
    listParentSessionPaths: (cwd: string) => {
      options.scanCwd?.(cwd);
      return Promise.resolve((listings[cwd] ?? []).flatMap((entry) => entry.parentSessionPath === undefined ? [] : [entry.parentSessionPath]));
    },
    invalidateSessionFile: () => undefined,
    resolveSessionFile: (cwd: string, sessionId: string) => {
      const match = Object.values(listings).flat().find((record) => record.id === sessionId || record.id.startsWith(sessionId));
      return Promise.resolve(match === undefined ? undefined : { id: match.id, cwd: match.cwd, path: match.path });
    },
    open: () => fakeSessionManager(),
  };
  return new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    sessionManager: gateway,
    heartbeatIntervalMs: 60_000,
    projectWorkspaces: { forCwd: () => Promise.resolve(projectCwds) },
  });
}
