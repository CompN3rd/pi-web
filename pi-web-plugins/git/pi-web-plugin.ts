import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

/** Browser contributions migrate into this bundled entry in a later slice. */
const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Git",
  activate: () => ({ contributions: {} }),
};

export default plugin;
