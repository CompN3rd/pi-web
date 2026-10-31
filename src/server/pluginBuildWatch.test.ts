import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const buildScript = resolve("scripts/build-plugins.mjs");
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

it("rebuilds added, edited, deleted and recreated plugin roots without restarting the watcher", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "plugin-watch-"));
  directories.push(cwd);
  const child = spawn(process.execPath, [buildScript, "--watch"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const source = resolve(cwd, "pi-web-plugins/nested/plugin.ts");
  const built = resolve(cwd, "dist/pi-web-plugins/nested/plugin.js");
  const contents = async () => readFile(built, "utf8").catch(() => "missing");
  const waitForBuild = async (value: string) => {
    await expect.poll(contents, { timeout: 10_000 }).toContain(value);
    expect(child.exitCode, output).toBeNull();
  };

  await expect.poll(() => output, { timeout: 10_000 }).toContain("[plugins] watching");
  await mkdir(resolve(source, ".."), { recursive: true });
  await writeFile(source, "export const value: string = 'first';");
  await waitForBuild("first");
  await writeFile(source, "export const value: string = 'second';");
  await waitForBuild("second");

  // A failed compilation must not destroy the currently served plugin.
  await writeFile(source, "export const value = ;");
  await expect.poll(() => output, { timeout: 10_000 }).toContain("Expression expected");
  expect(await contents()).toContain("second");
  await writeFile(source, "export const value = 'repaired';");
  await waitForBuild("repaired");

  await rm(source);
  await expect.poll(contents, { timeout: 10_000 }).toBe("missing");
  // Wait for the root deletion to be processed before recreating it.
  const builds = () => output.split("[plugins] built").length;
  const previousBuilds = builds();
  await rm(resolve(cwd, "pi-web-plugins"), { recursive: true });
  await expect.poll(builds, { timeout: 10_000 }).toBeGreaterThan(previousBuilds);
  await mkdir(resolve(source, ".."), { recursive: true });
  await writeFile(source, "export const value = 'recreated';");
  await waitForBuild("recreated");
}, 30_000);

it("keeps the session daemon outside the autoreloading development process group", async () => {
  const pkg: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null || !("scripts" in pkg)) throw new Error("Missing scripts");
  const scripts = pkg.scripts;
  if (typeof scripts !== "object" || scripts === null || !("dev" in scripts) || !("dev:sessiond" in scripts)) {
    throw new Error("Missing development scripts");
  }
  expect(scripts.dev).not.toContain("sessiond");
  expect(scripts["dev:sessiond"]).toBe("tsx src/server/sessiond.ts");
});
