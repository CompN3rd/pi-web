import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { effectivePiWebConfig, isHostAbsoluteAgentDir, PI_CODING_AGENT_DIR_ENV } from "./config.js";
import { detectPiWebInstallation } from "./server/piWebStatus.js";
import { SessionDaemonClient } from "./sessiond/sessionDaemonClient.js";
import type { PiWebInstallationInfo } from "./shared/apiTypes.js";
import { nativeServiceManagerRefs } from "./nativeServices/servicePlan.js";

const PACKAGE_NAME = "@jmfederico/pi-web";
const WARNING = "Updating PI WEB will restart services and interrupt active sessions and terminals, including this terminal.";
const HELP = "Usage: pi-web update [--yes]\nWithout --yes, an interactive confirmation is required. Nested Linux updates require systemd user services and systemd-run. Nested macOS updates are unsupported; use a host terminal outside PI WEB.";

export interface PiWebUpdateCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** All process, profile, filesystem, and confirmation effects are replaceable in tests. */
export interface PiWebUpdateDependencies {
  env: NodeJS.ProcessEnv;
  nodeExecutable: string;
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  uniqueId(): string;
  exists(path: string): boolean;
  piCliPath: string;
  interactive: boolean;
  agentDir(): Promise<string>;
  detectInstallation(agentDir: string): Promise<PiWebInstallationInfo>;
  realpath(path: string): Promise<string>;
  capture(command: PiWebUpdateCommand): Promise<string>;
  run(command: PiWebUpdateCommand): Promise<void>;
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
}

function defaultDependencies(): PiWebUpdateDependencies {
  return {
    env: { ...process.env },
    nodeExecutable: process.execPath,
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    uniqueId: randomUUID,
    exists: existsSync,
    // Use this installation's Pi, not an unrelated (or older) `pi` on PATH.
    piCliPath: fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
    interactive: isatty(0) && isatty(1),
    async agentDir() {
      const active = await new SessionDaemonClient().getActiveAgentProfile();
      if (active.status === "available") return active.profile.dir;
      if (active.status === "invalid") throw new Error(`Cannot safely resolve the active Pi profile: ${active.error}`);
      return effectivePiWebConfig().config.agent.dir;
    },
    detectInstallation: detectPiWebInstallation,
    realpath,
    async capture(command) {
      const result = await promisify(execFile)(command.executable, command.args, { env: command.env, encoding: "utf8" });
      return result.stdout.trim();
    },
    run(command) {
      return new Promise<void>((resolveRun, reject) => {
        const child = spawn(command.executable, command.args, { env: command.env, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolveRun();
          else reject(new Error(`${command.executable} failed (${signal ?? `exit ${String(code)}`}); no further update/restart steps were run.`));
        });
      });
    },
    async confirm(message) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes)$/i.test((await input.question(`${message} [y/N] `)).trim());
      } finally {
        input.close();
      }
    },
    log: console.log,
  };
}

/** CLI arguments exclude `update`. Throws on invalid/unsafe requests and failed commands. */
export async function runPiWebUpdate(args: readonly string[], injected?: PiWebUpdateDependencies): Promise<void> {
  const valid = args.length === 0 || (args.length === 1 && ["--yes", "--help", "-h"].includes(args[0] ?? ""));
  if (!valid) throw new Error(`Invalid update arguments. ${HELP}`);
  const deps = injected ?? defaultDependencies();
  if (args[0] === "--help" || args[0] === "-h") {
    deps.log(HELP);
    return;
  }
  const agentDir = await deps.agentDir();
  if (!isHostAbsoluteAgentDir(agentDir)) throw new Error("Cannot safely resolve the Pi profile: expected a host-absolute directory.");
  const installation = await deps.detectInstallation(agentDir);
  if (installation.kind === "local" || installation.kind === "unknown") {
    deps.log("No automatic update for local/unknown installations. Update using the checkout or installation's original tooling, then run pi-web restart from a host terminal. Nothing changed.");
    return;
  }
  const nested = truthy(deps.env["PI_WEB_SESSION"]);
  if (installation.kind !== "docker" && nested && deps.platform !== "linux") {
    throw new Error("Native update refused inside a PI WEB session: restarting its daemon could kill the updater. Open a host terminal outside PI WEB and run pi-web update there. --yes does not bypass this safety check.");
  }
  const command = (executable: string, commandArgs: string[], env = deps.env): PiWebUpdateCommand => ({ executable, args: commandArgs, env: { ...env } });
  let update: PiWebUpdateCommand;
  let restart: PiWebUpdateCommand | undefined;
  if (installation.kind === "docker") {
    if (installation.dockerMode !== "runtime" && installation.dockerMode !== "dev") {
      throw new Error("Docker installation mode is unknown. Use the original pi-web-docker host installation to update; nothing changed.");
    }
    update = command("pi-web-docker", [...(installation.dockerMode === "dev" ? ["--dev"] : []), "update"]);
  } else {
    if (installation.path === undefined || !isAbsolute(installation.path)) throw new Error("Cannot safely locate this PI WEB installation; nothing changed.");
    restart = command(deps.nodeExecutable, [join(installation.path, "dist", "cli.js"), "restart"]);
    if (installation.kind === "npm-global") {
      const root = installation.npmRoot;
      if (root === undefined || !isAbsolute(root)) throw new Error("Cannot safely locate this global npm installation; nothing changed.");
      // Unix npm prefixes use lib/node_modules; Windows prefixes use node_modules.
      const prefix = basename(dirname(root)) === "lib" ? dirname(dirname(root)) : dirname(root);
      const actualRoot = await deps.capture(command("npm", ["root", "--global", "--prefix", prefix]));
      if (await deps.realpath(actualRoot) !== await deps.realpath(root)
        || await deps.realpath(join(root, PACKAGE_NAME)) !== await deps.realpath(installation.path)) {
        throw new Error("Global npm target does not match this installation; nothing changed.");
      }
      update = command("npm", ["install", "--global", "--prefix", resolve(prefix), `${PACKAGE_NAME}@latest`, "--allow-scripts=node-pty"]);
    } else {
      if (installation.scope !== "user" || installation.source === undefined || installation.source === "" || !/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(installation.source)) {
        throw new Error("Only user-scope remote Pi packages can be updated automatically. Update this package with its original tooling; nothing changed.");
      }
      // --no-approve excludes project settings even in previously trusted projects.
      // An explicit extension target cannot invoke Pi's universal/self updater.
      update = command(deps.nodeExecutable, [deps.piCliPath, "update", "--no-approve", "--extension", installation.source], {
        ...deps.env, [PI_CODING_AGENT_DIR_ENV]: agentDir,
      });
    }
  }
  let restartUnit: string | undefined;
  if (restart !== undefined) {
    await preflightNativeServices(deps);
    if (nested) {
      restartUnit = `pi-web-update-restart-${deps.uniqueId()}`;
      const dispatchArgs = systemdDispatchArgs(deps);
      // Exercise the same external owner and environment without touching services.
      // --wait is only for this harmless probe, never for the actual restart.
      try {
        await deps.capture(command("systemd-run", [
          ...dispatchArgs, `--unit=${restartUnit}-preflight`, "--wait", "--",
          deps.nodeExecutable, "--eval", "process.exit(0)",
        ]));
      } catch (error) {
        throw new Error("Cannot safely dispatch a detached systemd restart. Use a host terminal outside PI WEB; nothing changed.", { cause: error });
      }
      restart = command("systemd-run", [...dispatchArgs, `--unit=${restartUnit}`, "--", restart.executable, ...restart.args]);
    }
  }
  deps.log(`Update target: ${installation.kind}${installation.path === undefined ? "" : ` at ${JSON.stringify(installation.path)}`}`);
  deps.log(`Install: ${[update.executable, ...update.args].map((value) => JSON.stringify(value)).join(" ")}`);
  if (restart !== undefined) {
    deps.log(`After install succeeds: ${JSON.stringify(deps.nodeExecutable)} ${JSON.stringify(join(installation.path ?? "", "dist", "cli.js"))} restart${restartUnit === undefined ? "" : ` via detached systemd user unit ${restartUnit}`}.`);
  } else {
    deps.log("The Docker installer owns the update and service restart.");
  }
  deps.log(WARNING);
  if (args[0] !== "--yes") {
    if (!deps.interactive) throw new Error("Noninteractive update requires explicit --yes consent. Nothing changed.");
    if (!await deps.confirm("Proceed with the update and restart?")) {
      deps.log("Update cancelled. Nothing changed.");
      return;
    }
  }
  await deps.run(update);
  if (restart !== undefined) {
    await deps.run(restart);
    if (restartUnit !== undefined) deps.log(`Restart dispatched, not verified complete. Inspect journalctl --user -u ${restartUnit}.`);
  }
}

async function preflightNativeServices(deps: PiWebUpdateDependencies): Promise<void> {
  if (deps.platform !== "linux" && deps.platform !== "darwin") throw new Error("Automatic native update requires Linux or macOS services; nothing changed.");
  const installed = Object.entries(nativeServiceManagerRefs).filter(([, ref]) => deps.exists(deps.platform === "linux"
    ? join(deps.home, ".config", "systemd", "user", ref.systemdName)
    : join(deps.home, "Library", "LaunchAgents", ref.launchdPlistName)));
  if (!installed.some(([id]) => id === "sessiond") || !installed.some(([id]) => id === "web" || id === "uiDev")) {
    throw new Error("Native services are missing or incomplete. Run pi-web install from a host terminal, or update manually with the original tooling; nothing changed.");
  }
  if (deps.platform === "linux") {
    for (const [, ref] of installed) {
      const state = await deps.capture({ executable: "systemctl", args: ["--user", "show", ref.systemdName, "--property=LoadState", "--value"], env: { ...deps.env } });
      if (state.trim() !== "loaded") throw new Error(`Native service ${ref.systemdName} is not loaded. Repair services before updating; nothing changed.`);
    }
  }
}

function systemdDispatchArgs(deps: PiWebUpdateDependencies): string[] {
  // User-manager services do not inherit the caller's environment. Propagate
  // configuration/runtime selection deliberately, not terminal/session secrets.
  // Preserve cwd too: config and data overrides may be relative paths.
  const keys = Object.keys(deps.env).filter((key) =>
    /^(PI_WEB_|PI_CODING_AGENT_)/.test(key)
    || ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "NODE_EXTRA_CA_CERTS"].includes(key));
  return ["--user", "--collect", "--expand-environment=no", `--working-directory=${deps.cwd}`,
    ...keys.filter((key) => deps.env[key] !== undefined).map((key) => `--setenv=${key}`)];
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
