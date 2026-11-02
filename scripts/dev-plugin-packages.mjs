#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const cwd = process.cwd();
const pluginsRoot = resolve(cwd, "plugins");
const devPackages = await findPluginPackagesWithDevScripts(pluginsRoot);
const children = new Set();
let stopping = false;

process.on("SIGINT", () => { stopAndExit(130); });
process.on("SIGTERM", () => { stopAndExit(143); });

if (devPackages.length === 0) {
  console.log("[plugin-packages] no plugin package dev scripts found");
  await stayAlive();
}

for (const packageInfo of devPackages) startPackageDev(packageInfo);
console.log(`[plugin-packages] watching ${String(devPackages.length)} plugin package${devPackages.length === 1 ? "" : "s"}`);

await stayAlive();

async function findPluginPackagesWithDevScripts(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(root, entry.name);
    const packageInfo = await readPluginPackageInfo(dir);
    if (packageInfo !== undefined) packages.push(packageInfo);
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function readPluginPackageInfo(dir) {
  const packagePath = resolve(dir, "package.json");
  const content = await readFile(packagePath, "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  const parsed = JSON.parse(content);
  if (!isRecord(parsed)) return undefined;
  const scripts = parsed["scripts"];
  if (!isRecord(scripts) || typeof scripts["dev"] !== "string") return undefined;
  const rawName = parsed["name"];
  return { dir, name: typeof rawName === "string" && rawName !== "" ? rawName : relative(cwd, dir) };
}

function startPackageDev(packageInfo) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: packageInfo.dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  pipeWithPrefix(child.stdout, process.stdout, `[${packageInfo.name}]`);
  pipeWithPrefix(child.stderr, process.stderr, `[${packageInfo.name}]`);
  child.on("error", (error) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[plugin-packages] failed to start ${packageInfo.name} dev: ${error instanceof Error ? error.message : String(error)}`);
    stopAndExit(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    const reason = signal === null ? `code ${String(code ?? 0)}` : `signal ${signal}`;
    console.error(`[plugin-packages] ${packageInfo.name} dev exited with ${reason}`);
    stopAndExit(code === null || code === 0 ? 1 : code);
  });
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

function stopAndExit(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => { process.exit(code); }, 100);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function stayAlive() {
  await new Promise(() => undefined);
}
