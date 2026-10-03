import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { ReviewPanel } from "./panel.js";
import type { ReviewActivationContext } from "./selection.js";
import { randomId, ReviewStore, workspaceKey } from "./model.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Code Review",
  activate({ html, runtimePluginId, selection, lifetimeSignal }: ReviewActivationContext) {
    // Each activation owns its element constructor: different remote package
    // revisions never accidentally mount the first machine's implementation.
    class Panel extends ReviewPanel {}
    customElements.define(`pi-web-code-review-${randomId()}`, Panel);
    const store = new ReviewStore({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => { localStorage.setItem(key, value); },
    });
    let panel: Panel | undefined;
    let owner: string | undefined;
    return {
      contributions: {
        actions: [{
          id: "open", title: "Open Code Review", group: "Workspace",
          enabled: ({ state }) => state.selectedWorkspace !== undefined,
          run: (context) => { context.selectWorkspaceTool(`${runtimePluginId}:review`); },
        }],
        workspacePanels: [{
          id: "review", title: "Review", order: 35,
          invalidationResources: ["workspace.files"],
          badge: (context) => {
            try { return store.load(workspaceKey(context)).length || undefined; }
            catch { return "!"; } // The panel displays the attributed storage failure.
          },
          onInvalidate: (context) => {
            if (panel !== undefined && owner === workspaceKey(context)) panel.revision++;
          },
          render: (context) => {
            const key = workspaceKey(context);
            if (panel === undefined || owner !== key) {
              panel?.remove();
              panel = new Panel(); owner = key;
              panel.store = store; panel.selection = selection; panel.lifetime = lifetimeSignal; panel.revision = 0;
            }
            panel.context = context;
            return html`${panel}`;
          },
        }],
      },
      dispose() { panel?.remove(); panel = undefined; },
    };
  },
};
export default plugin;
