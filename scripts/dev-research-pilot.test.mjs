import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertResearchPilotPortsAvailable,
  RESEARCH_PILOT_PORTS,
  researchPilotCommands,
  researchPilotEnvironment,
  portIsAvailable,
  researchPilotPaths,
  runResearchPilot,
  stopPilotChildren,
} from "./dev-research-pilot.mjs";

describe("research pilot launcher", () => {
  it("uses collision-free default ports and isolated mutable state while sharing only the agent profile", () => {
    expect(RESEARCH_PILOT_PORTS).toEqual({ api: 8604, ui: 8605, sessiond: 8606 });
    const paths = researchPilotPaths({ LOCALAPPDATA: "C:/Users/Test/AppData/Local", PI_WEB_AGENT_DIR: "C:/Users/Test/.pi/agent" }, "C:/Users/Test");
    const env = researchPilotEnvironment({ KEEP_ME: "yes" }, paths);

    expect(paths.root.replaceAll("\\", "/")).toContain("AppData/Local/pi-web-research-pilot");
    expect(env).toMatchObject({
      KEEP_ME: "yes",
      PI_WEB_AGENT_DIR: paths.sharedAgentDir,
      PI_WEB_AGENT_SESSION_DIR: paths.sessionDir,
      PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
      PI_WEB_DATA_DIR: paths.dataDir,
      PI_WEB_CONFIG: paths.configPath,
      PI_WEB_PORT: "8604",
      PI_WEB_SESSIOND_HOST: "127.0.0.1",
      PI_WEB_SESSIOND_PORT: "8606",
      PI_WEB_SESSIOND_URL: "http://127.0.0.1:8606",
    });
    expect(paths.sessionDir).not.toBe(paths.sharedAgentDir);
    expect(paths.dataDir).not.toContain(".pi-web");
  });

  it("builds the Windows commands including the direct API and alternate Vite port", () => {
    const runtime = { platform: "win32", nodeExecutable: "node-test", npmExecPath: "npm-cli-test" };
    expect(researchPilotCommands("npm-test", RESEARCH_PILOT_PORTS, runtime)).toEqual([
      { label: "session daemon", command: "npm-test", args: ["run", "start:sessiond"] },
      { label: "web/API", command: "npm-test", args: ["run", "start"] },
      { label: "Vite UI", command: "npm-test", args: ["run", "dev:client", "--", "--port", "8605"] },
    ]);
  });

  it("preserves the plugin-watching API command on non-Windows platforms", () => {
    const runtime = { platform: "linux", nodeExecutable: "node-test", npmExecPath: undefined };
    expect(researchPilotCommands("npm-test", RESEARCH_PILOT_PORTS, runtime)[1]).toEqual({
      label: "web/API", command: "npm-test", args: ["run", "dev:web"],
    });
  });

  it("invokes npm through Node on Windows instead of spawning a .cmd shim", () => {
    const commands = researchPilotCommands(undefined, RESEARCH_PILOT_PORTS, {
      platform: "win32",
      nodeExecutable: "C:/Program Files/nodejs/node.exe",
      npmExecPath: "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js",
    });
    expect(commands[0]).toEqual({
      label: "session daemon",
      command: "C:/Program Files/nodejs/node.exe",
      args: ["C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "run", "start:sessiond"],
    });
    expect(commands[2]?.args).toEqual([
      "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js", "run", "dev:client", "--", "--port", "8605",
    ]);
  });

  it("detects a genuinely occupied local TCP port without disturbing its listener", async () => {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    await expect(portIsAvailable(address.port)).resolves.toBe(false);
    expect(server.listening).toBe(true);
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await expect(portIsAvailable(address.port)).resolves.toBe(true);
  });

  it("refuses occupied ports without invoking any destructive action", async () => {
    const checker = vi.fn((port) => Promise.resolve(port !== 8605));
    await expect(assertResearchPilotPortsAvailable(RESEARCH_PILOT_PORTS, checker)).rejects.toThrow("ui 8605");
    expect(checker).toHaveBeenCalledTimes(3);
  });

  it("passes when all pilot ports are available", async () => {
    const checker = vi.fn(() => Promise.resolve(true));
    await expect(assertResearchPilotPortsAvailable(RESEARCH_PILOT_PORTS, checker)).resolves.toBeUndefined();
  });

  it("propagates shutdown to each live child and skips exited children", async () => {
    const live = fakeChild(101);
    const exited = fakeChild(102, 0);
    await stopPilotChildren([live, exited], "linux");

    expect(live.kill).toHaveBeenCalledWith("SIGTERM");
    expect(exited.kill).not.toHaveBeenCalled();
  });

  it("uses tree termination for live Windows children", async () => {
    const live = fakeChild(201);
    const killTree = vi.fn(() => Promise.resolve());
    await stopPilotChildren([live], "win32", killTree);
    expect(killTree).toHaveBeenCalledWith(201);
    expect(live.kill).not.toHaveBeenCalled();
  });

  it("rejects one spawn error and stops all already-spawned siblings without hanging", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-research-launcher-"));
    try {
      const children = [fakeChild(301), fakeChild(302), fakeChild(303)];
      let index = 0;
      const spawnImpl = vi.fn(() => children[index++]);
      const stopChildren = vi.fn(() => Promise.resolve());
      const run = runResearchPilot({
        rootDir: root,
        paths: {
          root,
          dataDir: join(root, "data"),
          configPath: join(root, "config.json"),
          sessionDir: join(root, "sessions"),
          sharedAgentDir: join(root, "agent"),
        },
        env: {},
        preflight: vi.fn(() => Promise.resolve()),
        spawnImpl,
        stopChildren,
        npmExecutable: "npm-test",
      });
      for (let attempt = 0; attempt < 50 && spawnImpl.mock.calls.length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      children[0].emit("error", new Error("spawn failed"));
      children[0].emit("error", new Error("duplicate spawn failure"));

      await expect(run).rejects.toThrow("spawn failed");
      expect(spawnImpl).toHaveBeenCalledTimes(3);
      expect(stopChildren).toHaveBeenCalledTimes(1);
      expect(stopChildren).toHaveBeenCalledWith(children);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeChild(pid, exitCode = null) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = exitCode;
  child.killed = false;
  child.kill = vi.fn();
  return child;
}
