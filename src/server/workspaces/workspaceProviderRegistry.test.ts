import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderWorkspace, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import { ProjectScopedSpawnTargetResolver } from "../sessions/spawnTargetResolver.js";
import {
  eligibleWorkspaceProviderContributions,
  WorkspaceProviderRegistry,
} from "./workspaceProviderRegistry.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceProviderRegistry", () => {
  it("selects one primary owner, suppresses fallback probes, and derives generic workspaces", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const primary = provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("root", "/repo", true, {
          publicMetadata: { changeId: "abc", nested: [1, true, null] },
        }),
        workspace("feature", "/linked", false, {
          removal: { actionLabel: "Remove", confirmation: "Remove linked?" },
        }),
      ]),
      request: () => Promise.resolve({ ok: true }),
      prepareRemove: () => Promise.resolve({ title: "Remove", command: "tool remove" }),
    });
    const registry = registryFor([
      contribution("fallback", provider({ fallback: true, probe: fallbackProbe })),
      contribution("primary", primary),
    ]);

    const resolution = await registry.resolve(project);

    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({ status: "provider", projectId: project.id, ownerPluginId: "primary", diagnostics: [] });
    expect(resolution.workspaces).toEqual([
      expect.objectContaining({
        projectId: project.id,
        path: "/repo",
        label: "root",
        isMain: true,
        isGitRepo: false,
        isGitWorktree: false,
        provider: {
          pluginId: "primary",
          capabilities: { request: true, remove: true },
          metadata: { changeId: "abc", nested: [1, true, null] },
        },
      }),
      expect.objectContaining({
        projectId: project.id,
        path: "/linked",
        removal: { actionLabel: "Remove", confirmation: "Remove linked?" },
      }),
    ]);
    expect(resolution.workspaces[0]?.id).not.toBe(resolution.workspaces[1]?.id);
    expect(Object.isFrozen(resolution.workspaces[0]?.provider?.metadata)).toBe(true);
  });

  it("excludes unhealthy providers from arbitration while retaining degraded providers", async () => {
    const contributions = [
      contribution("unhealthy", provider({ probe: () => Promise.resolve("claim") })),
      contribution("degraded", provider({ probe: () => Promise.resolve("pass") })),
      contribution("missing-inspection", provider({ probe: () => Promise.resolve("claim") })),
      contribution("fallback", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", "/repo", true)]),
      })),
    ];
    const eligible = eligibleWorkspaceProviderContributions(contributions, [
      { pluginId: "unhealthy", health: { status: "unhealthy" } },
      { pluginId: "degraded", health: { status: "degraded" } },
      { pluginId: "fallback", health: { status: "healthy" } },
    ]);

    const resolution = await registryFor(eligible).resolve(project);

    expect(eligible.map(({ pluginId }) => pluginId)).toEqual(["degraded", "fallback"]);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "fallback" });
  });

  it("evaluates fallback providers only after every primary passes", async () => {
    const calls: string[] = [];
    const registry = registryFor([
      contribution("primary-b", provider({ probe: () => { calls.push("primary-b"); return Promise.resolve("pass"); } })),
      contribution("fallback", provider({
        fallback: true,
        probe: () => { calls.push("fallback"); return Promise.resolve("claim"); },
        list: () => Promise.resolve([workspace("root", "/repo", true)]),
      })),
      contribution("primary-a", provider({ probe: () => { calls.push("primary-a"); return Promise.resolve("pass"); } })),
    ]);

    const resolution = await registry.resolve(project);

    expect(calls).toEqual(["primary-a", "primary-b", "fallback"]);
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "fallback" });
  });

  it.each([
    { tier: "primary" as const, fallback: false },
    { tier: "fallback" as const, fallback: true },
  ])("degrades explicit same-tier $tier conflicts without choosing import order", async ({ tier, fallback }) => {
    const lowerProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const contributions = fallback
      ? [
          contribution("one", provider({ fallback, probe: () => Promise.resolve("claim") })),
          contribution("two", provider({ fallback, probe: () => Promise.resolve("claim") })),
        ]
      : [
          contribution("one", provider({ probe: () => Promise.resolve("claim") })),
          contribution("two", provider({ probe: () => Promise.resolve("claim") })),
          contribution("lower", provider({ fallback: true, probe: lowerProbe })),
        ];
    const { registry, logger } = registryFixture(contributions);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      workspaces: [{ path: "/repo", isMain: true }],
      diagnostics: [{
        code: "claim-conflict",
        tier,
        pluginIds: ["one", "two"],
      }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
    expect(lowerProbe).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, tier, pluginIds: ["one", "two"] }),
      "workspace provider claim conflict",
    );
  });

  it("contains invalid and rejected probes and still permits a fallback owner", async () => {
    const invalidProbeProvider = provider();
    // Exercise the JavaScript runtime boundary rather than the TypeScript declaration.
    Object.defineProperty(invalidProbeProvider, "probe", { value: () => Promise.resolve("maybe") });
    const { registry, logger } = registryFixture([
      contribution("invalid", invalidProbeProvider),
      contribution("rejected", provider({ probe: () => Promise.reject(new Error("detector broke")) })),
      contribution("git-shaped-fixture", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", "/repo", true)]),
      })),
    ]);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "git-shaped-fixture" });
    expect(resolution.diagnostics).toHaveLength(2);
    expect(resolution.diagnostics[0]).toMatchObject({ code: "probe-failed", pluginId: "invalid", tier: "primary" });
    expect(resolution.diagnostics[0]?.message).toContain("invalid probe result");
    expect(resolution.diagnostics[1]).toMatchObject({ code: "probe-failed", pluginId: "rejected", tier: "primary", message: "detector broke" });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("bounds a hanging probe, aborts its signal, and continues arbitration", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const hanging = provider({
      probe: (_project, signal) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("Fixture probe aborted", { cause: reason }));
        }, { once: true });
      }),
    });
    const registry = registryFor([
      contribution("hanging", hanging),
      contribution("fallback", provider({
        fallback: true,
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([workspace("root", "/repo", true)]),
      })),
    ], { providerTimeoutMs: 25 });

    const resolving = registry.resolve(project);
    await vi.advanceTimersByTimeAsync(25);

    const resolution = await resolving;
    expect(resolution).toMatchObject({
      status: "provider",
      ownerPluginId: "fallback",
      diagnostics: [{ code: "probe-failed", pluginId: "hanging" }],
    });
    expect(resolution.diagnostics[0]?.message).toContain("timed out");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps a successful claimant as owner when listing fails instead of switching to fallback", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const registry = registryFor([
      contribution("owner", provider({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.reject(new Error("listing broke")),
      })),
      contribution("fallback", provider({ fallback: true, probe: fallbackProbe })),
    ]);

    const resolution = await registry.resolve(project);

    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({
      status: "degraded",
      ownerPluginId: "owner",
      workspaces: [{ path: "/repo", isMain: true }],
      diagnostics: [{ code: "list-failed", pluginId: "owner", message: "listing broke" }],
    });
    expect(resolution.workspaces[0]).not.toHaveProperty("provider");
  });

  it.each([
    {
      name: "non-array result",
      value: { key: "root" },
      message: "list result must be an array",
    },
    {
      name: "relative path",
      value: [workspace("root", "relative", true)],
      message: "path must be absolute",
    },
    {
      name: "duplicate key",
      value: [workspace("same", "/repo", true), workspace("same", "/linked", false)],
      message: "duplicate key",
    },
    {
      name: "duplicate normalized path",
      value: [workspace("root", "/repo", true), workspace("other", "/repo/../repo", false)],
      message: "duplicate path",
    },
    {
      name: "missing main",
      value: [workspace("secondary", "/linked", false)],
      message: "exactly one main",
    },
    {
      name: "multiple mains",
      value: [workspace("root", "/repo", true), workspace("other", "/linked", true)],
      message: "exactly one main",
    },
    {
      name: "non-JSON private data",
      value: [{ key: "root", path: "/repo", label: "root", isMain: true, data: { callback: () => undefined } }],
      message: "data must contain only JSON values",
    },
  ])("rejects invalid provider workspace contracts: $name", async ({ value, message }) => {
    const invalidListProvider = provider({ probe: () => Promise.resolve("claim") });
    Object.defineProperty(invalidListProvider, "list", { value: () => Promise.resolve(value) });
    const registry = registryFor([contribution("invalid-list", invalidListProvider)]);

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      ownerPluginId: "invalid-list",
      diagnostics: [{ code: "list-failed" }],
      workspaces: [{ path: "/repo", isMain: true }],
    });
    expect(resolution.diagnostics[0]?.message).toContain(message);
  });

  it("rejects inaccessible workspace paths through the host path boundary", async () => {
    const registry = registryFor([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([workspace("root", "/repo", true), workspace("gone", "/gone", false)]),
    }))], { pathInspector: (path) => path !== "/gone" });

    const resolution = await registry.resolve(project);

    expect(resolution).toMatchObject({
      status: "degraded",
      diagnostics: [{ code: "list-failed" }],
    });
    expect(resolution.diagnostics[0]?.message).toContain("not an accessible directory: /gone");
  });

  it("uses the kernel folder workspace when no provider claims or Git is absent", async () => {
    const registry = registryFor([contribution("passing", provider())]);

    const first = await registry.resolve(project);
    const disabledGit = await registryFor([]).resolve(project);

    expect(first).toMatchObject({
      status: "folder",
      projectId: project.id,
      workspaces: [{
        projectId: project.id,
        path: "/repo",
        label: "Project",
        isMain: true,
        isGitRepo: false,
        isGitWorktree: false,
      }],
      diagnostics: [],
    });
    expect(first.workspaces[0]?.id).toMatch(/^[a-f0-9]{12}$/u);
    expect(disabledGit.workspaces).toEqual(first.workspaces);
  });

  it("serves live provider workspaces to spawned-session target validation", async () => {
    let linkedPath = "/first-linked";
    const registry = registryFor([contribution("owner", provider({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([
        workspace("root", "/repo", true),
        workspace(linkedPath, linkedPath, false),
      ]),
    }))]);
    const resolver = new ProjectScopedSpawnTargetResolver({
      projects: { list: () => Promise.resolve([project]) },
      workspaces: registry,
    });

    await expect(resolver.resolveSpawnTarget("/repo", "/first-linked")).resolves.toEqual({ allowed: true, cwd: "/first-linked" });

    linkedPath = "/new-linked";

    await expect(resolver.resolveSpawnTarget("/repo", "/first-linked")).resolves.toEqual({
      allowed: false,
      reason: "out-of-project",
      allowedCwds: ["/repo", "/new-linked"],
    });
    await expect(resolver.resolveSpawnTarget("/repo", "/new-linked")).resolves.toEqual({ allowed: true, cwd: "/new-linked" });
  });
});

function registryFor(
  contributions: readonly ServerPluginProviderContribution[],
  options: { providerTimeoutMs?: number; pathInspector?: (path: string) => boolean | Promise<boolean> } = {},
): WorkspaceProviderRegistry {
  return registryFixture(contributions, options).registry;
}

function registryFixture(
  contributions: readonly ServerPluginProviderContribution[],
  options: { providerTimeoutMs?: number; pathInspector?: (path: string) => boolean | Promise<boolean> } = {},
): { registry: WorkspaceProviderRegistry; logger: { warn: ReturnType<typeof vi.fn> } } {
  const logger = { warn: vi.fn() };
  return {
    registry: new WorkspaceProviderRegistry({
      contributions,
      logger,
      ...(options.providerTimeoutMs === undefined ? {} : { providerTimeoutMs: options.providerTimeoutMs }),
      pathInspector: options.pathInspector ?? (() => true),
    }),
    logger,
  };
}

function contribution(pluginId: string, workspaceProvider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider: workspaceProvider,
  };
}

function provider(overrides: Partial<WorkspaceProvider> = {}): WorkspaceProvider {
  return {
    fallback: false,
    probe: () => Promise.resolve("pass"),
    list: () => Promise.resolve([]),
    ...overrides,
  };
}

function workspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key, isMain, ...extras };
}
