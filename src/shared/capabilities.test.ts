import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("advertises web-only capabilities without requiring session daemon support", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.piPackagesManage);
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.selectedMachineSettings);
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.agentProfileConfig);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.piPackagesManage);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.selectedMachineSettings);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.agentProfileConfig);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, PI_WEB_CAPABILITIES.agentProfileConfig] },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, PI_WEB_CAPABILITIES.agentProfileConfig]);
  });

  it("negotiates daemon-authoritative unread state only when both runtimes support it", () => {
    const unread = PI_WEB_CAPABILITIES.sessionsUnread;
    expect(WEB_RUNTIME_CAPABILITIES).toContain(unread);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(unread);
    expect(parseKnownPiWebCapabilities([unread, "future.capability"])).toEqual([unread]);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [unread] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(unread);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [unread] },
    })).not.toContain(unread);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [unread] },
      sessiond: { available: true, capabilities: [unread] },
    })).toContain(unread);
  });

  it("renders the question card only when both runtimes support daemon-owned asks", () => {
    const askUser = PI_WEB_CAPABILITIES.sessionsAskUser;
    expect(WEB_RUNTIME_CAPABILITIES).toContain(askUser);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(askUser);
    expect(parseKnownPiWebCapabilities([askUser, "future.capability"])).toEqual([askUser]);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [askUser] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(askUser);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [askUser] },
    })).not.toContain(askUser);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [askUser] },
      sessiond: { available: true, capabilities: [askUser] },
    })).toContain(askUser);
  });

  it("keeps only known string capabilities when parsing runtime data", () => {
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, "future.capability"])).toEqual([PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings]);
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.piPackagesManage, 1])).toBeUndefined();
  });
});
