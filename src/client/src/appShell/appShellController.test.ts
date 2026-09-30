// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { AppShellController } from "./appShellController";

afterEach(() => vi.restoreAllMocks());

it("resynchronizes media state after a detached host reconnects", () => {
  const desktop = window.matchMedia("(min-width: 1181px)");
  const mobile = window.matchMedia("(max-width: 760px)");
  const pwa = window.matchMedia("(display-mode: standalone)");
  const desktopMatches = vi.spyOn(desktop, "matches", "get").mockReturnValue(true);
  const mobileMatches = vi.spyOn(mobile, "matches", "get").mockReturnValue(false);
  const pwaMatches = vi.spyOn(pwa, "matches", "get").mockReturnValue(false);
  const host = { addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true) };
  const controller = new AppShellController(host, { desktopSideBySideMedia: desktop, mobileNavigationMedia: mobile, pwaDisplayModeMedia: [pwa] });
  controller.hostConnected();
  expect(host.requestUpdate).not.toHaveBeenCalled();
  controller.hostDisconnected();
  desktopMatches.mockReturnValue(false);
  mobileMatches.mockReturnValue(true);
  pwaMatches.mockReturnValue(true);
  controller.hostConnected();
  expect(controller.isDesktopSideBySideLayout).toBe(false);
  expect(controller.isMobileNavigationLayout).toBe(true);
  expect(controller.isPwaDisplayMode).toBe(true);
  expect(host.requestUpdate).toHaveBeenCalledOnce();
  controller.hostDisconnected();
});
