import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateAgentSessionServicesOptions } from "@earendil-works/pi-coding-agent";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime } from "./piSessionService.testSupport.js";

// Capture the real createAgentSessionServices implementation via importActual,
// then replace it with a spy that records the first argument and re-throws
// so no live agent session is created.
await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
  "@earendil-works/pi-coding-agent",
);

/** Mutation-safe container for captured call args. */
const capture: { opts: CreateAgentSessionServicesOptions | null } = { opts: null };

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    createAgentSessionServices(opts: CreateAgentSessionServicesOptions) {
      capture.opts = opts;
      throw new Error("__capture-only__: createAgentSessionServices called");
    },
  };
});

vi.mock("./builtinExtensionFactories.js", async () => {
  const actual = await vi.importActual<typeof import("./builtinExtensionFactories.js")>(
    "./builtinExtensionFactories.js",
  );
  return {
    ...actual,
    getBuiltinExtensionFactories() {
      return Promise.resolve([
        { name: "__wiring-test-mcp__", factory: () => undefined, builtin: true, replaceable: true },
        { name: "__wiring-test-codemode__", factory: () => undefined, builtin: true, replaceable: true },
        { name: "__wiring-test-tool-search__", factory: () => undefined, builtin: true, replaceable: true },
      ]);
    },
  };
});

/** Reset captured state between tests. */
afterEach(() => {
  capture.opts = null;
});

/**
 * Verify that the factories array contains exactly the sentinel entries and
 * that every entry is a named object (not a bare function factory). Named
 * entries from the builtin factory always carry the `builtin` flag, so
 * confirming they are all named objects is sufficient for this wiring test.
 */
function expectAllNamed(factoryCount: number, factoryNames: string[]): void {
  expect(factoryNames).toHaveLength(factoryCount);
  // Unique check doubles as a non-empty-array guard.
  const uniqueNames = new Set(factoryNames);
  expect(uniqueNames.size).toBe(factoryCount);
}

describe("PiSessionService builtin extension factory wiring", () => {
  it("passes builtin extension factories to createAgentSessionServices via resourceLoaderOptions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-wiring-"));
    const modelRuntime = await createTestModelRuntime();
    const hub = new CapturingSessionEventHub();

    const service = new PiSessionService(hub, {
      agentDir: directory,
      modelRuntime,
      sessionManager: createPiSessionManagerGateway({ agentDir: directory, env: {} }),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.start(directory);
      throw new Error("expected start() to fail via captured createAgentSessionServices");
    } catch (err: unknown) {
      if (!(err instanceof Error) || err.message !== "__capture-only__: createAgentSessionServices called") {
        throw err;
      }
    }

    const opts = capture.opts;
    if (opts === null) throw new Error("Expected capture to have opts");
    if (opts.resourceLoaderOptions === undefined) throw new Error("Expected resourceLoaderOptions");
    expect(opts.resourceLoaderOptions.extensionFactories).toBeDefined();

    const factories = opts.resourceLoaderOptions.extensionFactories ?? [];
    const factoryNames = factories.map((f) => f.name);
    expect(factories).toHaveLength(3);
    expect(factoryNames).toEqual(
      expect.arrayContaining(["__wiring-test-mcp__", "__wiring-test-codemode__", "__wiring-test-tool-search__"]),
    );
    expectAllNamed(3, factoryNames);

    await service.dispose();
  });

  it("passes eventBus alongside builtin extension factories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-wiring-"));
    const modelRuntime = await createTestModelRuntime();
    const hub = new CapturingSessionEventHub();

    const service = new PiSessionService(hub, {
      agentDir: directory,
      modelRuntime,
      sessionManager: createPiSessionManagerGateway({ agentDir: directory, env: {} }),
      heartbeatIntervalMs: 60_000,
    });

    try {
      await service.start(directory);
      throw new Error("expected start() to fail via captured createAgentSessionServices");
    } catch (err: unknown) {
      if (!(err instanceof Error) || err.message !== "__capture-only__: createAgentSessionServices called") {
        throw err;
      }
    }

    const opts = capture.opts;
    if (opts === null) throw new Error("Expected capture to have opts");
    if (opts.resourceLoaderOptions === undefined) throw new Error("Expected resourceLoaderOptions");
    expect(opts.resourceLoaderOptions.eventBus).toBeDefined();
    expect(opts.resourceLoaderOptions.extensionFactories).toBeDefined();

    await service.dispose();
  });
});
