import { describe, expect, it, vi } from "vitest";
import type {
  ProviderRemoveContext,
  ProviderWorkspace,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { TerminalCommandRun, Workspace } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/terminalService.js";
import {
  WorkspaceProviderRegistry,
  type WorkspaceProviderRemovalTarget,
} from "./workspaceProviderRegistry.js";
import {
  WorkspaceRemovalService,
  type WorkspaceRemovalProvider,
  type WorkspaceRemovalTerminalHost,
} from "./workspaceRemovalService.js";

const project: Project = {
  id: "project-1",
  name: "Roadmap",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

describe("WorkspaceRemovalService", () => {
  it("runs a neutral provider's non-file-deleting plan after every validation and preserves host metadata", async () => {
    const calls: string[] = [];
    let preparedContext: ProviderRemoveContext | undefined;
    const provider: WorkspaceProvider = {
      probe: () => { calls.push("probe"); return Promise.resolve("claim"); },
      list: () => {
        calls.push("list");
        return Promise.resolve([
          providerWorkspace("main", "/repo", true),
          providerWorkspace("roadmap", "/board-views/roadmap", false, {
            data: { viewId: "private-roadmap" },
            removal: {
              actionLabel: "Disconnect view",
              confirmation: "Disconnect the Roadmap view without deleting board files?",
            },
          }),
        ]);
      },
      prepareRemove: (context) => {
        calls.push("prepare");
        preparedContext = context;
        if (readPrivateViewId(context.workspace.data) !== "private-roadmap") {
          throw new Error("private view identity missing");
        }
        return Promise.resolve({
          title: "Disconnect board view: Roadmap",
          command: "boardctl view disconnect roadmap --keep-files",
        });
      },
    };
    const registry = registryFor(provider);
    const resolution = await registry.resolve(project);
    const target = resolution.workspaces.find(({ path }) => path === "/board-views/roadmap");
    const commandWorkspace = resolution.workspaces.find(({ isMain }) => isMain);
    if (target === undefined || commandWorkspace === undefined) throw new Error("Expected neutral removable workspace");
    expect(target.removal).toEqual({
      actionLabel: "Disconnect view",
      confirmation: "Disconnect the Roadmap view without deleting board files?",
    });
    const terminals = terminalHost(calls);
    const removals = new WorkspaceRemovalService(registry, terminals);

    const run = await removals.remove(project, target.id);

    expect(calls).toEqual(["probe", "list", "probe", "list", "prepare", "close", "run"]);
    expect(preparedContext).toMatchObject({
      project: { id: project.id, path: project.path },
      workspace: { path: "/board-views/roadmap", data: { viewId: "private-roadmap" } },
    });
    expect(preparedContext?.signal.aborted).toBe(true);
    expect(terminals.closedCwds).toEqual(["/board-views/roadmap"]);
    expect(terminals.runOptions).toEqual([{
      origin: "core",
      projectId: project.id,
      workspaceId: commandWorkspace.id,
      cwd: "/repo",
      title: "Disconnect board view: Roadmap",
      command: "boardctl view disconnect roadmap --keep-files",
      metadata: {
        "pi.operation": "workspace.delete",
        "target.workspaceId": target.id,
        "target.workspacePath": "/board-views/roadmap",
      },
    }]);
    expect(run).toMatchObject({
      title: "Disconnect board view: Roadmap",
      command: "boardctl view disconnect roadmap --keep-files",
      workspaceId: terminals.runOptions[0]?.workspaceId,
    });
  });

  it.each([
    {
      name: "main workspace",
      project,
      target: hostWorkspace("target", "/linked", true),
      others: [hostWorkspace("command", "/repo", false)],
      message: "main workspace cannot be removed",
    },
    {
      name: "filesystem root",
      project,
      target: hostWorkspace("target", "/", false),
      others: [hostWorkspace("command", "/repo", true)],
      message: "filesystem root cannot be removed",
    },
    {
      name: "registered project itself",
      project,
      target: hostWorkspace("target", "/repo", false),
      others: [hostWorkspace("command", "/other", true)],
      message: "registered project itself",
    },
    {
      name: "ancestor of the registered project",
      project: { ...project, path: "/repo/packages/app" },
      target: hostWorkspace("target", "/repo", false),
      others: [hostWorkspace("command", "/other", true)],
      message: "containing the registered project",
    },
  ])("rejects a provider-advertised $name before provider or terminal side effects", async ({ project: input, target, others, message }) => {
    const prepare = vi.fn(() => Promise.resolve({ title: "Unsafe", command: "unsafe" }));
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [target, ...others],
      prepare,
    }), terminals);

    await expect(removals.remove(input, target.id)).rejects.toThrow(message);

    expect(prepare).not.toHaveBeenCalled();
    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("requires the current owner and a safe non-target command workspace", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const prepare = vi.fn(() => Promise.resolve({ title: "Remove", command: "neutral remove" }));
    const terminals = terminalHost();
    const wrongOwner = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "other",
      target,
      workspaces: [target, hostWorkspace("main", "/repo", true)],
      prepare,
    }), terminals);

    await expect(wrongOwner.remove(project, target.id)).rejects.toThrow("owner is no longer current");

    const noCommand = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [target, { ...hostWorkspace("foreign", "/foreign", true), projectId: "other-project" }],
      prepare,
    }), terminals);
    await expect(noCommand.remove(project, target.id)).rejects.toThrow("non-target command workspace is required");

    expect(prepare).not.toHaveBeenCalled();
    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("does not close terminals or create a command run when provider validation fails", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => Promise.reject(new Error("workspace has unsubmitted changes")),
    }), terminals);

    await expect(removals.remove(project, target.id)).rejects.toThrow("workspace has unsubmitted changes");

    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("closes target terminals before command creation and never starts after cleanup failure", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const calls: string[] = [];
    const terminals = terminalHost(calls, new Error("cleanup failed"));
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => { calls.push("prepare"); return Promise.resolve({ title: "Remove", command: "neutral remove" }); },
    }), terminals);

    await expect(removals.remove(project, target.id)).rejects.toThrow("Failed to close workspace terminals: cleanup failed");

    expect(calls).toEqual(["prepare", "close"]);
    expect(terminals.runOptions).toEqual([]);
  });
});

function registryFor(provider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("neutral", provider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, provider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider,
  };
}

function providerWorkspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key === "roadmap" ? "Roadmap" : key, isMain, ...extras };
}

function hostWorkspace(id: string, path: string, isMain: boolean): Workspace {
  return {
    id,
    projectId: project.id,
    path,
    label: id,
    isMain,
    isGitRepo: false,
    isGitWorktree: false,
    provider: { pluginId: "neutral", capabilities: { request: false, remove: true } },
    removal: { actionLabel: "Disconnect", confirmation: "Disconnect this workspace?" },
  };
}

function removalProvider(target: WorkspaceProviderRemovalTarget): WorkspaceRemovalProvider {
  return { resolveRemoval: () => Promise.resolve(target) };
}

function terminalHost(calls: string[] = [], closeFailure?: Error): WorkspaceRemovalTerminalHost & {
  closedCwds: string[];
  runOptions: RunTerminalCommandOptions[];
} {
  const closedCwds: string[] = [];
  const runOptions: RunTerminalCommandOptions[] = [];
  return {
    closedCwds,
    runOptions,
    closeForCwd(cwd) {
      calls.push("close");
      if (closeFailure !== undefined) throw closeFailure;
      closedCwds.push(cwd);
    },
    runCommand(options) {
      calls.push("run");
      runOptions.push(options);
      return commandRun(options);
    },
  };
}

function commandRun(options: RunTerminalCommandOptions): TerminalCommandRun {
  return {
    id: "run-1",
    origin: options.origin,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    terminalId: "terminal-1",
    title: options.title,
    command: options.command,
    status: "running",
    createdAt: "2026-07-27T00:00:00.000Z",
    metadata: requireStringMetadata(options.metadata),
  };
}

function requireStringMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected command metadata");
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Expected string command metadata");
  }
  return Object.fromEntries(entries);
}

function readPrivateViewId(value: ProviderWorkspace["data"]): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const viewId: unknown = Reflect.get(value, "viewId");
  return typeof viewId === "string" ? viewId : undefined;
}
