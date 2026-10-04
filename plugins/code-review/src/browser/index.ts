import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { ReviewPanel, type FeedbackErrorKind } from "./panel.js";
import { ReviewChips } from "./chips.js";
import { randomId, ReviewStore, workspaceKey } from "./model.js";
import { IndexedDBReviewStorage } from "./storage.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Code Review",
  activate({ html, runtimePluginId, lifetimeSignal }) {
    class Panel extends ReviewPanel {}
    customElements.define(`pi-web-code-review-${randomId()}`, Panel);
    let panel: Panel | undefined;
    let owner: string | undefined;
    let disposed = false;
    const notices = new Map<string, string>();
    const errors = new Map<string, Record<FeedbackErrorKind, string>>();
    const updateFeedbackError = (key: string, message: string, kind: FeedbackErrorKind) => {
      if (disposed || lifetimeSignal.aborted) return;
      const current = { ...(errors.get(key) ?? { acceptance: "", action: "", read: "" }), [kind]: message };
      if (current.acceptance === "" && current.action === "" && current.read === "") errors.delete(key); else errors.set(key, current);
      if (owner === key) panel?.setFeedbackError(message, kind);
    };
    const badges = new Map<string, number | "!" | undefined>();
    const reads = new Map<string, object>();
    const renderBadge = new Map<string, () => void>();
    let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel("pi-web-code-review:commits"); }
    catch (error) { console.error("[Code Review] Cross-tab notifications unavailable", error); }
    const refreshBadge = (key: string) => {
      if (disposed || lifetimeSignal.aborted) return;
      const token = {}; reads.set(key, token);
      void store.load(key).then((comments) => {
        if (lifetimeSignal.aborted || reads.get(key) !== token) return;
        badges.set(key, comments.length || undefined);
        renderBadge.get(key)?.();
      }, () => {
        if (lifetimeSignal.aborted || reads.get(key) !== token) return;
        badges.set(key, "!"); renderBadge.get(key)?.();
      });
    };
    const storage = new IndexedDBReviewStorage(globalThis.indexedDB, (key) => {
      if (disposed || lifetimeSignal.aborted) return;
      refreshBadge(key);
      channel?.postMessage(key);
    });
    const store = new ReviewStore(storage, { getItem: (key) => localStorage.getItem(key) });
    const chips = new ReviewChips(store, (workspace, message, error, kind = "action") => {
      if (error !== undefined) console.error(`[Code Review] ${message}`, error);
      if (disposed || lifetimeSignal.aborted) return;
      if (error === undefined) notices.set(workspace, message);
      else {
        notices.delete(workspace);
        updateFeedbackError(workspace, message, kind);
      }
      if (owner === workspace) panel?.refreshFeedback(error === undefined ? message : undefined);
      refreshBadge(workspace);
      panel?.context.host.requestRender();
    });
    if (channel !== undefined) channel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string" || lifetimeSignal.aborted) return;
      chips.storageChanged(event.data);
      if (owner === event.data) panel?.refreshFeedback();
      refreshBadge(event.data);
    };
    const closeChannel = () => { channel?.close(); channel = undefined; };
    lifetimeSignal.addEventListener("abort", closeChannel, { once: true });
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
            const key = workspaceKey(context);
            renderBadge.set(key, () => { context.host.requestRender(); });
            if (!badges.has(key)) { badges.set(key, undefined); refreshBadge(key); }
            return badges.get(key);
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
              panel.updateContext(context);
              panel.onFeedbackError = (message, kind) => { updateFeedbackError(key, message, kind); };
              panel.setFeedbackError(errors.get(key)?.acceptance ?? "", "acceptance");
              panel.setFeedbackError(errors.get(key)?.action ?? "", "action");
              panel.setFeedbackError(errors.get(key)?.read ?? "", "read");
              panel.refreshFeedback(notices.get(key));
            }
            panel.updateContext(context);
            return html`${panel}`;
          },
        }],
      },
      dispose() {
        disposed = true;
        closeChannel(); lifetimeSignal.removeEventListener("abort", closeChannel);
        chips.dispose(); storage.dispose(); notices.clear(); errors.clear(); reads.clear(); renderBadge.clear();
        panel?.remove(); panel = undefined;
      },
    };
  },
};
export default plugin;
