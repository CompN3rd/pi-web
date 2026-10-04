import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { ReviewPanel } from "./panel.js";
import { ReviewChips } from "./chips.js";
import { randomId, ReviewStore, storagePrefix, workspaceKey } from "./model.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Code Review",
  activate({ html, runtimePluginId, lifetimeSignal }) {
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
    const notices = new Map<string, { message: string; error?: unknown }>();
    const chips = new ReviewChips(store, (workspace, message, error) => {
      if (error !== undefined) console.error(`[Code Review] ${message}`, error);
      if (lifetimeSignal.aborted) return;
      notices.set(workspace, { message, error });
      if (owner === workspace) panel?.refreshFeedback(message, error);
      panel?.context.host.requestRender();
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(storagePrefix)) return;
      chips.storageChanged(event.key === null ? undefined : event.key.slice(storagePrefix.length));
      panel?.refreshFeedback();
      panel?.context.host.requestRender();
    };
    window.addEventListener("storage", onStorage);
    lifetimeSignal.addEventListener("abort", () => { window.removeEventListener("storage", onStorage); }, { once: true });
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
              panel.store = store; panel.chips = chips; panel.lifetime = lifetimeSignal; panel.revision = 0;
              panel.context = context;
              const notice = notices.get(key);
              if (notice !== undefined) panel.refreshFeedback(notice.message, notice.error);
            }
            panel.context = context;
            return html`${panel}`;
          },
        }],
      },
      dispose() {
        window.removeEventListener("storage", onStorage);
        chips.dispose(); notices.clear(); panel?.remove(); panel = undefined;
      },
    };
  },
};
export default plugin;
