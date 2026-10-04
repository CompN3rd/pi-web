import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerPluginActivationContext, ServerPluginPeerRequestContext } from "@jmfederico/pi-web/server-plugin-api";
import { requestGit } from "../src/server.js";
import { snapshot } from "../src/browser/model.js";

function request(input: ServerPluginPeerRequestContext["input"], operation = "diff"): ServerPluginPeerRequestContext {
  return { operation, input, project: { id: "p", name: "P", path: "/repo" }, workspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true }, signal: new AbortController().signal };
}
const success = { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };

describe("read-only Git peer", () => {
  it("uses host-resolved workspace, literal argv paths, no external drivers, and cancellation", async () => {
    const exec = vi.fn<ServerPluginActivationContext["execFile"]>().mockResolvedValue({ ...success, stdout: "diff" });
    const input = request({ path: "odd ' $(touch nope).ts", source: "git-staged", cwd: "/attacker" });
    expect(await requestGit(exec, input)).toBe("diff");
    const call = exec.mock.calls[0]?.[0];
    expect(call?.cwd).toBe("/repo"); expect(call?.signal).toBe(input.signal);
    expect(call?.args).toEqual(["--literal-pathspecs", "-C", "/repo", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--submodule=short", "--relative", "--cached", "--unified=3", "--", "odd ' $(touch nope).ts"]);
    expect(call?.unsetEnv).toContain("GIT_DIR"); expect(call?.unsetEnv).toContain("GIT_INDEX_FILE");
  });
  it.each(["../secret", "/secret", "C:/secret", "a\\b", "a\0b", "a/../b"])("rejects unsafe path %s before executing", async (path) => {
    const exec = vi.fn<ServerPluginActivationContext["execFile"]>();
    await expect(requestGit(exec, request({ source: "git-unstaged", path }))).rejects.toThrow("Invalid workspace-relative");
    expect(exec).not.toHaveBeenCalled();
  });
  it("preserves NUL-separated filenames and rejects truncated output and bad operations", async () => {
    const exec = vi.fn<ServerPluginActivationContext["execFile"]>().mockResolvedValue({ ...success, stdout: "has space.ts\0日本語.ts\0" });
    expect(await requestGit(exec, request({ source: "git-unstaged" }, "changes"))).toEqual(["has space.ts", "日本語.ts"]);
    exec.mockResolvedValue({ ...success, stdoutTruncated: true });
    await expect(requestGit(exec, request({ source: "git-staged" }, "changes"))).rejects.toThrow("host limit");
    await expect(requestGit(exec, request({ source: "git-staged" }, "reset"))).rejects.toThrow("Unknown");
  });
});

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it("reads staged and unstaged snapshots from a real Git repository without modifying its index", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-plugin-")); temporary.push(root);
  const exec = promisify(nodeExecFile);
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init");
  await writeFile(join(root, "a.ts"), "base\n"); await git("add", "a.ts");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "base");
  await writeFile(join(root, "a.ts"), "staged\n"); await git("add", "a.ts");
  await writeFile(join(root, "a.ts"), "working\n");
  const adapter: ServerPluginActivationContext["execFile"] = async ({ file, args, signal }) => {
    const result = await exec(file, [...args ?? []], { signal });
    return { ...success, stdout: result.stdout, stderr: result.stderr };
  };
  const staged = request({ source: "git-staged", path: "a.ts" });
  const scope = { ...staged, workspace: { ...staged.workspace, path: root } };
  expect(await requestGit(adapter, scope)).toContain("+staged");
  expect(await requestGit(adapter, { ...scope, input: { source: "git-unstaged", path: "a.ts" } })).toContain("+working");
  expect((await git("show", ":a.ts")).stdout).toBe("staged\n");
}, 20_000);

it("overrides diff.submodule=diff so nested file coordinates never enter the gitlink snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-submodule-")); temporary.push(root);
  const child = join(root, "child"); await mkdir(child);
  const exec = promisify(nodeExecFile);
  const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args]);
  const commit = (cwd: string) => git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "snapshot");
  await git(root, "init"); await git(child, "init");
  await writeFile(join(child, "nested.ts"), "before\n"); await git(child, "add", "."); await commit(child);
  await git(root, "add", "child"); await commit(root);
  await writeFile(join(child, "nested.ts"), "after\n"); await git(child, "add", "."); await commit(child);
  await git(root, "config", "diff.submodule", "diff");
  expect((await git(root, "diff")).stdout).toContain("nested.ts");
  const adapter: ServerPluginActivationContext["execFile"] = async ({ file, args, signal }) => {
    const result = await exec(file, [...args ?? []], { signal });
    return { ...success, stdout: result.stdout, stderr: result.stderr };
  };
  const input = request({ source: "git-unstaged", path: "child" });
  const output = await requestGit(adapter, { ...input, workspace: { ...input.workspace, path: root } });
  expect(output).toEqual(expect.stringContaining("Subproject commit"));
  expect(output).not.toContain("nested.ts");
  if (typeof output !== "string") throw new Error("Expected a diff");
  expect(snapshot("child", "git-unstaged", output).rows.filter((row) => row.line !== undefined).every((row) => row.line === 1)).toBe(true);
}, 20_000);
