import { describe, expect, it } from "vitest";
import type { PiWebComponentStatus, PiWebReleaseStatus, PiWebStatusResponse, PluginMachine, Workspace } from "@jmfederico/pi-web/plugin-api";
import { componentHealth, createInfoContent } from "./infoInternals.js";
import { LocalizationService } from "../../src/client/src/localization/service.js";

const service = new LocalizationService({ preferences: { language: "en", formatLocale: "en-US", timeZone: "UTC" } });
const { componentDetails, diagnosticsSummary, installationLabel, piVersionDriftNote, releaseSummary, workspaceFlags } = createInfoContent(service);

describe("componentHealth", () => {
  it("reports current when the component is available and not stale", () => {
    expect(componentHealth(componentStatus())).toBe("current");
  });

  it("reports restart needed when the installed version is newer than the running one", () => {
    expect(componentHealth(componentStatus({ stale: true }))).toBe("restart needed");
  });

  it("reports unavailable when the component cannot be reached", () => {
    expect(componentHealth(componentStatus({ available: false, stale: true }))).toBe("unavailable");
  });
});

describe("releaseSummary", () => {
  it("names the latest version when an update is available", () => {
    expect(releaseSummary(release({ updateAvailable: true, latestVersion: "1.2.3" }))).toBe("Update available: 1.2.3");
  });

  it("still reports an update when the latest version is unknown", () => {
    expect(releaseSummary(release({ updateAvailable: true }))).toBe("Update available");
  });

  it("surfaces a failed release check", () => {
    expect(releaseSummary(release({ error: "registry unreachable" }))).toBe("Update check failed: registry unreachable");
  });

  it("reports skipped checks distinctly from an up-to-date install", () => {
    expect(releaseSummary(release({ skipped: true }))).toBe("Update check skipped");
    expect(releaseSummary(release())).toBe("Up to date");
  });
});

describe("componentDetails", () => {
  it("reports the Pi version as unknown when the component does not report one", () => {
    expect(componentDetails(componentStatusWithoutPi())).toContain("pi unknown");
  });

  it("includes the component error when present", () => {
    const details = componentDetails(componentStatus({ available: false, error: "connection refused" }));
    expect(details).toContain("unavailable");
    expect(details).toContain("error: connection refused");
  });
});

describe("piVersionDriftNote", () => {
  it("is undefined when both components run the same Pi version", () => {
    expect(piVersionDriftNote(componentStatus(), componentStatus({ component: "sessiond" }))).toBeUndefined();
  });

  it("names the session daemon Pi version when it differs from the web process", () => {
    expect(piVersionDriftNote(componentStatus(), componentStatus({ component: "sessiond", piVersion: "0.83.0" }))).toBe("session daemon running 0.83.0");
  });

  it("stays quiet while the session daemon is unavailable or predates Pi version reporting", () => {
    expect(piVersionDriftNote(componentStatus(), componentStatus({ component: "sessiond", available: false, piVersion: "0.83.0" }))).toBeUndefined();
    expect(piVersionDriftNote(componentStatus(), componentStatusWithoutPi({ component: "sessiond" }))).toBeUndefined();
    expect(piVersionDriftNote(componentStatusWithoutPi(), componentStatus({ component: "sessiond", piVersion: "0.83.0" }))).toBeUndefined();
  });
});

describe("diagnosticsSummary", () => {
  it("includes operational versions, installation paths and context for bug reports", () => {
    const summary = diagnosticsSummary({ status: statusResponse(), machine: machineFixture(), workspace: workspaceFixture() });

    const lines = summary.split("\n");
    const web = lines.find((line) => line.startsWith("Web/UI:"));
    const sessiond = lines.find((line) => line.startsWith("Session daemon:"));
    expect(web).toContain("running 1.0.0");
    expect(web).toContain("installed 1.0.1");
    expect(web).toContain("restart needed");
    expect(web).toContain("/usr/lib/node_modules");
    expect(sessiond).toContain("installed 1.0.0");
    expect(sessiond).toContain("current");
    expect(sessiond).toContain("/srv/dev/pi-web");
    for (const detail of [
      "@jmfederico/pi-web", "0.84.1", "1.1.0", "devbox", "git",
      service.date(new Date("2025-01-02T03:04:05Z"), { dateStyle: "medium", timeStyle: "medium" }),
      service.date(new Date("2025-01-02T03:04:06Z"), { dateStyle: "medium", timeStyle: "medium" }),
    ]) {
      expect(summary).toContain(detail);
    }
  });

  it("degrades gracefully when the status and workspace are unavailable", () => {
    const summary = diagnosticsSummary({ status: undefined });

    expect(summary).toContain("unavailable");
    expect(summary).toContain("none selected");
    expect(summary).not.toMatch(/undefined|null/);
  });
});

describe("small formatters", () => {
  it("labels installations", () => {
    expect(installationLabel(undefined)).toBe("installation unknown");
    expect(installationLabel({ kind: "pi-package", source: "Pi package", scope: "user" })).toBe("Pi package · user");
    expect(installationLabel({ kind: "docker", dockerMode: "dev" })).toBe("Docker development runtime");
    expect(installationLabel({ kind: "docker" })).toBe("Docker runtime");
    expect(installationLabel({ kind: "unknown" })).toBe("installation unknown");
  });

  it("describes folder workspaces", () => {
    expect(workspaceFlags({
      id: "ws-1",
      projectId: "proj-1",
      path: "/srv/dev/plain",
      label: "plain",
      isMain: false,
    })).toEqual(["folder workspace"]);
  });
});

function componentStatus(patch: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return {
    component: "web",
    label: "Web/UI",
    runtimeVersion: "1.0.0",
    installedVersion: "1.0.0",
    piVersion: "0.84.1",
    stale: false,
    available: true,
    installation: { kind: "npm-global", path: "/usr/lib/node_modules" },
    ...patch,
  };
}

/** Component status from a host that predates Pi version reporting. */
function componentStatusWithoutPi(patch: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  const component = componentStatus(patch);
  delete component.piVersion;
  return component;
}

function release(patch: Partial<PiWebReleaseStatus> = {}): PiWebReleaseStatus {
  return {
    packageName: "@jmfederico/pi-web",
    updateAvailable: false,
    checkedAt: "2025-01-02T03:04:05Z",
    ...patch,
  };
}

function statusResponse(): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "2025-01-02T03:04:06Z",
    components: {
      web: componentStatus({ installedVersion: "1.0.1", stale: true }),
      sessiond: componentStatus({ component: "sessiond", label: "Session daemon", installation: { kind: "local", path: "/srv/dev/pi-web" } }),
    },
    release: release({ updateAvailable: true, latestVersion: "1.1.0" }),
    commands: {},
    messages: [],
  };
}

function machineFixture(): PluginMachine {
  return { id: "local", name: "devbox", kind: "local" };
}

function workspaceFixture(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    path: "/srv/dev/pi-web",
    label: "pi-web",
    isMain: true,
    provider: {
      pluginId: "git",
      capabilities: { remove: true },
      metadata: { branch: "main" },
    },
    ...patch,
  };
}
