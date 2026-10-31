import type { PluginLocalization } from "@jmfederico/pi-web/plugin-api";
import definitions from "./mermaid.messages";

export function createMermaidContent(localization: PluginLocalization) {
  return { localization, messages: localization.registerMessages("preview", definitions) };
}

export type MermaidContent = ReturnType<typeof createMermaidContent>;
