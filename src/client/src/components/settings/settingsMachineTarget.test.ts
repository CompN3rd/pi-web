import { describe, expect, it } from "vitest";
import type { Machine } from "../../api";
import { PI_WEB_CAPABILITIES } from "../../../../shared/capabilities";
import { agentProfileSettingsSupport, friendlySelectedMachineSettingsErrorMessage, isAgentProfileSettingsSupported, settingsMachineTarget, settingsMachineTargetLabel } from "./settingsMachineTarget";

const remoteMachine: Machine = {
  id: "remote-a",
  name: "Lab Mac",
  kind: "remote",
  baseUrl: "https://lab.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

describe("selected-machine settings target helpers", () => {
  it("uses the selected machine when present and falls back to the local gateway", () => {
    expect(settingsMachineTarget(undefined)).toEqual({ id: "local", name: "local", kind: "local" });
    expect(settingsMachineTarget(remoteMachine)).toEqual({ id: "remote-a", name: "Lab Mac", kind: "remote" });
  });

  it("labels local and remote settings targets factually", () => {
    expect(settingsMachineTargetLabel({ id: "local", name: "local", kind: "local" })).toBe("local (local gateway)");
    expect(settingsMachineTargetLabel(settingsMachineTarget(remoteMachine))).toBe("Lab Mac (remote machine)");
  });

  it("gates remote agent profile edits on their granular capability", () => {
    const target = settingsMachineTarget(remoteMachine);

    expect(agentProfileSettingsSupport({ id: "local", name: "local", kind: "local" }, undefined)).toEqual({ state: "supported" });
    expect(agentProfileSettingsSupport(target, undefined)).toEqual({
      state: "unknown",
      message: "Pi-compatible agent profile support could not be verified on Lab Mac. Reload machine status before changing the profile.",
    });
    expect(agentProfileSettingsSupport(target, {
      ok: true,
      capabilities: [PI_WEB_CAPABILITIES.agentProfileConfig],
    })).toEqual({ state: "supported" });

    const unsupported = agentProfileSettingsSupport(target, { ok: true, capabilities: [PI_WEB_CAPABILITIES.piPackagesManage] });
    expect(isAgentProfileSettingsSupported(unsupported)).toBe(false);
    expect(unsupported).toEqual({
      state: "unsupported",
      message: "Pi-compatible agent profile settings are not available on Lab Mac. Update and restart PI WEB on that machine, then try again.",
    });
  });

  it("scopes remote reachability errors to selected-machine settings", () => {
    const target = settingsMachineTarget(remoteMachine);

    expect(friendlySelectedMachineSettingsErrorMessage("Remote machine unavailable", target)).toBe("Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.");
    expect(friendlySelectedMachineSettingsErrorMessage("Remote machine timeout", target)).toBe("Timed out while contacting Lab Mac for selected-machine settings. The operation may still be running remotely; reload before retrying.");
    expect(friendlySelectedMachineSettingsErrorMessage("Not Found", target)).toBe("Not Found");
    expect(friendlySelectedMachineSettingsErrorMessage("Not Found", { id: "local", name: "local", kind: "local" })).toBe("Not Found");
  });
});
