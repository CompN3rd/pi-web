import { describe, expect, it } from "vitest";
import { isKnownAutoInstallablePiPackageId, KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS } from "./knownAutoInstallPiPackages.js";

describe("isKnownAutoInstallablePiPackageId", () => {
  it("recognizes the relays package as a known auto-installable package", () => {
    expect(KNOWN_AUTO_INSTALLABLE_PI_PACKAGE_IDS).toContain("@jmfederico/pi-relay");
    expect(isKnownAutoInstallablePiPackageId("@jmfederico/pi-relay")).toBe(true);
  });

  it("rejects package ids that are not known auto-installable packages", () => {
    expect(isKnownAutoInstallablePiPackageId("@acme/unrelated-package")).toBe(false);
  });
});
