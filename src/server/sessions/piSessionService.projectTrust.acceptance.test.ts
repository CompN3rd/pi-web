import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime } from "./piSessionService.testSupport.js";

/**
 * Acceptance coverage for always-on project trust: opening a workspace that
 * ships a project-local `.pi/` extension must honor pi's project-trust
 * settings at every session start — a saved `trust.json` decision wins, and
 * with no decision `defaultProjectTrust` decides, with `ask` treated as
 * untrusted because PI WEB has no browser trust prompt. The observable is
 * whether the project extension's command reaches the session — a
 * `.pi/extensions/` directory is trust-requiring, so an untrusted project
 * drops it.
 */

const tempDirs: string[] = [];
const services: PiSessionService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** An agent dir, optionally pinning `defaultProjectTrust` in its settings.json and a saved `trust.json` decision. */
async function agentDir(options: { defaultProjectTrust?: "always" | "never" | "ask"; savedDecision?: { path: string; trusted: boolean } } = {}): Promise<string> {
  const dir = await tempDir("pi-web-trust-agent-");
  if (options.defaultProjectTrust !== undefined) {
    await writeFile(join(dir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: options.defaultProjectTrust })}\n`);
  }
  if (options.savedDecision !== undefined) {
    await writeFile(join(dir, "trust.json"), `${JSON.stringify({ [options.savedDecision.path]: options.savedDecision.trusted })}\n`);
  }
  return dir;
}

/** A workspace whose `.pi/extensions/` registers an observable command. */
async function projectWithCommandExtension(): Promise<string> {
  const cwd = await tempDir("pi-web-trust-project-");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "extensions", "probe.js"), `
    export default function (pi) {
      pi.registerCommand("project-probe", {
        description: "project trust acceptance probe",
        async handler() {}
      });
    }
  `);
  return cwd;
}

/** Start a session for a trust-requiring project and list its command names. */
async function projectCommandNames(options: { agentDirPath: string; cwd?: string }): Promise<string[]> {
  // Isolate Pi's per-user resource discovery (~/.agents/skills et al.) so only
  // the explicit agent/project dirs contribute resources.
  vi.stubEnv("HOME", await tempDir("pi-web-trust-home-"));
  const runtime = await createTestModelRuntime();
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: options.agentDirPath,
    modelRuntime: runtime,
    sessionManager: createPiSessionManagerGateway({ agentDir: options.agentDirPath, env: {} }),
    heartbeatIntervalMs: 60_000,
  });
  services.push(service);
  const cwd = options.cwd ?? (await projectWithCommandExtension());
  const session = await service.start(cwd);
  const commands = await service.commands({ id: session.id, cwd });
  return commands.map((command) => command.name);
}

describe("project trust acceptance", () => {
  it("drops a project extension when defaultProjectTrust is never", async () => {
    const commands = await projectCommandNames({ agentDirPath: await agentDir({ defaultProjectTrust: "never" }) });
    expect(commands).not.toContain("project-probe");
  });

  it("drops a project extension when trust is left to ask (no browser prompt)", async () => {
    const commands = await projectCommandNames({ agentDirPath: await agentDir({ defaultProjectTrust: "ask" }) });
    expect(commands).not.toContain("project-probe");
  });

  it("loads a project extension when defaultProjectTrust is always", async () => {
    const commands = await projectCommandNames({ agentDirPath: await agentDir({ defaultProjectTrust: "always" }) });
    expect(commands).toContain("project-probe");
  });

  it("loads a project extension when a saved trust decision says trusted, even with defaultProjectTrust never", async () => {
    const cwd = await projectWithCommandExtension();
    const agent = await agentDir({ defaultProjectTrust: "never", savedDecision: { path: cwd, trusted: true } });

    const commands = await projectCommandNames({ agentDirPath: agent, cwd });
    expect(commands).toContain("project-probe");
  });

  it("drops a project extension when a saved trust decision says untrusted, even with defaultProjectTrust always", async () => {
    const cwd = await projectWithCommandExtension();
    const agent = await agentDir({ defaultProjectTrust: "always", savedDecision: { path: cwd, trusted: false } });

    const commands = await projectCommandNames({ agentDirPath: agent, cwd });
    expect(commands).not.toContain("project-probe");
  });
});