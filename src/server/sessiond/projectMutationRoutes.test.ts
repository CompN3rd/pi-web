import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidProjectPathError, type ProjectService } from "../projects/projectService.js";
import { registerProjectMutationRoutes } from "./projectMutationRoutes.js";

let app: FastifyInstance;
const projects = { add: vi.fn<ProjectService["add"]>(), close: vi.fn<ProjectService["close"]>() };

beforeEach(() => {
  vi.resetAllMocks();
  app = Fastify({ logger: false });
  registerProjectMutationRoutes(app, projects);
});
afterEach(async () => { await app.close(); });

describe("daemon project mutations", () => {
  it("delegates add input and returns the project", async () => {
    const project = { id: "project-1", name: "Repo", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };
    projects.add.mockResolvedValue(project);
    const input = { name: "Repo", path: "/repo", create: true };
    const response = await app.inject({ method: "POST", url: "/projects", payload: input });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(project);
    expect(projects.add).toHaveBeenCalledExactlyOnceWith(input);
  });

  it.each([{}, { path: 3 }, { path: " " }, { path: "/repo", create: "yes" }, { path: "/repo", name: 3 }])("rejects invalid input %j before calling the service", async (payload) => {
    const response = await app.inject({ method: "POST", url: "/projects", payload });
    expect(response.statusCode).toBe(400);
    expect(projects.add).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidProjectPathError("Project path must be a directory"), 400],
    [new InvalidProjectPathError("Missing path"), 400],
    [Object.assign(new Error("Unread cleanup denied"), { code: "EACCES" }), 500],
    [Object.assign(new Error("Catalog parent missing"), { code: "ENOENT" }), 500],
    [new Error("Catalog reconciliation failed"), 500],
  ])("maps add error %s to %s", async (error, status) => {
    projects.add.mockRejectedValue(error);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { path: "/repo" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: error.message });
  });

  it("delegates close and confirms completion", async () => {
    projects.close.mockResolvedValue(undefined);
    const response = await app.inject({ method: "DELETE", url: "/projects/project%201" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: true });
    expect(projects.close).toHaveBeenCalledExactlyOnceWith("project 1");
  });

  it.each([["Project not found", 404], ["Catalog reconciliation failed", 500]])("maps close error %s to %s", async (message, status) => {
    projects.close.mockRejectedValue(new Error(message));
    const response = await app.inject({ method: "DELETE", url: "/projects/project-1" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: message });
  });
});
