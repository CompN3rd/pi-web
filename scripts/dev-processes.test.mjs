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
    [descendant] = await once(child, "message");
    expect(typeof descendant).toBe("number");
    const exited = once(child, "exit");
    stopDevelopmentProcess(child);
    await exited;
    expect(() => process.kill(descendant, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    stopDevelopmentProcess(child);
    if (typeof descendant === "number") {
      try { process.kill(descendant); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
