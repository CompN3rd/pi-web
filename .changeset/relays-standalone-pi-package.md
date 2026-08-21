---
"@jmfederico/pi-web": patch
---

Ship Relay as the standalone `@jmfederico/pi-relay` Pi package, sourced from `pi-packages/relays/` and included at `dist/pi-packages/relays/`. Installing the package provides `/relay`, `/relay-worktree`, the `relay` skill, and the Relays PI WEB browser panel/action; Pi package removal removes those package contributions, while `plugins.relays.enabled` only shows or hides the browser panel/action. At session-daemon startup, PI WEB auto-installs Relay for the active agent profile unless that profile previously removed it from **Settings → Pi packages**, and **Available packages** offers one-click reinstall. The shipped path also supports explicit `pi install <path>` outside PI WEB; publishing `@jmfederico/pi-relay` to npm remains deferred.
