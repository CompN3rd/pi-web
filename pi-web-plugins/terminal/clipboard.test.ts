import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "./clipboard";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, null, {}, { writeText: "not callable" }])("falls back for a partial Clipboard implementation: %j", async (clipboard) => {
  vi.stubGlobal("navigator", { clipboard });
  vi.stubGlobal("window", { isSecureContext: true });
  // The node environment has no selection API, so fallback returns false instead of throwing.
  await expect(writeClipboardText("copy")).resolves.toBe(false);
});
