import { describe, expect, it, vi } from "vitest";
import { runPiWebUpdate, type PiWebUpdateDependencies } from "./piWebUpdate.js";
import type { PiWebInstallationInfo } from "./shared/apiTypes.js";

function fixture(installation: PiWebInstallationInfo = { kind: "docker", dockerMode: "runtime" }, interactive = true, platform: NodeJS.Platform = "linux") {
  const deps = {
    env: { PATH: "/tools/bin" },
    nodeExecutable: "/tools/node",
    platform,
    home: "/home/test",
    cwd: "/project with spaces",
    uniqueId: vi.fn(() => "unique-id"),
    exists: vi.fn((path: string) => !path.includes("ui-dev")),
    piCliPath: "/owned/pi/dist/cli.js",
    interactive,
    agentDir: vi.fn(() => Promise.resolve("/profiles/active agent")),
    detectInstallation: vi.fn(() => Promise.resolve(installation)),
    realpath: vi.fn((path: string) => Promise.resolve(path)),
    capture: vi.fn<PiWebUpdateDependencies["capture"]>((command) => Promise.resolve(command.executable === "npm" ? "/opt/node/lib/node_modules" : command.executable === "systemctl" ? "loaded" : "")),
    run: vi.fn<PiWebUpdateDependencies["run"]>(() => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve(true)),
    log: vi.fn(),
  } satisfies PiWebUpdateDependencies;
  return deps;
}
const globalInstall: PiWebInstallationInfo = {
  kind: "npm-global", path: "/opt/node/lib/node_modules/@jmfederico/pi-web", npmRoot: "/opt/node/lib/node_modules",
};
const piInstall: PiWebInstallationInfo = {
  kind: "pi-package", path: "/profiles/active agent/npm/node_modules/@jmfederico/pi-web", scope: "user", source: "npm:@jmfederico/pi-web",
};

describe("runPiWebUpdate", () => {
  it.each([["--force"], ["--yes", "--yes"], ["latest"], ["--help", "--yes"], ["--dev"], ["--all"]])("rejects invalid arguments %j before inspecting or changing anything", async (...args) => {
    const deps = fixture();
    await expect(runPiWebUpdate(args, deps)).rejects.toThrow("Invalid update arguments");
    expect(deps.agentDir).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("help does not inspect the installation", async () => {
    const deps = fixture();
    await runPiWebUpdate(["--help"], deps);
    expect(deps.agentDir).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it.each(["runtime", "dev"] as const)("delegates %s Docker update, including inside a session", async (dockerMode) => {
    const deps = fixture({ kind: "docker", dockerMode });
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    await runPiWebUpdate([], deps);
    expect(deps.run.mock.calls).toEqual([[{
      executable: "pi-web-docker", args: dockerMode === "dev" ? ["--dev", "update"] : ["update"], env: deps.env,
    }]]);
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("interrupt active sessions and terminals"));
    expect(deps.log.mock.invocationCallOrder[0]).toBeLessThan(deps.confirm.mock.invocationCallOrder[0] ?? 0);
    expect(deps.confirm.mock.invocationCallOrder[0]).toBeLessThan(deps.run.mock.invocationCallOrder[0] ?? 0);
  });

  it("does not guess an unknown Docker mode", async () => {
    const deps = fixture({ kind: "docker" });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("mode is unknown");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("requires --yes without a TTY", async () => {
    const deps = fixture();
    deps.interactive = false;
    await expect(runPiWebUpdate([], deps)).rejects.toThrow("explicit --yes");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("cancels without mutation", async () => {
    const deps = fixture();
    deps.confirm.mockResolvedValue(false);
    await runPiWebUpdate([], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("Update cancelled. Nothing changed.");
  });

  it.each(["local", "unknown"] as const)("only prints instructions for %s", async (kind) => {
    const deps = fixture({ kind });
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("original tooling"));
  });

  it.each([globalInstall, piInstall])("refuses nested macOS update even with --yes ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.platform = "darwin";
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("Open a host terminal outside PI WEB");
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([globalInstall, piInstall])("dispatches nested Linux restart only after successful installation ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1", PI_WEB_CONFIG: "relative/config.json", PI_WEB_DATA_DIR: "/data/custom", PI_WEB_SESSIOND_SOCKET: "/custom.sock", HOME: "/home/test", XDG_RUNTIME_DIR: "/run/user/500", SECRET_TOKEN: "do not forward" } };
    await runPiWebUpdate([], deps);
    const probe = deps.capture.mock.calls.find(([command]) => command.executable === "systemd-run")?.[0];
    expect(probe?.args).toEqual(expect.arrayContaining(["--user", "--collect", "--wait", "--unit=pi-web-update-restart-unique-id-preflight", "--eval", "process.exit(0)"]));
    expect(deps.capture.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.run.mock.invocationCallOrder[0] ?? 0);
    const restart = deps.run.mock.calls[1]?.[0];
    expect(restart?.executable).toBe("systemd-run");
    expect(restart?.args).toEqual(expect.arrayContaining(["--user", "--collect", "--expand-environment=no", "--working-directory=/project with spaces", "--setenv=PI_WEB_CONFIG", "--setenv=PI_WEB_DATA_DIR", "--setenv=PI_WEB_SESSIOND_SOCKET", "--setenv=HOME", "--setenv=XDG_RUNTIME_DIR", "--unit=pi-web-update-restart-unique-id"]));
    expect(restart?.env).toEqual(deps.env);
    expect(restart?.args.slice(-4)).toEqual(["--", "/tools/node", `${installation.path ?? ""}/dist/cli.js`, "restart"]);
    expect(restart?.args).not.toContain("--wait");
    expect(restart?.args).not.toContain("--scope");
    expect(restart?.args).not.toContain("--setenv=SECRET_TOKEN");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("not verified complete"));
    const planIndex = deps.log.mock.calls.findIndex(([line]) => String(line).startsWith("Install:"));
    expect(deps.log.mock.invocationCallOrder[planIndex]).toBeLessThan(deps.confirm.mock.invocationCallOrder[0] ?? 0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(installation.path ?? ""));
  });

  it("refuses before installation when detached dispatch preflight fails", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.capture.mockImplementation((command) => command.executable === "systemd-run" ? Promise.reject(new Error("no user bus")) : Promise.resolve("loaded"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("nothing changed");
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it.each(["missing", "partial", "not-loaded"])("refuses native update with %s services before mutation", async (state) => {
    const deps = fixture(piInstall);
    if (state === "not-loaded") deps.capture.mockResolvedValue("not-found");
    else deps.exists.mockImplementation((path) => state === "partial" && path.includes("sessiond"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("nothing changed");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("never dispatches nested restart after install failure", async () => {
    const deps = fixture(globalInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.run.mockRejectedValueOnce(new Error("install failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("install failed");
    expect(deps.run).toHaveBeenCalledOnce();
    expect(deps.run.mock.calls[0]?.[0].executable).toBe("npm");
  });

  it("reports dispatch failure after install without claiming restart success", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("dispatch failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("dispatch failed");
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("Restart dispatched"));
  });

  it("cancels nested update after preflight without installing or dispatching restart", async () => {
    const deps = fixture(piInstall);
    deps.env = { ...deps.env, ...{ PI_WEB_SESSION: "1" } };
    deps.confirm.mockResolvedValue(false);
    await runPiWebUpdate([], deps);
    expect(deps.capture).toHaveBeenCalledWith(expect.objectContaining({ executable: "systemd-run" }));
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("pins global npm to the detected installation and restarts that CLI only afterwards", async () => {
    const deps = fixture(globalInstall);
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.capture).toHaveBeenCalledWith({ executable: "npm", args: ["root", "--global", "--prefix", "/opt/node"], env: deps.env });
    expect(deps.run.mock.calls.map(([command]) => [command.executable, command.args])).toEqual([
      ["npm", ["install", "--global", "--prefix", "/opt/node", "@jmfederico/pi-web@latest", "--allow-scripts=node-pty"]],
      ["/tools/node", ["/opt/node/lib/node_modules/@jmfederico/pi-web/dist/cli.js", "restart"]],
    ]);
  });

  it("refuses a changed npm root rather than updating another global installation", async () => {
    const deps = fixture(globalInstall);
    deps.capture.mockResolvedValue("/other/node_modules");
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("does not match");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("refuses a package nested inside a global package", async () => {
    const deps = fixture({ ...globalInstall, path: `${globalInstall.path ?? ""}/nested` });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("does not match");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("updates the explicit Pi package with this installation's Pi, active profile, and project scope disabled", async () => {
    const deps = fixture(piInstall);
    await runPiWebUpdate(["--yes"], deps);
    expect(deps.detectInstallation).toHaveBeenCalledWith("/profiles/active agent");
    expect(deps.run.mock.calls[0]).toEqual([{
      executable: "/tools/node", args: ["/owned/pi/dist/cli.js", "update", "--no-approve", "--extension", "npm:@jmfederico/pi-web"],
      env: { PATH: "/tools/bin", PI_CODING_AGENT_DIR: "/profiles/active agent" },
    }]);
    expect(deps.run.mock.calls[1]?.[0].args).toEqual([`${piInstall.path ?? ""}/dist/cli.js`, "restart"]);
  });

  it.each([{ scope: "project" as const }, { source: "/local/checkout" }, { source: "" }])("refuses unsafe Pi package metadata %j", async (override) => {
    const deps = fixture({ ...piInstall, ...override });
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("Only user-scope remote Pi packages");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([globalInstall, piInstall])("never restarts after an install failure ($kind)", async (installation) => {
    const deps = fixture(installation);
    deps.run.mockRejectedValueOnce(new Error("install failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("install failed");
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it("does not silently succeed when restart fails", async () => {
    const deps = fixture(piInstall);
    deps.run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("restart failed"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("restart failed");
  });

  it("fails closed if the active profile cannot be resolved", async () => {
    const deps = fixture(piInstall);
    deps.agentDir.mockRejectedValue(new Error("invalid active profile"));
    await expect(runPiWebUpdate(["--yes"], deps)).rejects.toThrow("invalid active profile");
    expect(deps.detectInstallation).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });
});
