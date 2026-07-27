import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { WorkspaceRemovalError } from "../workspaces/workspaceRemovalService.js";
import { registerWorkspaceRemovalRoutes } from "./workspaceRemovalRoutes.js";

const project: Project = {
  id: "project one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const run: TerminalCommandRun = {
  id: "run-1",
  origin: "core",
  projectId: project.id,
  workspaceId: "main",
  terminalId: "terminal-1",
  title: "Remove workspace",
  command: "neutral detach workspace",
  status: "running",
  createdAt: "2026-07-27T00:00:00.000Z",
  metadata: { "pi.operation": "workspace.delete", "target.workspaceId": "linked" },
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon workspace removal routes", () => {
  it("resolves the registered project and returns the host-owned command run", async () => {
    const remove = vi.fn(() => Promise.resolve(run));
    registerWorkspaceRemovalRoutes(app, { projects: projectReader(), removals: { remove } });

    const response = await app.inject({
      method: "DELETE",
      url: "/workspace-removals/projects/project%20one/workspaces/linked",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TerminalCommandRun>()).toEqual(run);
    expect(remove).toHaveBeenCalledWith(project, "linked");
  });

  it("serializes project, safety, and unexpected failures without a stack", async () => {
    const remove = vi.fn()
      .mockRejectedValueOnce(new WorkspaceRemovalError("Workspace owner is no longer current", 409))
      .mockRejectedValueOnce(new Error("unexpected failure"));
    registerWorkspaceRemovalRoutes(app, { projects: projectReader(), removals: { remove } });

    const missing = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/missing/workspaces/linked" });
    const rejected = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/project%20one/workspaces/linked" });
    const failed = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/project%20one/workspaces/linked" });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Project not found" });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: "Workspace owner is no longer current" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "unexpected failure" });
    expect(failed.body).not.toContain("stack");
  });
});

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}
