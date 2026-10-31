# Reload boundaries

PI WEB has three runtime owners: the browser, the web/API process, and the long-lived session daemon. Reload the owner of the changed code, not every service. A browser reload or web/API restart does not intentionally stop agent sessions or daemon-owned terminals. Restarting the daemon does.

## What to reload

| Changed component | How changes become visible | Limitations |
| --- | --- | --- |
| Local or Pi-package PI WEB browser plugins | Choose **Refresh app data** in the browser. Discovery rereads package settings, imports fresh entrypoints, replaces successful activations, and removes missing plugins. | No daemon restart. Failed replacement retains the previous activation. See [plugin lifecycle and browser constraints](plugins.md). |
| Bundled PI WEB plugin TypeScript in development | `dev:web` rebuilds output on edits, additions, and deletions; then choose **Refresh app data**. | Compilation failure retains last good output. Building alone does not replace an activation in an open tab. |
| Browser application code and styles | Vite in `dev:client` handles development updates; reload the tab if a component cannot be replaced in place. | Production browser code requires a rebuilt installation and page reload. Unsaved browser-only state may be lost; daemon work survives. |
| Browser themes | Select a theme in the app; plugin-supplied theme contributions participate in plugin refresh. | Pi terminal themes and terminal keybindings are not the browser UI's theme/keyboard configuration. |
| Web/API implementation | `dev:web` watches source; the split web development service can restart independently. | Production code requires rebuilding/updating and restarting the web process. Connections may briefly drop and reconnect. |
| Agent extensions, skills, prompt templates, context files, and session settings | Loaded when the session runtime is created. | Chat `/reload` is currently advertised but unsupported. **Refresh app data does not reload these resources.** See the SDK safety boundary below. |
| Model definitions and authentication | Model-list/selection paths refresh the model registry; authentication actions refresh credentials and publish changes. | These are not general extension/resource reloads. Environment changes are not imported into an already running process. |
| Daemon implementation, SDK implementation, daemon environment, and transport configuration | Update/build as needed, then manually restart the daemon. | This interrupts active agents and terminals. Finish their work first; browser refresh cannot replace this code safely. |
| Plugin package development scripts | The development supervisor polls `plugins/*/package.json` every 500 ms. Added packages start automatically; removed packages or dev scripts stop; manifest edits restart only the affected watcher. | Invalid JSON retains the running watcher until repaired. Replacement/shutdown terminates the owned process tree, with a one-second grace period on POSIX. Each package owns its source watcher; no daemon restart is needed. |

Browser plugins run trusted code in the browser, not in the daemon. A daemon restart is not a browser-plugin reload mechanism.

## Browser plugin limits

Fresh entrypoint URLs do not invalidate unchanged transitive ES-module import URLs. Bundle plugin dependencies or version those imports. JavaScript custom-element definitions cannot be replaced under the same name; changes to those classes require a full page reload. Activation can return a cleanup function, but module-level side effects cannot be undone automatically. Fresh module instances remain cached until page reload.

## SDK safety boundary

The installed Pi SDK 0.74.0 exposes `AgentSession.reload()`, but that is not yet a safe drop-in implementation of web chat `/reload`:

- It has no active-work guard and emits extension shutdown before rebuilding the runtime.
- It resets process-global API providers. PI WEB hosts multiple sessions in one daemon, with a shared model registry; a reload must not temporarily or permanently remove another session's provider.
- Its matching `session_start` reload event depends on extension host bindings. PI WEB's current session host only subscribes to session events, which is not equivalent to binding extension lifecycle/UI/command actions.

An isolated, no-model-call probe confirmed that reload is accepted while a shell command is running, removes an unrelated registered API provider, and emits shutdown without startup when host bindings are absent. The shell survived that probe; that does **not** establish safety for extension-owned tools or other concurrent sessions. A safe session-resource reload needs to address these boundaries before exposing the SDK call.

These observations concern the installed SDK version, not a promise about newer SDK releases. They are not a reason to restart the daemon casually: a restart stops active work too.

## Operating split services

Development uses a long-lived `dev:sessiond` process separately from `npm run dev` (web/API, plugin builds, and Vite). Do not put the daemon under an automatic source watcher.

When daemon-loaded code actually changes, finish active work and manually run:

```bash
systemctl --user restart pi-web-sessiond.service
```

See the [README](../README.md) for split-service setup. No service restart is required merely to read these instructions or refresh browser plugins.
