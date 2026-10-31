import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { developmentRuntimeEnvironment, startDevelopmentProcess } from "./dev-processes.mjs";
import { runDevelopmentClient } from "./dev-client.mjs";
import { runDevelopmentWeb } from "./dev-web.mjs";
import { runDevelopmentSessiond, waitForPluginBuild } from "./dev-sessiond.mjs";

function harness() {
  const signals = new EventEmitter();
  const children = [];
  const launch = vi.fn(() => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.finish = (code) => { child.exitCode = code; child.emit("exit", code, null); };
    children.push(child);
    return child;
  });
  const stop = vi.fn(child => child.finish(0));
  return { signals, children, launch, stop, env: {} };
}

it("starts one builder, waits for publication, then starts the API without rebuilding", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  expect(options.launch).toHaveBeenCalledTimes(1);
  const builder = options.children[0];
  expect(options.launch.mock.calls[0][1]).toEqual(["--watch"]);
  builder.emit("message", { type: "plugin-build-ready" });
  builder.emit("message", { type: "plugin-build-ready" });
  expect(options.launch).toHaveBeenCalledTimes(2);
  expect(options.launch.mock.calls[1][1]).toEqual(["watch", "src/server/index.ts"]);
  builder.finish(1);
  expect(await running).toBe(1);
  expect(options.stop).toHaveBeenCalledWith(options.children[1]);
});

it.each([
  [undefined, "1"],
  ["0", "0"],
  ["1", "1"],
  ["", ""],
])("passes dev plugin pairing %s to children as %s without changing the parent environment", async (configured, expected) => {
  const options = harness();
  options.env = configured === undefined ? {} : { PI_WEB_DEV_PLUGIN_PAIRING: configured };
  const originalEnv = { ...options.env };
  const running = runDevelopmentWeb(options);
  options.children[0].emit("message", { type: "plugin-build-ready" });
  expect(options.launch).toHaveBeenCalledTimes(2);
  for (const call of options.launch.mock.calls) {
    expect(call[2].PI_WEB_DEV_PLUGIN_PAIRING).toBe(expected);
  }
  expect(options.env).toEqual(originalEnv);
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it("launches a build process in its requested directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-build-cwd-"));
  const child = startDevelopmentProcess("-e", ["process.send(process.cwd())"], process.env, { ipc: true, cwd });
  try {
    const exited = once(child, "exit");
    const [reportedCwd] = await once(child, "message");
    expect(await exited).toEqual([0, null]);
    // Windows process.cwd() can retain an 8.3 alias; compare canonical paths.
    expect(await realpath(reportedCwd)).toBe(await realpath(cwd));
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("builds through the Docker source mount without changing API runtime cwd", async () => {
  const options = harness();
  options.env = { PI_WEB_DOCKER_MODE: "dev", PI_WEB_DOCKER_DEV_REPO_ROOT: "/host-checkout/node_modules/pi-web" };
  const running = runDevelopmentWeb(options);
  expect(options.launch.mock.calls[0][3]).toEqual({ ipc: true, cwd: "/build/pi-web" });
  options.children[0].emit("message", { type: "plugin-build-ready" });
  expect(options.launch.mock.calls[1][3]).toBeUndefined();
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it.skipIf(process.platform === "win32")("pins runtime Node independently of the PATH used by runtime subprocesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-runtime-tools-"));
  let child;
  try {
    await writeFile(join(root, "node"), "#!/bin/sh\nprintf 'user-selected-node'\n");
    await chmod(join(root, "node"), 0o755);
    const env = developmentRuntimeEnvironment({
      ...process.env,
      PATH: "/lifecycle/node:/npm/bin",
      PI_WEB_SERVICE_ORIGINAL_PATH: root,
      PI_WEB_DEV_SUPERVISED: "1",
    });
    child = startDevelopmentProcess("-e", [
      `const { spawnSync } = require('node:child_process');
const tool = spawnSync('node', [], { encoding: 'utf8' });
process.send({ executable: process.execPath, tool: tool.stdout, path: process.env.PATH, snapshot: process.env.PI_WEB_SERVICE_ORIGINAL_PATH, group: process.env.PI_WEB_DEV_SUPERVISED });`,
    ], env, { ipc: true });
    const exited = once(child, "exit");
    const [report] = await once(child, "message");
    expect(await exited).toEqual([0, null]);
    expect(report).toEqual({ executable: process.execPath, tool: "user-selected-node", path: root });
  } finally {
    if (child?.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps lifecycle tooling pinned but restores the API's original tool environment", async () => {
  const options = harness();
  options.env = { PATH: "/pinned/node:/npm/bin:/user/tools", PI_WEB_SERVICE_ORIGINAL_PATH: "/user/tools" };
  const running = runDevelopmentWeb(options);
  options.children[0].emit("message", { type: "plugin-build-ready" });
  expect(options.launch.mock.calls[0][2]).toMatchObject(options.env);
  expect(options.launch.mock.calls[1][2]).toEqual({ PATH: "/user/tools", PI_WEB_DEV_PLUGIN_PAIRING: "1" });
  expect(options.env.PI_WEB_SERVICE_ORIGINAL_PATH).toBe("/user/tools");
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it("restores the daemon's tool environment without changing the launcher environment", async () => {
  const options = harness();
  options.env = { PATH: "/pinned/node:/npm/bin:/user/tools", PI_WEB_SERVICE_ORIGINAL_PATH: "/user/tools" };
  const running = runDevelopmentSessiond({ ...options, wait: () => Promise.resolve() });
  await vi.waitFor(() => expect(options.launch).toHaveBeenCalledOnce());
  expect(options.launch.mock.calls[0][2]).toEqual({ PATH: "/user/tools" });
  expect(options.env.PI_WEB_SERVICE_ORIGINAL_PATH).toBe("/user/tools");
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it.each([{ PATH: "/local/tools" }, { PATH: "/pinned", PI_WEB_SERVICE_ORIGINAL_PATH: "" }])("preserves local and empty tooling PATH contracts (%j)", (env) => {
  const original = { ...env };
  const runtime = developmentRuntimeEnvironment(env);
  expect(runtime.PATH).toBe(original.PI_WEB_SERVICE_ORIGINAL_PATH ?? original.PATH);
  expect(runtime).not.toHaveProperty("PI_WEB_SERVICE_ORIGINAL_PATH");
  expect(env).toEqual(original);
});

it.each([undefined, "dev"])("launches Vite through the selected Node with the source cwd for Docker (%s)", async (mode) => {
  const options = harness();
  options.env = mode === undefined ? {} : { PI_WEB_DOCKER_MODE: mode };
  const running = runDevelopmentClient(["--host", "0.0.0.0"], options);
  expect(options.launch.mock.calls[0][0]).toMatch(/vite[/\\\\]bin[/\\\\]vite\.js$/u);
  expect(options.launch.mock.calls[0][1]).toEqual(["--host", "0.0.0.0"]);
  expect(options.launch.mock.calls[0][3]).toEqual(mode === "dev" ? { cwd: "/build/pi-web" } : undefined);
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it("does not start the API when the initial build fails", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  options.children[0].finish(1);
  expect(await running).toBe(1);
  expect(options.launch).toHaveBeenCalledTimes(1);
});

it("stops the builder when the API exits or the web owner is stopped", async () => {
  const options = harness();
  const running = runDevelopmentWeb(options);
  options.children[0].emit("message", { type: "plugin-build-ready" });
  options.children[1].finish(1);
  expect(await running).toBe(1);
  expect(options.stop).toHaveBeenCalledWith(options.children[0]);
  const stopped = harness();
  const stopping = runDevelopmentWeb(stopped);
  stopped.signals.emit("SIGTERM");
  expect(await stopping).toBe(143);
  expect(stopped.stop).toHaveBeenCalledWith(stopped.children[0]);
});

it("starts sessiond only after build readiness without starting another builder", async () => {
  const options = harness();
  let publish;
  const wait = vi.fn(() => new Promise(resolve => { publish = resolve; }));
  const running = runDevelopmentSessiond({ ...options, wait });
  expect(options.launch).not.toHaveBeenCalled();
  publish();
  await vi.waitFor(() => expect(options.launch).toHaveBeenCalledOnce());
  expect(options.launch.mock.calls[0][0]).toBe("src/server/sessiond.ts");
  expect(options.launch.mock.calls[0][1]).toEqual([]);
  expect(options.launch.mock.calls[0][3].execArgv[0]).toBe("--import");
  expect(options.launch.mock.calls[0][2]).toEqual(options.env);
  options.children[0].finish(0);
  expect(await running).toBe(0);
});

it("does not launch sessiond if stopped while readiness is resolving", async () => {
  const options = harness();
  let publish;
  const running = runDevelopmentSessiond({ ...options, wait: () => new Promise(resolve => { publish = resolve; }) });
  options.signals.emit("SIGTERM");
  publish();
  await expect(running).rejects.toMatchObject({ name: "AbortError" });
  expect(options.launch).not.toHaveBeenCalled();
});

it("waits for the cold-start marker and reports a missing builder", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-dev-start-"));
  try {
    await expect(waitForPluginBuild({ cwd, timeoutMs: 0 })).rejects.toThrow("Plugin build not ready");
    const waiting = waitForPluginBuild({ cwd, intervalMs: 1, timeoutMs: 5_000 });
    await mkdir(join(cwd, "dist"));
    await writeFile(join(cwd, "dist", ".plugins-ready"), "ready");
    await waiting;
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPluginBuild({ cwd, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("does not start sessiond after a readiness failure", async () => {
  const options = harness();
  await expect(runDevelopmentSessiond({ ...options, wait: () => Promise.reject(new Error("no build")) })).rejects.toThrow("no build");
  expect(options.launch).not.toHaveBeenCalled();
  expect(options.signals.listenerCount("SIGTERM")).toBe(0);
});
