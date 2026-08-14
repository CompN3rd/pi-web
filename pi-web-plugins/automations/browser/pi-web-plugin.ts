import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Automations",
  activate: () => ({ contributions: {} }),
};

export default plugin;
