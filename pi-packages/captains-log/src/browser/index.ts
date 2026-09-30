import type { PiWebPlugin, WorkspacePanelContext, PluginPeerChannel } from "@jmfederico/pi-web/plugin-api";
import { isLogEntry, MAX_FINDINGS, type LogEntry } from "./protocol.js";
import { renderCaptainPanel, selectedSourceSession } from "./panel.js";
import { LOG_CHANNEL, isCaptainServerFrame, type CaptainClientFrame } from "./channelProtocol.js";

const CONNECTING_STATUS = "Connecting to Captain's Log…";

interface PanelState {
  entries: LogEntry[]; selected?: LogEntry; status: string;
  notice?: string; readError?: string; readingId?: string;
  connecting: boolean; channel?: PluginPeerChannel; controller?: AbortController;
  pending?: string; admittedId?: string; failedReadId?: string; revision: number; readRevision: number; updates: Map<string, LogEntry>;
}
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Captain's Log",
  activate({ html, runtimePluginId, lifetimeSignal }) {
    if (!customElements.get("captains-log-lifetime")) {
      customElements.define("captains-log-lifetime", class extends HTMLElement {
        mount?: () => void;
        unmount?: () => void;
        private currentScope: unknown;
        set scope(value: unknown) {
          if (value === this.currentScope) return;
          this.currentScope = value;
          if (this.isConnected) queueMicrotask(() => { if (this.isConnected) this.mount?.(); });
        }
        connectedCallback() { queueMicrotask(() => { if (this.isConnected) this.mount?.(); }); }
        disconnectedCallback() { this.unmount?.(); }
      });
    }
    const states = new Map<string, PanelState>();
    let current: PanelState | undefined;
    function stop(state: PanelState) {
      state.revision++;
      delete state.readingId;
      delete state.readError;
      delete state.failedReadId;
      state.controller?.abort();
      state.channel?.close();
      delete state.channel;
      delete state.controller;
      state.connecting = false;
      if (state.pending !== undefined) state.status = "Channel closed. Admission is uncertain; reconnect before retrying. Questions are never resent automatically.";
    }
    const stopAll = () => { for (const state of states.values()) stop(state); };
    lifetimeSignal.addEventListener("abort", stopAll, { once: true });
    function stateFor(context: WorkspacePanelContext): PanelState {
      const key = JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
      let state = states.get(key);
      if (!state) {
        state = { entries: [], status: CONNECTING_STATUS, connecting: false, revision: 0, readRevision: 0, updates: new Map() };
        states.set(key, state);
      }
      if (current !== state) { if (current) stop(current); current = state; }
      return state;
    }
    function upsert(state: PanelState, entry: LogEntry) {
      state.updates.set(entry.id, entry);
      state.entries = [entry, ...state.entries.filter((item) => item.id !== entry.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (!state.selected || state.selected.id === entry.id || entry.id === state.admittedId || entry.status === "running") {
        if (state.selected?.id !== entry.id) { state.readRevision++; delete state.readingId; }
        state.selected = entry;
      }
      if (entry.id === state.admittedId) delete state.admittedId;
      if (entry.id === state.failedReadId) { delete state.failedReadId; delete state.readError; }
    }
    async function readEntry(context: WorkspacePanelContext, state: PanelState, id: string): Promise<boolean> {
      if (state.readingId === id || (!state.connecting && (state.pending !== undefined || state.admittedId !== undefined))) return false;
      const revision = state.revision;
      const readRevision = ++state.readRevision;
      const before = state.updates.get(id);
      state.readingId = id;
      context.host.requestRender();
      try {
        if (!context.peer?.request) throw new Error("Captain saved records unavailable");
        const entry: unknown = await context.peer.request("read", id, { signal: state.controller?.signal ?? lifetimeSignal });
        if (revision !== state.revision || readRevision !== state.readRevision || lifetimeSignal.aborted) return false;
        if (!isLogEntry(entry)) throw new Error("Invalid Captain record");
        const record = state.updates.get(id) !== before ? state.updates.get(id) ?? entry : entry;
        state.selected = record;
        state.updates.set(id, record);
        state.entries = state.entries.map((item) => item.id === id ? record : item);
        delete state.failedReadId;
        delete state.readError;
        context.host.requestRender();
        return true;
      } catch (error) {
        if (revision !== state.revision || readRevision !== state.readRevision || lifetimeSignal.aborted) return false;
        state.failedReadId = id;
        state.readError = `Could not load the saved translation: ${String(error)}`;
        return false;
      } finally {
        if (revision === state.revision && readRevision === state.readRevision) {
          delete state.readingId;
          context.host.requestRender();
        }
      }
    }
    async function connect(context: WorkspacePanelContext, state: PanelState) {
      if (state.channel || state.connecting || lifetimeSignal.aborted) return;
      stop(state);
      const revision = state.revision;
      const controller = new AbortController();
      state.controller = controller;
      state.connecting = true;
      state.updates.clear();
      const live = () => revision === state.revision && !controller.signal.aborted && !lifetimeSignal.aborted;
      state.status = CONNECTING_STATUS;
      delete state.notice;
      context.host.requestRender();
      try {
        if (!context.peer?.openChannel || !context.peer.request) throw new Error("Captain backend channels unavailable on this machine");
        const channel = await context.peer.openChannel(LOG_CHANNEL, null, {
          signal: controller.signal,
          onData(data) {
            if (!live()) return;
            if (!isCaptainServerFrame(data)) { state.status = "Invalid Captain channel frame"; stop(state); context.host.requestRender(); return; }
            if (data.type === "admitted" && data.requestId === state.pending) {
              delete state.pending;
              state.admittedId = data.id;
              state.status = `Backend admitted ${data.id}; admission is not completion.`;
            } else if (data.type === "rejected" && data.requestId === state.pending) {
              delete state.pending; state.status = data.message; state.notice = data.message;
            } else if (data.type === "entry") {
              upsert(state, data.entry);
              state.status = data.saved && data.entry.status !== "running" ? `Backend saved ${data.entry.status} roundtrip.` : `Captain: ${data.entry.stages.at(-1) ?? data.entry.status}`;
            } else if (data.type === "text") {
              const entry = state.updates.get(data.id);
              if (entry) {
                // Host channel payloads are deeply frozen; accumulate in a new owned record.
                const updated = { ...entry, text: (entry.text + data.text).slice(0, MAX_FINDINGS) };
                state.updates.set(data.id, updated);
                state.entries = state.entries.map((item) => item.id === data.id ? updated : item);
                if (state.selected?.id === data.id) state.selected = updated;
              }
            }
            context.host.requestRender();
          },
        });
        if (!live()) { channel.close(); return; }
        state.channel = channel;
        void channel.closed.then((closed) => {
          if (!live()) return;
          stop(state);
          state.status = `${closed.error?.message ?? "Channel closed"}. Admission may be uncertain. Reconnect to restore saved state; translations are never resent automatically.`;
          context.host.requestRender();
        });
        // Subscribe first, then merge the snapshot without overwriting newer pushed entries.
        const result: unknown = await context.peer.request("list", null, { signal: controller.signal });
        if (!live()) return;
        if (!Array.isArray(result) || !result.every(isLogEntry)) throw new Error("Invalid Captain snapshot");
        state.entries = [...state.updates.values(), ...result.filter((entry) => entry.sourceSessionId !== undefined && !state.updates.has(entry.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const preferredId = state.admittedId ?? (state.pending === undefined ? state.selected?.id : undefined);
        delete state.pending;
        const id = state.entries.find((entry) => entry.id === preferredId)?.id ?? state.entries[0]?.id;
        let loaded = true;
        if (id !== undefined && state.entries.some((entry) => entry.id === id)) {
          const pushed = state.updates.get(id);
          if (pushed) state.selected = pushed;
          else loaded = await readEntry(context, state, id);
        } else delete state.selected;
        if (!live()) return;
        delete state.admittedId;
        if (loaded) {
          delete state.failedReadId;
          delete state.readError;
        }
        // Connection readiness is independent of a saved-read failure. Preserve
        // any status published by the channel while the snapshot/read was pending.
        if (state.status === CONNECTING_STATUS) state.status = "Connected. Live updates arrive from the backend.";
        state.connecting = false;
        context.host.requestRender();
      } catch (error) {
        if (!live()) return;
        stop(state); state.status = `${String(error)}. Reconnect explicitly; no translation was resent.`;
        context.host.requestRender();
      }
    }
    function translate(context: WorkspacePanelContext, state: PanelState) {
      const source = selectedSourceSession(context);
      if (!source || !state.channel || state.connecting || state.pending !== undefined || state.admittedId !== undefined || lifetimeSignal.aborted || state.entries.some((entry) => entry.status === "running" || entry.sessionId === source.id)) return;
      state.pending = crypto.randomUUID();
      // A new roundtrip owns selection/status; late history reads must not win.
      state.readRevision++;
      delete state.readingId;
      delete state.failedReadId;
      delete state.readError;
      delete state.notice;
      state.status = `Translation queued for source session ${source.id}; waiting for backend admission.`;
      const frame: CaptainClientFrame = { type: "translate", requestId: state.pending, sourceSessionId: source.id };
      try { state.channel.send(frame); }
      catch (error) { stop(state); state.status = `${String(error)}. Admission is uncertain; reconnect before retrying.`; }
      context.host.requestRender();
    }
    return {
      contributions: {
        actions: [{
          id: "summon", title: "Open pirate translator", group: "Captain's Log",
          enabled: ({ state }) => Boolean(state.selectedWorkspace),
          run: ({ selectWorkspaceTool }) => { selectWorkspaceTool(`${runtimePluginId}:log`); },
        }],
        workspacePanels: [{
          id: "log", title: "Captain's Log",
          render(context) {
            const state = stateFor(context);
            const source = selectedSourceSession(context);
            return html`<captains-log-lifetime .mount=${() => { void connect(context, state); }} .unmount=${() => { stop(state); }} .scope=${state}>
              ${renderCaptainPanel(html, {
                ...state,
                connected: state.channel !== undefined && context.peer?.openChannel !== undefined,
                pending: state.pending !== undefined || state.admittedId !== undefined,
                reading: state.readingId !== undefined,
                machineName: context.machine.name,
                ...(source ? { source } : {}),
                onTranslate() { translate(context, state); },
                onReconnect() { void connect(context, state); },
                onRead(id) { void readEntry(context, state, id); },
                onOpenSource(sessionId) {
                  void context.navigate({ machineId: context.machine.id, projectId: context.workspace.projectId, workspaceId: context.workspace.id, sessionId, view: "chat" });
                },
              })}
            </captains-log-lifetime>`;
          },
        }],
      },
      dispose() {
        stopAll();
        lifetimeSignal.removeEventListener("abort", stopAll);
        states.clear();
      },
    };
  },
};
export default plugin;
