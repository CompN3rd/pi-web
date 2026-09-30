import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startDevelopmentProcess, superviseDevelopmentProcesses } from "./dev-processes.mjs";

const require = createRequire(import.meta.url);

/** Cold checkout startup, not a lock: ordered restart commands handle existing running services. */
export async function waitForPluginBuild({ cwd = process.cwd(), timeoutMs = 120_000, intervalMs = 250, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await access(resolve(cwd, "dist", ".plugins-ready"));
      signal?.throwIfAborted();
      return;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Plugin build not ready. Start npm run dev:web (or npm run dev:plugins), wait for its build, then start sessiond.");
    await delay(Math.min(intervalMs, remaining), undefined, { signal });
  }
}

export async function runDevelopmentSessiond({ env = process.env, watch = false, launch = startDevelopmentProcess,
  signals = process, wait = waitForPluginBuild, stop } = {}) {
  const controller = new AbortController();
  let signalExitCode;
  const onInterrupt = () => { signalExitCode = 130; controller.abort(); };
  const onTerminate = () => { signalExitCode = 143; controller.abort(); };
  signals.once("SIGINT", onInterrupt);
  signals.once("SIGTERM", onTerminate);
  try {
    console.log("[plugins] sessiond waiting for the web-owned plugin build");
    await wait({ signal: controller.signal });
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted && signalExitCode !== undefined) return signalExitCode;
    throw error;
  } finally {
    signals.removeListener("SIGINT", onInterrupt);
    signals.removeListener("SIGTERM", onTerminate);
  }
  return superviseDevelopmentProcesses((add) => {
    // Track the actual long-lived daemon so shutdown waits for its cleanup.
    add(watch
      ? launch(require.resolve("tsx/cli"), ["watch", "src/server/sessiond.ts"], env)
      : launch("src/server/sessiond.ts", [], env, false, ["--import", require.resolve("tsx")]));
  }, { signals, ...(stop === undefined ? {} : { stop }) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runDevelopmentSessiond({ watch: process.argv.includes("--watch") });
}
