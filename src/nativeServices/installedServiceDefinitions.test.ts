import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  inspectInstalledNativeServiceDefinitions,
  type InstalledNativeServiceDefinitionDependencies,
  type InstalledNativeServiceDefinitionSource,
} from "./installedServiceDefinitions.js";

const servicePath = "/home/user/.config/systemd/user/pi-web-web.service";
const source: InstalledNativeServiceDefinitionSource = {
  id: "web",
  path: servicePath,
  systemdName: "pi-web-web.service",
};

function managerOutput(overrides: Partial<Record<"LoadState" | "FragmentPath" | "DropInPaths" | "NeedDaemonReload" | "EnvironmentFiles", string>> = {}): string {
  const lines = [
    `LoadState=${overrides.LoadState ?? "loaded"}`,
    `FragmentPath=${overrides.FragmentPath ?? servicePath}`,
    `DropInPaths=${overrides.DropInPaths ?? ""}`,
    `NeedDaemonReload=${overrides.NeedDaemonReload ?? "no"}`,
  ];
  // systemctl omits EnvironmentFiles entirely when the effective array is empty.
  if (overrides.EnvironmentFiles !== undefined) lines.push(`EnvironmentFiles=${overrides.EnvironmentFiles}`);
  return lines.join("\n");
}

function dependencies(
  contents: Uint8Array = new TextEncoder().encode("[Service]\n"),
  output = managerOutput(),
): InstalledNativeServiceDefinitionDependencies {
  return {
    readFile: vi.fn(() => contents),
    realpath: vi.fn((path: string) => path),
    capture: vi.fn(() => ({ status: 0, stdout: output, stderr: "" })),
  };
}

describe("installed native-service definition boundary", () => {
  it("reads the PI WEB fragment only after systemd confirms its effective context", () => {
    const deps = dependencies(new TextEncoder().encode("[Service]\nDescription=é\n"));

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
    )).toEqual({
      ok: true,
      value: [{ id: "web", contents: "[Service]\nDescription=é\n" }],
    });
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
    ]);
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
      dependencies(undefined, output),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected effective systemd inspection to fail");
    expect(result.message).toContain(expectedMessage);
  });

  it("surfaces a failed systemd manager inspection after taking a strict fragment snapshot", () => {
    const deps = dependencies();
    vi.mocked(deps.capture).mockReturnValue({ status: 1, stdout: "", stderr: "Failed to connect to bus" });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
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
      dependencies(Uint8Array.from([0x5b, 0x53, 0xff, 0x5d]), managerOutput()),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected strict UTF-8 decoding to fail");
    expect(result.message).toContain("not valid UTF-8");
  });

  it("does not query systemd while reading a LaunchAgent", () => {
    const deps = dependencies(new TextEncoder().encode("<plist/>"));

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ id: "web", path: "/home/user/Library/LaunchAgents/com.pi-web.web.plist", systemdName: "pi-web-web.service" }],
      deps,
    )).toEqual({ ok: true, value: [{ id: "web", contents: "<plist/>" }] });
    expect(deps.capture).not.toHaveBeenCalled();
  });
});
