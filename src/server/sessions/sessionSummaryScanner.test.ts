import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSessionFileSummary, scanSessionSummariesInDir } from "./sessionSummaryScanner.js";

const WORKSPACE = "/workspace/project";

let tempDir: string;
let sessionDir: string;
let entryCounter: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-summary-scanner-test-"));
  sessionDir = join(tempDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  entryCounter = 0;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("session summary scanner parity with the SDK listing", () => {
  it("reports the same summary fields the SDK computes from full transcripts", async () => {
    const richPath = await writeSession("2026-01-01T00-00-00-000Z_rich.jsonl", [
      headerLine({ id: "rich", cwd: WORKSPACE, parentSession: "/parents/rich-parent.jsonl" }),
      messageLine({ role: "user", content: textContent("Fix the login bug") }),
      messageLine({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "On it" }] }),
      messageLine({ role: "user", content: [{ type: "toolResult", toolCallId: "call-1", content: "ok" }] }),
      sessionInfoLine("First name"),
      messageLine({ role: "assistant", content: textContent("Done") }),
      sessionInfoLine("Renamed session"),
      JSON.stringify({ type: "custom", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:03:00.000Z", customType: "note" }),
      sessionInfoLine(""),
      messageLine({ role: "user", content: textContent("second question") }),
    ]);
    const namedPath = await writeSession("2026-01-02T00-00-00-000Z_named.jsonl", [
      headerLine({ id: "named", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant speaks first") }),
      messageLine({ role: "user", content: [] }),
      messageLine({ role: "user", content: "string content" }),
      sessionInfoLine("Kept name"),
    ]);

    const [sdkSessions, scannedSessions] = await Promise.all([SessionManager.listAll(sessionDir), scanSessionSummariesInDir(sessionDir)]);

    expect(scannedSessions.map((session) => session.path).sort()).toEqual([richPath, namedPath]);
    for (const scanned of scannedSessions) {
      const sdk = sdkSessions.find((candidate) => candidate.path === scanned.path);
      expect(sdk, `SDK listing includes ${scanned.path}`).toBeDefined();
      if (sdk === undefined) continue;
      expect(scanned.id).toBe(sdk.id);
      expect(scanned.cwd).toBe(sdk.cwd);
      expect(scanned.created.getTime()).toBe(sdk.created.getTime());
      expect(scanned.messageCount).toBe(sdk.messageCount);
      expect(scanned.firstMessage).toBe(sdk.firstMessage);
      expect(scanned.name).toBe(sdk.name);
      expect(scanned.parentSessionPath).toBe(sdk.parentSessionPath);
    }

    const rich = scannedSessions.find((session) => session.id === "rich");
    expect(rich).toMatchObject({ messageCount: 5, firstMessage: "Fix the login bug" });
    // Rename then explicit clear: the latest session_info wins, empty clears.
    expect(rich?.name).toBeUndefined();
    // Transcript text is never assembled by the scanner.
    expect(rich?.allMessagesText).toBe("");
  });

  it("uses the file mtime as the listing's modified time", async () => {
    const path = await writeSession("2026-01-01T00-00-00-000Z_mtimed.jsonl", [
      headerLine({ id: "mtimed", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("hello") }),
    ]);
    const pinned = new Date("2026-02-03T04:05:06.000Z");
    await utimes(path, pinned, pinned);

    const summary = await scanSessionFileSummary(path);

    expect(summary?.modified.getTime()).toBe(pinned.getTime());
    expect(summary?.modified.getTime()).toBe((await stat(path)).mtime.getTime());
  });

  it("sorts listings by modified (mtime) descending", async () => {
    const ids = ["oldest", "newest", "middle"] as const;
    for (const id of ids) {
      await writeSession(`2026-01-01T00-00-00-000Z_${id}.jsonl`, [headerLine({ id, cwd: WORKSPACE })]);
    }
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_oldest.jsonl"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_newest.jsonl"), new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    await utimes(join(sessionDir, "2026-01-01T00-00-00-000Z_middle.jsonl"), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

    const sessions = await scanSessionSummariesInDir(sessionDir);

    expect(sessions.map((session) => session.id)).toEqual(["newest", "middle", "oldest"]);
  });
});

describe("session summary scanner name handling", () => {
  it("keeps the latest non-empty session_info name", async () => {
    const path = await writeSession("renamed.jsonl", [
      headerLine({ id: "renamed", cwd: WORKSPACE }),
      sessionInfoLine("First"),
      sessionInfoLine("Second"),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ name: "Second" });
  });

  it("treats empty, whitespace-only, and missing names as clears", async () => {
    for (const clear of ["", "   ", undefined]) {
      const suffix = clear === undefined ? "missing" : `len-${String(clear.length)}`;
      const path = await writeSession(`cleared-${suffix}.jsonl`, [
        headerLine({ id: `cleared-${suffix}`, cwd: WORKSPACE }),
        sessionInfoLine("Visible"),
        sessionInfoLine(clear),
      ]);
      expect((await scanSessionFileSummary(path))?.name, `name ${JSON.stringify(clear)} clears`).toBeUndefined();
    }
  });

  it("trims surrounding whitespace from kept names", async () => {
    const path = await writeSession("trimmed.jsonl", [headerLine({ id: "trimmed", cwd: WORKSPACE }), sessionInfoLine("  Padded name  ")]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ name: "Padded name" });
  });
});

describe("session summary scanner first message extraction", () => {
  it("takes the first user message with text, ignoring earlier assistant messages", async () => {
    const path = await writeSession("first-user.jsonl", [
      headerLine({ id: "first-user", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("assistant speaks first") }),
      messageLine({ role: "user", content: textContent("the real first message") }),
      messageLine({ role: "user", content: textContent("later") }),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ firstMessage: "the real first message", messageCount: 3 });
  });

  it("skips user messages without text content when finding the first message", async () => {
    const path = await writeSession("tool-first.jsonl", [
      headerLine({ id: "tool-first", cwd: WORKSPACE }),
      messageLine({ role: "user", content: [{ type: "toolResult", toolCallId: "call-1", content: "output" }] }),
      messageLine({ role: "user", content: [] }),
      messageLine({ role: "user", content: textContent("typed later") }),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ firstMessage: "typed later", messageCount: 3 });
  });

  it("joins multiple text blocks with a space like the SDK", async () => {
    const path = await writeSession("multi-block.jsonl", [
      headerLine({ id: "multi-block", cwd: WORKSPACE }),
      messageLine({ role: "user", content: [{ type: "text", text: "part one" }, { type: "image", url: "x" }, { type: "text", text: "part two" }] }),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ firstMessage: "part one part two" });
  });

  it("falls back to the SDK's placeholder when no user message has text", async () => {
    const path = await writeSession("no-text.jsonl", [
      headerLine({ id: "no-text", cwd: WORKSPACE }),
      messageLine({ role: "assistant", content: textContent("only assistant") }),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ firstMessage: "(no messages)", messageCount: 1 });
  });
});

describe("session summary scanner edge cases", () => {
  it("skips empty files", async () => {
    const path = await writeSession("empty.jsonl", []);

    expect(await scanSessionFileSummary(path)).toBeUndefined();
    expect(await scanSessionSummariesInDir(sessionDir)).toEqual([]);
  });

  it("skips files whose first parseable entry is not a session header", async () => {
    const path = await writeSession("message-first.jsonl", [
      messageLine({ role: "user", content: textContent("orphan") }),
      headerLine({ id: "late-header", cwd: WORKSPACE }),
    ]);

    expect(await scanSessionFileSummary(path)).toBeUndefined();
  });

  it("skips unparseable files but still finds a header after blank or garbage lines", async () => {
    await writeSession("garbage.jsonl", ["not json at all"]);
    const latePath = await writeSession("late-header.jsonl", ["", "also not json", headerLine({ id: "late", cwd: WORKSPACE }), messageLine({ role: "user", content: textContent("hi") })]);

    expect(await scanSessionFileSummary(join(sessionDir, "garbage.jsonl"))).toBeUndefined();
    expect(await scanSessionFileSummary(latePath)).toMatchObject({ id: "late", messageCount: 1, firstMessage: "hi" });
  });

  it("skips headers without a usable string id instead of listing broken sessions", async () => {
    const path = await writeSession("no-id.jsonl", [JSON.stringify({ type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: WORKSPACE })]);

    expect(await scanSessionFileSummary(path)).toBeUndefined();
  });

  it("lists headers without a cwd with an empty cwd for the gateway filter to drop", async () => {
    const path = await writeSession("legacy.jsonl", [headerLine({ id: "legacy" })]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ id: "legacy", cwd: "" });
  });

  it("does not count a message line truncated mid-write", async () => {
    const path = await writeSession("truncated.jsonl", [headerLine({ id: "truncated", cwd: WORKSPACE }), '{"type":"message","id":"half-written"']);

    expect(await scanSessionFileSummary(path)).toMatchObject({ id: "truncated", messageCount: 0, firstMessage: "(no messages)" });
  });

  it("falls back to parsing lines whose key order does not start with the type", async () => {
    const path = await writeSession("reordered.jsonl", [
      headerLine({ id: "reordered", cwd: WORKSPACE }),
      JSON.stringify({ id: "m1", type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "reordered first" } }),
      JSON.stringify({ name: "Late name", type: "session_info", timestamp: "2026-01-01T00:02:00.000Z" }),
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ messageCount: 1, firstMessage: "reordered first", name: "Late name" });
  });

  it("keeps huge tool-result lines from leaking into the summary without parsing them", async () => {
    const sessionInfoDecoy = '{"type":"session_info","name":"hijacked"}';
    const messageDecoy = '{"type":"message","id":"fake"}';
    const padding = "x".repeat(3 * 1024 * 1024);
    const path = await writeSession("huge.jsonl", [
      headerLine({ id: "huge", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      messageLine({ role: "assistant", content: [{ type: "toolResult", toolCallId: "call-big", content: `${sessionInfoDecoy}\n${padding}\n${messageDecoy}` }] }),
      messageLine({ role: "user", content: textContent("later") }),
    ]);

    const summary = await scanSessionFileSummary(path);

    expect(summary).toMatchObject({ id: "huge", messageCount: 3, firstMessage: "start" });
    expect(summary?.name).toBeUndefined();
  });

  it("classifies message lines after the first user message by shape, without validating them", async () => {
    // A raw tab makes this line invalid JSON: a parsing scanner would reject it.
    // The fast path classifies by the leading type key and trailing brace
    // alone, so it is still counted — proof that bodies after the first user
    // message are never parsed. (SDK-written files are always valid JSON, so
    // this never diverges from the SDK on real transcripts.)
    const invalidBody = '{"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"text","text":"has\traw tab"}]}}';
    const path = await writeSession("unvalidated.jsonl", [
      headerLine({ id: "unvalidated", cwd: WORKSPACE }),
      messageLine({ role: "user", content: textContent("start") }),
      invalidBody,
    ]);

    expect(await scanSessionFileSummary(path)).toMatchObject({ id: "unvalidated", messageCount: 2, firstMessage: "start" });
  });

  it("lists nothing when the session directory does not exist", async () => {
    expect(await scanSessionSummariesInDir(join(tempDir, "missing"))).toEqual([]);
  });
});

function nextEntryId(): string {
  entryCounter += 1;
  return `entry-${String(entryCounter)}`;
}

function headerLine(header: { id: string; cwd?: string; parentSession?: string }): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: header.id,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
  });
}

function messageLine(message: { role: string; content: unknown }): string {
  return JSON.stringify({ type: "message", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message });
}

function sessionInfoLine(name: string | undefined): string {
  return JSON.stringify({ type: "session_info", id: nextEntryId(), parentId: "root", timestamp: "2026-01-01T00:02:00.000Z", ...(name === undefined ? {} : { name }) });
}

function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

async function writeSession(fileName: string, lines: readonly string[]): Promise<string> {
  const path = join(sessionDir, fileName);
  await writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return path;
}
