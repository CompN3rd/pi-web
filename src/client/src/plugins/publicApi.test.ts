import { expectTypeOf, test } from "vitest";
import type { PluginActivationResult, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import type { PluginActivationResult as RuntimeActivationResult } from "./types";

test("published plugin API supports optional activation cleanup", () => {
  // Keep package authors' explicitly typed return values covered by typecheck.
  const activate = (): PluginActivationResult => ({
    contributions: {},
    dispose: () => undefined,
  });
  const activateWithoutCleanup = (): PluginActivationResult => ({ contributions: {} });

  expectTypeOf(activate).toExtend<PiWebPlugin["activate"]>();
  expectTypeOf(activateWithoutCleanup).toExtend<PiWebPlugin["activate"]>();
  expectTypeOf<PluginActivationResult["dispose"]>()
    .toEqualTypeOf<RuntimeActivationResult["dispose"]>();
});
