import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startDevelopmentProcess, stopDevelopmentProcess } from "./dev-processes.mjs";

it.skipIf(process.platform !== "win32")("terminates a Windows watcher and its runtime descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-process-tree-"));
  const entry = join(root, "watcher.mjs");
  await writeFile(entry, `import { spawn } from 'node:child_process';
const runtime = spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
runtime.on('message', pid => process.send(pid));
`);
  const child = startDevelopmentProcess(entry, [], process.env, true);
  let descendant;
  try {
    descendant = await waitForReady(child);
    expect(typeof descendant).toBe("number");
    const exited = once(child, "exit");
    stopDevelopmentProcess(child);
    await exited;
    expect(() => process.kill(descendant, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    try {
      await stopAndWait(child);
      if (typeof descendant === "number") {
        try { process.kill(descendant); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}, 15_000);

it.each(["exit", "timeout"])("fails readiness promptly and cleans up on %s", async (mode) => {
  const child = startDevelopmentProcess("-e", [mode === "exit" ? "process.exit(7)" : "setInterval(() => {}, 1000)"], process.env, true);
  try {
    await expect(waitForReady(child, mode === "exit" ? 5_000 : 50)).rejects.toThrow(mode === "exit" ? "before readiness" : "aborted");
  } finally { await stopAndWait(child); }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

async function waitForReady(child, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // events.once also rejects on error. Observe the exit race and cancel the
    // losing listener so every failure reaches the caller's cleanup block.
    const [message] = await Promise.race([
      once(child, "message", { signal: controller.signal }),
      once(child, "exit", { signal: controller.signal }).then(([code]) => { throw new Error(`Watcher exited before readiness: ${code}`); }),
    ]);
    return message;
  } finally { clearTimeout(timeout); controller.abort(); }
}

async function stopAndWait(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  stopDevelopmentProcess(child);
  await exited;
}
