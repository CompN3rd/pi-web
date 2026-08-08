#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

export const RESEARCH_PILOT_PORTS = Object.freeze({ api: 8604, ui: 8605, sessiond: 8606 });

export function researchPilotPaths(env = process.env, home = homedir()) {
  const appData = env.LOCALAPPDATA || env.XDG_STATE_HOME || join(home, ".local", "state");
  const root = resolve(appData, "pi-web-research-pilot");
  const sharedAgentDir = resolve(env.PI_WEB_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"));
  return {
    root,
    dataDir: join(root, "data"),
    configPath: join(root, "config.json"),
    sessionDir: join(root, "sessions"),
    sharedAgentDir,
  };
}

export function researchPilotEnvironment(baseEnv = process.env, paths = researchPilotPaths(baseEnv), ports = RESEARCH_PILOT_PORTS) {
  return {
    ...baseEnv,
    PI_WEB_DATA_DIR: paths.dataDir,
    PI_WEB_CONFIG: paths.configPath,
    PI_WEB_AGENT_DIR: paths.sharedAgentDir,
    PI_WEB_AGENT_SESSION_DIR: paths.sessionDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
    PI_WEB_PORT: String(ports.api),
    PI_WEB_SESSIOND_HOST: "127.0.0.1",
    PI_WEB_SESSIOND_PORT: String(ports.sessiond),
    PI_WEB_SESSIOND_URL: `http://127.0.0.1:${String(ports.sessiond)}`,
  };
}

export function researchPilotCommands(
  npmExecutable,
  ports = RESEARCH_PILOT_PORTS,
  runtime = { platform: process.platform, nodeExecutable: process.execPath, npmExecPath: process.env.npm_execpath },
) {
  const invocation = npmExecutable === undefined
    ? defaultNpmInvocation(runtime)
    : { command: npmExecutable, prefix: [] };
  const command = (label, args) => ({ label, command: invocation.command, args: [...invocation.prefix, ...args] });
  const webScript = runtime.platform === "win32" ? "start" : "dev:web";
  return [
    command("session daemon", ["run", "start:sessiond"]),
    command("web/API", ["run", webScript]),
    command("Vite UI", ["run", "dev:client", "--", "--host", "127.0.0.1", "--port", String(ports.ui)]),
  ];
}

function defaultNpmInvocation(runtime) {
  if (runtime.platform !== "win32") return { command: "npm", prefix: [] };
  // Node 24 rejects direct shell:false spawning of .cmd shims with EINVAL.
  // Invoke npm's JavaScript entry through the current Node executable instead.
  const npmExecPath = runtime.npmExecPath ?? join(dirname(runtime.nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
  return { command: runtime.nodeExecutable, prefix: [npmExecPath] };
}

export async function portIsAvailable(port, host = "127.0.0.1", connect = createConnection) {
  return await new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const finish = (available) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(available);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => finish(false));
  });
}

export async function assertResearchPilotPortsAvailable(ports = RESEARCH_PILOT_PORTS, checker = portIsAvailable) {
  const occupied = [];
  for (const [label, port] of Object.entries(ports)) {
    if (!await checker(port)) occupied.push(`${label} ${String(port)}`);
  }
  if (occupied.length > 0) throw new Error(`Research-pilot ports are occupied: ${occupied.join(", ")}. Nothing was stopped.`);
}

export async function stopPilotChildren(children, platform = process.platform, killTree = defaultWindowsKillTree) {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.killed) return;
    if (platform === "win32" && child.pid !== undefined) {
      await killTree(child.pid);
      return;
    }
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } else {
      child.kill("SIGTERM");
    }
  }));
}

export async function runResearchPilot(options = {}) {
  const rootDir = options.rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = options.paths ?? researchPilotPaths(options.env);
  const ports = options.ports ?? RESEARCH_PILOT_PORTS;
  await (options.preflight ?? assertResearchPilotPortsAvailable)(ports);
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(dirname(paths.configPath), { recursive: true });

  const childEnv = researchPilotEnvironment(options.env ?? process.env, paths, ports);
  const spawnImpl = options.spawnImpl ?? spawn;
  const stopChildren = options.stopChildren ?? stopPilotChildren;
  const commands = researchPilotCommands(options.npmExecutable, ports);
  const children = [];
  try {
    for (const { command, args } of commands) {
      children.push(spawnImpl(command, args, {
        cwd: rootDir,
        env: childEnv,
        stdio: "inherit",
        shell: false,
        detached: process.platform !== "win32",
      }));
    }
  } catch (error) {
    await stopChildren(children);
    throw error;
  }

  console.warn("[research-pilot] ISOLATED: ports, PI WEB data/config, socket/TCP endpoint, and agent session directory.");
  console.warn(`[research-pilot] SHARED: agent auth/settings/packages/providers at ${paths.sharedAgentDir}. Do not install, remove, or update Pi packages from this pilot.`);
  console.log(`[research-pilot] UI: http://127.0.0.1:${String(ports.ui)}  API: ${String(ports.api)}  sessiond: ${String(ports.sessiond)}`);

  return await new Promise((resolvePromise, reject) => {
    let stopping = false;
    let settled = false;
    let failurePending = false;
    let remaining = children.length;
    const cleanupSignals = () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const settleFailure = (error) => {
      if (settled || stopping) return;
      stopping = true;
      failurePending = true;
      void stopChildren(children).then(() => {
        if (settled) return;
        settled = true;
        cleanupSignals();
        reject(error);
      }, (stopError) => {
        if (settled) return;
        settled = true;
        cleanupSignals();
        reject(new AggregateError([error, stopError], "Research-pilot startup failed and sibling shutdown also failed"));
      });
    };
    const onSignal = () => {
      if (settled || stopping) return;
      stopping = true;
      void stopChildren(children).catch((error) => {
        if (settled) return;
        settled = true;
        cleanupSignals();
        reject(error);
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    children.forEach((child, index) => {
      const label = commands[index]?.label ?? `child ${String(index + 1)}`;
      child.on("error", (error) => {
        console.error(`[research-pilot] ${label} failed:`, error);
        settleFailure(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("exit", (code, signal) => {
        remaining -= 1;
        if (!stopping) {
          settleFailure(new Error(`Research-pilot ${label} exited (${signal ?? String(code)})`));
          return;
        }
        if (remaining === 0 && !settled && !failurePending) {
          settled = true;
          cleanupSignals();
          resolvePromise();
        }
      });
    });
  });
}

async function defaultWindowsKillTree(pid) {
  await new Promise((resolvePromise) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    child.once("exit", () => resolvePromise());
    child.once("error", () => resolvePromise());
  });
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runResearchPilot().catch((error) => {
    console.error(`[research-pilot] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
