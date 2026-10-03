import type { PluginActivationContext, PluginRuntimeState } from "@jmfederico/pi-web/plugin-api";

/** Public upstream selection API; optional until it ships in the next v4 declarations.
 * Keep the minimal structural contract so the package also builds on 1.202610.1.
 * Older hosts support review/copy; insertion fails visibly without this service.
 */
export interface SelectionService {
  getSnapshot(): Pick<PluginRuntimeState, "selectedMachine" | "selectedWorkspace" | "selectedSession">;
}
export type ReviewActivationContext = PluginActivationContext & { readonly selection?: SelectionService };
