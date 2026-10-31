import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSessionFromServices, createAgentSessionServices, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService } from "./piSessionService.js";

it("runs SDK startup, resource discovery and shutdown hooks without a model call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-"));
  const lifecycle: string[] = [];
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const promptPath = join(cwd, "discovered.md");
  await writeFile(promptPath, "A prompt discovered by an extension.");
  const service = new PiSessionService(new SessionEventHub(), {
    agentDir: cwd,
    modelRegistry,
    sessionManager: {
      create: () => SessionManager.inMemory(cwd),
      open: (path) => SessionManager.open(path),
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([]),
    },
    createRuntime: async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir: cwd, authStorage, modelRegistry,
        settingsManager: SettingsManager.inMemory({}),
        resourceLoaderOptions: {
          noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
            pi.on("resources_discover", (event) => {
              lifecycle.push(`discover:${event.reason}`);
              return { promptPaths: [promptPath] };
            });
            pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
          }],
        },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }) });
      return { ...result, services, diagnostics: services.diagnostics };
    },
  });
  try {
    const session = await service.start(cwd);
    expect(lifecycle).toEqual(["start:startup", "discover:startup"]);
    expect(await service.commands(session.id)).toContainEqual({ name: "discovered", description: "A prompt discovered by an extension.", source: "prompt" });
  } finally {
    await service.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
  expect(lifecycle).toEqual(["start:startup", "discover:startup", "shutdown:quit"]);
});
