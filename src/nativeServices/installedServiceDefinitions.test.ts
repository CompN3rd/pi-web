import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  inspectInstalledNativeServiceDefinitions,
  type InstalledNativeServiceDefinitionCommandResult,
  type InstalledNativeServiceDefinitionDependencies,
  type InstalledNativeServiceDefinitionSource,
} from "./installedServiceDefinitions.js";

const servicePath = "/home/user/.config/systemd/user/pi-web-web.service";
const launchdPath = "/Users/user/Library/LaunchAgents/com.pi-web.web.plist";
const launchdTarget = "gui/501/com.pi-web.web";
const source: InstalledNativeServiceDefinitionSource = {
  id: "web",
  path: servicePath,
  systemdName: "pi-web-web.service",
  launchdTarget,
};

interface SystemdManagerOverrides {
  LoadState: string;
  FragmentPath: string;
  DropInPaths: string;
  NeedDaemonReload: string;
  EnvironmentFiles: string;
  Environment: string;
}

function managerOutput(overrides: Partial<SystemdManagerOverrides> = {}): string {
  const lines = [
    `LoadState=${overrides.LoadState ?? "loaded"}`,
    `FragmentPath=${overrides.FragmentPath ?? servicePath}`,
    `DropInPaths=${overrides.DropInPaths ?? ""}`,
    `NeedDaemonReload=${overrides.NeedDaemonReload ?? "no"}`,
    `Environment=${overrides.Environment ?? ""}`,
  ];
  // systemctl omits EnvironmentFiles entirely when the effective array is empty.
  if (overrides.EnvironmentFiles !== undefined) lines.push(`EnvironmentFiles=${overrides.EnvironmentFiles}`);
  return `${lines.join("\n")}\n`;
}

function systemdDefinition(configPath?: string): string {
  const escapedConfigPath = configPath
    ?.replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  const environment = escapedConfigPath === undefined
    ? ""
    : `Environment="PI_WEB_CONFIG=${escapedConfigPath}"\n`;
  return `[Service]\n${environment}ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"\n`;
}

function systemdDefinitionWithEnvironment(
  configPath: string | undefined,
  assignments: readonly string[],
): string {
  const directives = assignments.map((assignment) => `Environment="${assignment}"\n`).join("");
  return systemdDefinition(configPath).replace("[Service]\n", `[Service]\n${directives}`);
}

function busctlStringArray(values: readonly string[]): string {
  const serialized = values.map((value) => JSON.stringify(value)).join(" ");
  return `as ${String(values.length)}${serialized === "" ? "" : ` ${serialized}`}\n`;
}

function launchdDefinition(configPath?: string): string {
  const environment = configPath === undefined
    ? ""
    : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PI_WEB_CONFIG</key>\n    <string>${configPath}</string>\n  </dict>\n`;
  return `<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pi-web.web</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/env</string>\n    <string>/bin/zsh</string>\n    <string>-lc</string>\n    <string>exec true</string>\n  </array>\n${environment}</dict>\n</plist>\n`;
}

function launchdPrint(
  path = launchdPath,
  configPath?: string,
): string {
  const config = configPath === undefined ? "" : `\t\tPI_WEB_CONFIG => ${configPath}\n`;
  return `${launchdTarget} = {\n\tpath = ${path}\n\tstate = running\n\n\tenvironment = {\n${config}\t\tXPC_SERVICE_NAME => com.pi-web.web\n\t}\n}\n`;
}

function dependencies(
  contents: Uint8Array = new TextEncoder().encode(systemdDefinition()),
  result: InstalledNativeServiceDefinitionCommandResult = { status: 0, stdout: managerOutput(), stderr: "" },
): InstalledNativeServiceDefinitionDependencies {
  return {
    readFile: vi.fn(() => contents),
    realpath: vi.fn((path: string) => path),
    capture: vi.fn(() => result),
  };
}

function legacySystemdDependencies(
  contents: string,
  busctlResult: InstalledNativeServiceDefinitionCommandResult,
  systemctlEnvironment = "[unprintable]",
): InstalledNativeServiceDefinitionDependencies {
  const systemctlResult = {
    status: 0,
    stdout: managerOutput({ Environment: systemctlEnvironment }),
    stderr: "",
  } as const;
  const deps = dependencies(new TextEncoder().encode(contents), systemctlResult);
  vi.mocked(deps.capture).mockImplementation((command) => {
    if (command === "systemctl") return systemctlResult;
    if (command === "busctl") return busctlResult;
    throw new Error(`Unexpected command ${command}`);
  });
  return deps;
}

describe("installed native-service definition boundary", () => {
  it("binds a strict systemd fragment snapshot to modern quoted manager output", () => {
    const contents = `[Unit]\nDescription=é\n${systemdDefinition("/managed/$HOME/config with space.json")}`;
    const deps = dependencies(
      new TextEncoder().encode(contents),
      {
        status: 0,
        stdout: managerOutput({ Environment: '"PI_WEB_CONFIG=/managed/\\$HOME/config with space.json"' }),
        stderr: "",
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({
      ok: true,
      value: [{ id: "web", contents }],
    });
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.capture).toHaveBeenCalledWith("systemctl", [
      "--user",
      "--no-pager",
      "show",
      "pi-web-web.service",
      "--all",
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=DropInPaths",
      "--property=NeedDaemonReload",
      "--property=EnvironmentFiles",
      "--property=Environment",
    ]);
  });

  it("matches a prototype-collision environment assignment across disk and manager snapshots", () => {
    const contents = systemdDefinitionWithEnvironment("/managed/config.json", ["__proto__=matching"]);
    const deps = dependencies(
      new TextEncoder().encode(contents),
      {
        status: 0,
        stdout: managerOutput({ Environment: "PI_WEB_CONFIG=/managed/config.json __proto__=matching" }),
        stderr: "",
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
  });

  it.each([
    {
      name: "only on disk",
      diskAssignments: ["__proto__=disk"],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json",
    },
    {
      name: "only in the manager",
      diskAssignments: [],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json __proto__=manager",
    },
    {
      name: "with conflicting values",
      diskAssignments: ["__proto__=disk"],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json __proto__=manager",
    },
  ])("fails closed when a prototype-collision environment assignment exists $name", ({
    diskAssignments,
    managerEnvironment,
  }) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(
        new TextEncoder().encode(systemdDefinitionWithEnvironment("/managed/config.json", diskAssignments)),
        { status: 0, stdout: managerOutput({ Environment: managerEnvironment }), stderr: "" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected prototype-collision environment mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("rejects a duplicate prototype-collision assignment in the effective manager environment", () => {
    const contents = systemdDefinitionWithEnvironment("/managed/config.json", ["__proto__=matching"]);
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(
        new TextEncoder().encode(contents),
        {
          status: 0,
          stdout: managerOutput({
            Environment: "PI_WEB_CONFIG=/managed/config.json __proto__=matching __proto__=matching",
          }),
          stderr: "",
        },
      ),
      "restart",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected duplicate manager environment assignment to fail");
    expect(result.message).toContain("unrecognized Environment");
  });

  it("recovers a legacy systemd [unprintable] environment losslessly from D-Bus", () => {
    const configPath = "/managed/é config with space.json";
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(contents, {
      status: 0,
      stdout: 'as 1 "PI_WEB_CONFIG=/managed/\\303\\251 config with space.json"\n',
      stderr: "",
    });

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", [
      "--user",
      "get-property",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/pi_2dweb_2dweb_2eservice",
      "org.freedesktop.systemd1.Service",
      "Environment",
    ]);
  });

  it.each([
    {
      name: "apostrophe",
      configPath: "/managed/o'brien/config.json",
      systemctlEnvironment: "PI_WEB_CONFIG=/managed/o'brien/config.json",
    },
    {
      name: "double quote",
      configPath: '/managed/"quoted"/config.json',
      systemctlEnvironment: 'PI_WEB_CONFIG=/managed/"quoted"/config.json',
    },
    {
      name: "backslash",
      configPath: String.raw`/managed/back\slash/config.json`,
      systemctlEnvironment: String.raw`PI_WEB_CONFIG=/managed/back\slash/config.json`,
    },
    {
      name: "tab",
      configPath: "/managed/with\ttab/config.json",
      systemctlEnvironment: "PI_WEB_CONFIG=/managed/with\ttab/config.json",
    },
  ])("recovers a legacy systemd environment containing a raw $name", ({ configPath, systemctlEnvironment }) => {
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(
      contents,
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${configPath}`]), stderr: "" },
      systemctlEnvironment,
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "restart",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
  });

  it("recovers a matching legacy systemd environment ending in a raw carriage return", () => {
    const configPath = "/config/managed.json\r";
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(
      contents,
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${configPath}`]), stderr: "" },
      `PI_WEB_CONFIG=${configPath}`,
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", expect.any(Array));
  });

  it("fails closed when a legacy systemd environment ending in a raw carriage return differs from disk", () => {
    const diskConfigPath = "/config/managed.json";
    const managerConfigPath = `${diskConfigPath}\r`;
    const deps = legacySystemdDependencies(
      systemdDefinition(diskConfigPath),
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${managerConfigPath}`]), stderr: "" },
      `PI_WEB_CONFIG=${managerConfigPath}`,
    );

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected trailing-carriage-return manager mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", expect.any(Array));
  });

  it("fails closed when legacy systemd's lossless environment differs from disk", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/a with space.json"), {
      status: 0,
      stdout: 'as 1 "PI_WEB_CONFIG=/config/b with space.json"\n',
      stderr: "",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected legacy systemd environment mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("surfaces a failed lossless legacy systemd environment query", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/with space.json"), {
      status: 127,
      stdout: "",
      stderr: "busctl: command not found",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failed busctl inspection to fail");
    expect(result.message).toContain("losslessly");
    expect(result.message).toContain("[unprintable]");
    expect(result.message).toContain("busctl: command not found");
  });

  it("rejects malformed lossless legacy systemd environment output", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/with space.json"), {
      status: 0,
      stdout: 'as 2 "PI_WEB_CONFIG=/config/with space.json"\n',
      stderr: "",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed busctl environment to fail");
    expect(result.message).toContain("busctl returned an unrecognized Environment");
  });

  it.each([
    [
      "drop-ins",
      managerOutput({ DropInPaths: "/home/user/.config/systemd/user/pi-web-web.service.d/override.conf" }),
      "effective drop-ins",
    ],
    [
      "environment files",
      managerOutput({ EnvironmentFiles: "/home/user/pi-web.env (ignore_errors=no)" }),
      "EnvironmentFile inputs",
    ],
    ["stale manager state", managerOutput({ NeedDaemonReload: "yes" }), "daemon-reload"],
    ["another fragment", managerOutput({ FragmentPath: "/usr/lib/systemd/user/pi-web-web.service" }), "instead of"],
  ])("fails closed for systemd %s", (_name, output, expectedMessage) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(undefined, { status: 0, stdout: output, stderr: "" }),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected effective systemd inspection to fail");
    expect(result.message).toContain(expectedMessage);
  });

  it("rejects a read/reload interleaving whose manager environment belongs to another snapshot", () => {
    let snapshotRead = false;
    const deps = dependencies(new TextEncoder().encode(systemdDefinition("/config/a.json")));
    vi.mocked(deps.readFile).mockImplementation(() => {
      snapshotRead = true;
      return new TextEncoder().encode(systemdDefinition("/config/a.json"));
    });
    vi.mocked(deps.capture).mockImplementation(() => {
      expect(snapshotRead).toBe(true);
      return {
        status: 0,
        stdout: managerOutput({ Environment: "PI_WEB_CONFIG=/config/b.json" }),
        stderr: "",
      };
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected interleaved systemd snapshots to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("rejects malformed systemctl environment serialization", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(undefined, {
        status: 0,
        stdout: managerOutput({ Environment: '"PI_WEB_CONFIG=/unterminated' }),
        stderr: "",
      }),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed manager environment to fail");
    expect(result.message).toContain("unrecognized Environment");
  });

  it("surfaces a failed systemd manager inspection after taking a strict fragment snapshot", () => {
    const deps = dependencies();
    vi.mocked(deps.capture).mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus" });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected manager inspection failure");
    expect(result.message).toContain("Failed to connect to bus");
    expect(deps.readFile).toHaveBeenCalledWith(servicePath);
  });

  it.each(["systemd", "launchd"] as const)("rejects malformed UTF-8 bytes in %s definitions", (kind) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind, label: kind },
      [source],
      dependencies(Uint8Array.from([0x5b, 0x53, 0xff, 0x5d])),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected strict UTF-8 decoding to fail");
    expect(result.message).toContain("not valid UTF-8");
  });

  it("accepts an unloaded LaunchAgent that start can bootstrap from the inspected plist", () => {
    const launchdSource = { ...source, path: launchdPath };
    const deps = dependencies(
      new TextEncoder().encode(launchdDefinition("/managed/config.json")),
      {
        status: 113,
        stdout: "",
        stderr: `Could not find service "com.pi-web.web" in domain for user gui: 501`,
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [launchdSource],
      deps,
      "start",
    )).toMatchObject({ ok: true });
    expect(deps.capture).toHaveBeenCalledWith("launchctl", ["print", launchdTarget]);
  });

  it("binds an already-loaded LaunchAgent to its plist origin and managed config", () => {
    const contents = launchdDefinition("/managed/config with space.json");
    const deps = dependencies(
      new TextEncoder().encode(contents),
      { status: 0, stdout: launchdPrint(launchdPath, "/managed/config with space.json"), stderr: "" },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      deps,
      "doctor",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
  });

  it("rejects a LaunchAgent loaded from another plist", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition("/managed/config.json")),
        {
          status: 0,
          stdout: launchdPrint("/Library/LaunchAgents/com.pi-web.web.plist", "/managed/config.json"),
          stderr: "",
        },
      ),
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a foreign loaded plist to fail");
    expect(result.message).toContain("instead of the installed PI WEB definition");
    expect(result.message).toContain("pi-web restart");
  });

  it("rejects stale loaded LaunchAgent config even when the plist path still matches", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition("/config/new.json")),
        { status: 0, stdout: launchdPrint(launchdPath, "/config/old.json"), stderr: "" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale loaded config to fail");
    expect(result.message).toContain("PI_WEB_CONFIG");
    expect(result.message).toContain("/config/old.json");
    expect(result.message).toContain("/config/new.json");
  });

  it("lets launchd restart inspect disk while its bootout/bootstrap path repairs stale loaded state", () => {
    const deps = dependencies(
      new TextEncoder().encode(launchdDefinition("/config/new.json")),
      { status: 0, stdout: launchdPrint("/another/path.plist", "/config/old.json"), stderr: "" },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      deps,
      "restart",
    )).toMatchObject({ ok: true });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("surfaces launchctl inspection errors instead of treating every failure as unloaded", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition()),
        { status: 1, stdout: "", stderr: "Operation not permitted" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected launchctl inspection error");
    expect(result.message).toContain("Operation not permitted");
  });
});
