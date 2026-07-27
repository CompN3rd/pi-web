import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderWorkspace, WorkspaceProvider } from "../../server-plugin-api.js";
import type { Workspace } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import { ProjectScopedSpawnTargetResolver } from "../sessions/spawnTargetResolver.js";
import type { Project } from "../types.js";
import { createWorkspaceProviderRuntimeSnapshot } from "../workspaces/workspaceCatalog.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { registerWorkspaceCatalogRoutes } from "./workspaceCatalogRoutes.js";

const project: Project = {
  id: "p1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon workspace catalog routes", () => {
  it("serves the same live provider registry used by spawned-session validation", async () => {
    let listed: ProviderWorkspace[] = [providerWorkspace("root", "/repo", true)];
    const registry = registryFor({
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve(listed),
    });
    const projects = projectReader();
    registerWorkspaceCatalogRoutes(app, {
      projects,
      workspaces: registry,
      providerRuntime: createWorkspaceProviderRuntimeSnapshot([], []),
    });
    const spawnTargets = new ProjectScopedSpawnTargetResolver({ projects, workspaces: registry });

    await expect(spawnTargets.resolveSpawnTarget("/repo", "/linked")).resolves.toEqual({
      allowed: false,
      reason: "out-of-project",
      allowedCwds: ["/repo"],
    });

    listed = [providerWorkspace("root", "/repo", true), providerWorkspace("linked", "/linked", false)];
    const [response, spawnDecision] = await Promise.all([
      app.inject({ method: "GET", url: "/workspace-catalog/projects/p1/workspaces" }),
      spawnTargets.resolveSpawnTarget("/repo", "/linked"),
    ]);

    expect(response.statusCode).toBe(200);
    const resolution = response.json<{ status: string; ownerPluginId: string; workspaces: Workspace[] }>();
    expect(resolution).toMatchObject({ status: "provider", ownerPluginId: "owner" });
    expect(resolution.workspaces.map(({ path }) => path)).toEqual(["/repo", "/linked"]);
    expect(spawnDecision).toEqual({ allowed: true, cwd: "/linked" });

    const linked = resolution.workspaces.find(({ path }) => path === "/linked");
    if (linked === undefined) throw new Error("Expected linked workspace");
    const current = await app.inject({ method: "GET", url: `/workspace-catalog/projects/p1/workspaces/${linked.id}` });
    expect(current.statusCode).toBe(200);
    expect(current.json<Workspace>()).toMatchObject({ id: linked.id, path: "/linked" });

    listed = [providerWorkspace("root", "/repo", true)];
    const stale = await app.inject({ method: "GET", url: `/workspace-catalog/projects/p1/workspaces/${linked.id}` });
    expect(stale.statusCode).toBe(404);
    expect(stale.json()).toEqual({ error: "Workspace not found" });
  });

  it("returns safe degraded and not-found responses rather than switching after a claimed provider fails", async () => {
    const fallbackProbe = vi.fn(() => Promise.resolve<"claim">("claim"));
    const registry = new WorkspaceProviderRegistry({
      contributions: [
        contribution("owner", {
          probe: () => Promise.resolve("claim"),
          list: () => Promise.reject(new Error("provider list failed")),
        }),
        contribution("fallback", {
          fallback: true,
          probe: fallbackProbe,
          list: () => Promise.resolve([providerWorkspace("fallback", "/fallback", true)]),
        }),
      ],
      logger: { warn: vi.fn() },
      pathInspector: () => true,
    });
    registerWorkspaceCatalogRoutes(app, {
      projects: projectReader(),
      workspaces: registry,
      providerRuntime: createWorkspaceProviderRuntimeSnapshot([], []),
    });

    const degraded = await app.inject({ method: "GET", url: "/workspace-catalog/projects/p1/workspaces" });
    const missingProject = await app.inject({ method: "GET", url: "/workspace-catalog/projects/missing/workspaces" });

    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      status: "degraded",
      ownerPluginId: "owner",
      workspaces: [{ projectId: "p1", path: "/repo", isMain: true }],
      diagnostics: [{ code: "list-failed", pluginId: "owner" }],
    });
    expect(fallbackProbe).not.toHaveBeenCalled();
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toEqual({ error: "Project not found" });
  });

  it("exposes the immutable startup runtime and health snapshot", async () => {
    const snapshot = createWorkspaceProviderRuntimeSnapshot(
      [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", state: "active", name: "Git" }],
      [{ pluginId: "git", health: { status: "healthy" } }],
      "bundled-only",
    );
    registerWorkspaceCatalogRoutes(app, {
      projects: projectReader(),
      workspaces: registryFor({ probe: () => Promise.resolve("pass"), list: () => Promise.resolve([]) }),
      providerRuntime: snapshot,
    });

    const response = await app.inject({ method: "GET", url: "/workspace-catalog/provider-runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      safeStart: "bundled-only",
      records: [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", state: "active", name: "Git" }],
      health: [{ pluginId: "git", health: { status: "healthy" } }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

function projectReader() {
  return {
    list: () => Promise.resolve([project]),
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}

function registryFor(workspaceProvider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("owner", workspaceProvider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
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

function providerWorkspace(key: string, path: string, isMain: boolean): ProviderWorkspace {
  return { key, path, label: key, isMain };
}
