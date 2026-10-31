#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const cwd = process.cwd();
const pluginsRoot = resolve(cwd, "plugins");
const children = new Map();
const warnings = new Map();
let stopping = false;
let timer;

process.on("SIGINT", () => { void stopAndExit(130); });
process.on("SIGTERM", () => { void stopAndExit(143); });

console.log("[plugin-packages] watching package manifests");
await reconcile();

// Poll manifests, not package sources: packages own their source watchers. This
// also discovers roots created after startup and avoids watching node_modules.
async function reconcile() {
  try {
    const packages = await discoverPackages();
    if (stopping) return;
    const removals = [];
    for (const [dir, running] of children) {
      const next = packages.get(dir);
      // Invalid/incompletely written manifests retain the current watcher.
      if (next === null || next?.signature === running.info.signature) continue;
      removals.push(stopChild(running).then(() => { children.delete(dir); }));
    }
    await Promise.all(removals);
    for (const [dir, info] of packages) {
      if (stopping) return;
      if (info !== null && !children.has(dir)) startPackageDev(info);
    }
    warnings.delete(pluginsRoot);
  } catch (error) {
    warnOnce(pluginsRoot, error);
  } finally {
    if (!stopping) timer = setTimeout(() => { void reconcile(); }, 500);
  }
}

async function discoverPackages() {
  const entries = await readdir(pluginsRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const packages = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(pluginsRoot, entry.name);
    try {
      const content = await readFile(resolve(dir, "package.json"), "utf8");
      const parsed = JSON.parse(content);
      if (!isRecord(parsed)) throw new Error("package.json must contain an object");
      const scripts = parsed["scripts"];
      if (isRecord(scripts) && typeof scripts["dev"] === "string" && scripts["dev"].trim() !== "") {
        const rawName = parsed["name"];
        packages.set(dir, {
          dir,
          name: typeof rawName === "string" && rawName !== "" ? rawName : relative(cwd, dir),
          signature: content,
        });
      }
      warnings.delete(dir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      packages.set(dir, null);
      warnOnce(dir, error);
    }
  }
  return packages;
}

function warnOnce(path, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (warnings.get(path) === message) return;
  warnings.set(path, message);
  console.error(`[plugin-packages] cannot read ${path}; retaining existing watchers: ${message}`);
}

function startPackageDev(info) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: info.dir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const running = { child, info, expectedExit: false, stopped: undefined };
  children.set(info.dir, running);
  console.log(`[plugin-packages] starting ${info.name} dev`);
  pipeWithPrefix(child.stdout, process.stdout, `[${info.name}]`);
  pipeWithPrefix(child.stderr, process.stderr, `[${info.name}]`);
  child.on("error", (error) => {
    if (stopping || running.expectedExit) return;
    console.error(`[plugin-packages] failed to start ${info.name} dev: ${error.message}`);
    void stopAndExit(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping || running.expectedExit) return;
    const reason = signal === null ? `code ${String(code ?? 0)}` : `signal ${signal}`;
    console.error(`[plugin-packages] ${info.name} dev exited with ${reason}`);
    void stopAndExit(code === null || code === 0 ? 1 : code);
  });
}

function signalChild(child, signal) {
  if (child.pid === undefined) return;
  try {
    // npm launches a shell and a watcher. Signal the owned process group so
    // replacement cannot leave the old watcher writing into the same output.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => { child.kill(signal); });
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function stopChild(running) {
  if (running.stopped !== undefined) return running.stopped;
  running.expectedExit = true;
  running.stopped = new Promise((done) => {
    signalChild(running.child, "SIGTERM");
    // npm can exit before descendants do (including ones with closed stdio).
    // Give the whole group a grace period, then clean up any survivors.
    setTimeout(() => {
      signalChild(running.child, "SIGKILL");
      console.log(`[plugin-packages] stopped ${running.info.name} dev`);
      done();
    }, 1000);
  });
  return running.stopped;
}

function pipeWithPrefix(stream, output, prefix) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) output.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (pending !== "") output.write(`${prefix} ${pending}\n`);
  });
}

async function stopAndExit(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await Promise.all([...children.values()].map(stopChild));
  process.exit(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
