import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";

const script = resolve("scripts/dev-plugin-packages.mjs");
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => { child.once("exit", () => { done(); }); });
    child.kill("SIGTERM");
    await exited;
  }));
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

it("rediscovers package manifests, retains invalid edits and cleans up replaced process groups", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "plugin-package-watch-"));
  directories.push(cwd);
  const child = spawn(process.execPath, [script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  await expect.poll(() => output).toContain("watching package manifests");

  const dir = resolve(cwd, "plugins/example");
  const manifest = resolve(dir, "package.json");
  const heartbeat = (name: string) => readFile(resolve(cwd, `${name}.txt`), "utf8").catch(() => "");
  const setManifest = (name: string) => writeFile(manifest, JSON.stringify({
    name: "example", scripts: { dev: `node watcher.mjs ${name}` },
  }));
  await mkdir(dir, { recursive: true });
  // Ignore TERM deliberately: npm may exit first but its descendant must not
  // survive replacement or supervisor shutdown and keep writing build output.
  const watcherSource = `
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const file = resolve('../..', process.argv[2] + '.txt');
process.on('SIGTERM', () => {});
setInterval(() => appendFileSync(file, 'x'), 50);
`;
  await writeFile(resolve(dir, "watcher.mjs"), watcherSource);
  await setManifest("first");
  await expect.poll(() => heartbeat("first"), { timeout: 10_000 }).not.toBe("");
  const otherDir = resolve(cwd, "plugins/other");
  await mkdir(otherDir);
  await writeFile(resolve(otherDir, "watcher.mjs"), watcherSource);
  await writeFile(resolve(otherDir, "package.json"), JSON.stringify({
    name: "other", scripts: { dev: "node watcher.mjs other" },
  }));
  await expect.poll(() => heartbeat("other"), { timeout: 10_000 }).not.toBe("");

  await writeFile(manifest, "{");
  await expect.poll(() => output).toContain("retaining existing watchers");
  const before = await heartbeat("first");
  await expect.poll(() => heartbeat("first")).not.toBe(before);
  expect(child.exitCode, output).toBeNull();

  await setManifest("second");
  await expect.poll(() => heartbeat("second"), { timeout: 10_000 }).not.toBe("");
  const stoppedFirst = await heartbeat("first");
  await delay(700);
  expect(await heartbeat("first")).toBe(stoppedFirst);

  // A valid manifest without a dev script stops the old watcher.
  await writeFile(manifest, JSON.stringify({ name: "example" }));
  await expect.poll(() => output.split("stopped example dev").length, { timeout: 10_000 }).toBe(3);
  const stoppedSecond = await heartbeat("second");
  await delay(700);
  expect(await heartbeat("second")).toBe(stoppedSecond);
  expect(output.split("starting other dev")).toHaveLength(2);
  const otherBefore = await heartbeat("other");
  await expect.poll(() => heartbeat("other")).not.toBe(otherBefore);

  await setManifest("third");
  await expect.poll(() => heartbeat("third"), { timeout: 10_000 }).not.toBe("");
  await rm(resolve(cwd, "plugins"), { recursive: true });
  await expect.poll(() => output.split("stopped example dev").length, { timeout: 10_000 }).toBe(4);
  const stoppedThird = await heartbeat("third");
  await delay(700);
  expect(await heartbeat("third")).toBe(stoppedThird);
  expect(child.exitCode, output).toBeNull();

  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "watcher.mjs"), watcherSource);
  await setManifest("fourth");
  await expect.poll(() => heartbeat("fourth"), { timeout: 10_000 }).not.toBe("");
  const exited = new Promise<void>((done) => { child.once("exit", () => { done(); }); });
  child.kill("SIGTERM");
  await exited;
  const stoppedFourth = await heartbeat("fourth");
  await delay(700);
  expect(await heartbeat("fourth")).toBe(stoppedFourth);
}, 30_000);
