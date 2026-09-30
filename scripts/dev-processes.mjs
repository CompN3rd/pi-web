import { execFileSync, spawn } from "node:child_process";

/** Each development child owns a process group so stopping a watcher also stops its runtime. */
export function startDevelopmentProcess(entry, args, env, ipc = false, execArgv = []) {
  return spawn(process.execPath, [...execArgv, entry, ...args], {
    env,
    detached: process.platform !== "win32",
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
  });
}

export function stopDevelopmentProcess(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // Node's Windows kill() terminates only the watcher, orphaning its runtime.
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else process.kill(-child.pid, signal);
  } catch (error) {
    // The child may have exited between the liveness check and tree termination.
    if (process.platform === "win32") {
      try { process.kill(child.pid, 0); }
      catch (probe) { if (probe?.code === "ESRCH") return; }
    }
    if (error?.code !== "ESRCH") throw error;
  }
}

/** An exited builder or API must not leave the other half running and appearing healthy. */
export async function superviseDevelopmentProcesses(start, { signals = process, stop = stopDevelopmentProcess } = {}) {
  const children = new Set();
  let finished = false;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const finishWith = (code) => {
    if (finished) return;
    finished = true;
    finish(code);
  };
  const add = (child) => {
    children.add(child);
    child.once("error", (error) => { children.delete(child); console.error(error); finishWith(1); });
    child.once("exit", (code, signal) => {
      children.delete(child);
      finishWith(code ?? (signal === "SIGINT" ? 130 : 1));
    });
    return child;
  };
  const onInterrupt = () => finishWith(130);
  const onTerminate = () => finishWith(143);
  signals.once("SIGINT", onInterrupt);
  signals.once("SIGTERM", onTerminate);
  try {
    await start(add, () => finished);
    return await completed;
  } finally {
    signals.removeListener("SIGINT", onInterrupt);
    signals.removeListener("SIGTERM", onTerminate);
    for (const child of children) stop(child);
    if (children.size > 0) {
      const force = setTimeout(() => { for (const child of children) stop(child, "SIGKILL"); }, 30_000);
      try {
        await Promise.all([...children].map((child) => new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", resolve);
        })));
      } finally { clearTimeout(force); }
    }
  }
}
