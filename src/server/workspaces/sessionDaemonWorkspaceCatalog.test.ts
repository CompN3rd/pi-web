import { describe, expect, it, vi } from "vitest";
import type { SessionDaemonRequestClient } from "../../sessiond/sessionDaemonClient.js";
import { SessionDaemonWorkspaceCatalog } from "./sessionDaemonWorkspaceCatalog.js";
import {
  WorkspaceCatalogProtocolError,
  WorkspaceCatalogRequestError,
  WorkspaceCatalogUnavailableError,
  workspaceCatalogHttpStatus,
} from "./workspaceCatalog.js";

const providerWorkspace = {
  id: "w/1",
  projectId: "project a",
  path: "/repo linked",
  label: "feature/one",
  isMain: true,
  isGitRepo: false,
  isGitWorktree: false,
  provider: {
    pluginId: "replacement",
    capabilities: { request: false, remove: false },
    metadata: {
      isGitRepo: true,
      isGitWorktree: true,
      branch: "feature/one",
      detached: false,
    },
  },
};

describe("SessionDaemonWorkspaceCatalog", () => {
  it("uses encoded daemon operations and applies browser-v1 compatibility without provider-id branching", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>((_method, path) => Promise.resolve(jsonResponse(
      path.endsWith("/w%2F1") ? providerWorkspace : { status: "provider", workspaces: [providerWorkspace], diagnostics: [] },
    )));
    const catalog = new SessionDaemonWorkspaceCatalog({ request });

    const listed = await catalog.list("project a");
    const resolved = await catalog.resolve("project a", "w/1");

    expect(request).toHaveBeenNthCalledWith(1, "GET", "/workspace-catalog/projects/project%20a/workspaces");
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/workspace-catalog/projects/project%20a/workspaces/w%2F1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      branch: "feature/one",
      isGitRepo: true,
      isGitWorktree: true,
      provider: { pluginId: "replacement", metadata: { detached: false } },
    });
    expect(resolved).toMatchObject(listed[0] ?? {});
  });

  it("parses the immutable provider runtime and startup-health snapshot", async () => {
    const request = vi.fn<SessionDaemonRequestClient["request"]>(() => Promise.resolve(jsonResponse({
      safeStart: "bundled-only",
      records: [{
        pluginId: "git",
        source: "bundled",
        scope: "bundled",
        moduleRevision: "sha256:abc",
        state: "active",
        name: "Git",
      }],
      health: [{ pluginId: "git", health: { status: "degraded", message: "Git is old", details: { version: 1, nested: ["ok", { ready: true }] } } }],
    })));
    const catalog = new SessionDaemonWorkspaceCatalog({ request });

    const snapshot = await catalog.providerRuntime();

    expect(request).toHaveBeenCalledWith("GET", "/workspace-catalog/provider-runtime");
    expect(snapshot).toEqual({
      safeStart: "bundled-only",
      records: [{ pluginId: "git", source: "bundled", scope: "bundled", moduleRevision: "sha256:abc", state: "active", name: "Git" }],
      health: [{ pluginId: "git", health: { status: "degraded", message: "Git is old", details: { version: 1, nested: ["ok", { ready: true }] } } }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.health)).toBe(true);
    const details = snapshot.health[0]?.health.details;
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details?.["nested"])).toBe(true);
  });

  it("rejects mismatched or malformed authority responses before filesystem consumers use them", async () => {
    const mismatched = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse({ ...providerWorkspace, projectId: "another-project" })),
    });
    const relative = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve(jsonResponse({ status: "provider", workspaces: [{ ...providerWorkspace, path: "relative" }] })),
    });

    await expect(mismatched.resolve("project a", "w/1")).rejects.toBeInstanceOf(WorkspaceCatalogProtocolError);
    await expect(relative.list("project a")).rejects.toThrow("path must be absolute");
  });

  it("distinguishes daemon unavailability, upstream failures, and invalid JSON for route status mapping", async () => {
    const unavailable = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    const quiescing = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 503, headers: {}, body: JSON.stringify({ error: "Session daemon is shutting down" }) }),
    });
    const invalid = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 200, headers: {}, body: "not-json" }),
    });
    const missingWorkspace = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({ statusCode: 404, headers: {}, body: JSON.stringify({ error: "Workspace not found" }) }),
    });
    const oldDaemon = new SessionDaemonWorkspaceCatalog({
      request: () => Promise.resolve({
        statusCode: 404,
        headers: {},
        body: JSON.stringify({ statusCode: 404, error: "Not Found", message: "Route GET:/workspace-catalog/projects/p1/workspaces not found" }),
      }),
    });

    const unavailableError = await unavailable.list("p1").catch((error: unknown) => error);
    const quiescingError = await quiescing.list("p1").catch((error: unknown) => error);
    const invalidError = await invalid.list("p1").catch((error: unknown) => error);
    const missingWorkspaceError = await missingWorkspace.resolve("p1", "missing").catch((error: unknown) => error);
    const oldDaemonError = await oldDaemon.list("p1").catch((error: unknown) => error);

    expect(unavailableError).toBeInstanceOf(WorkspaceCatalogUnavailableError);
    expect(unavailableError).toHaveProperty("message", "Session daemon workspace authority unavailable: connect ECONNREFUSED");
    expect(workspaceCatalogHttpStatus(unavailableError, 400)).toBe(503);
    expect(quiescingError).toBeInstanceOf(WorkspaceCatalogRequestError);
    expect(quiescingError).toHaveProperty("message", "Session daemon workspace authority returned HTTP 503: Session daemon is shutting down");
    expect(workspaceCatalogHttpStatus(quiescingError, 400)).toBe(503);
    expect(invalidError).toBeInstanceOf(WorkspaceCatalogProtocolError);
    expect(workspaceCatalogHttpStatus(invalidError, 400)).toBe(502);
    expect(missingWorkspaceError).toBeInstanceOf(WorkspaceCatalogRequestError);
    expect(missingWorkspaceError).toHaveProperty("message", "Workspace not found");
    expect(workspaceCatalogHttpStatus(missingWorkspaceError, 400)).toBe(400);
    expect(oldDaemonError).toBeInstanceOf(WorkspaceCatalogProtocolError);
    expect(oldDaemonError).toHaveProperty(
      "message",
      "Session daemon does not support workspace authority operations; restart or upgrade the session daemon",
    );
    expect(workspaceCatalogHttpStatus(oldDaemonError, 404)).toBe(502);
  });
});

function jsonResponse(value: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}
