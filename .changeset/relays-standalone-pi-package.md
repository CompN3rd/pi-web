---
"@jmfederico/pi-web": patch
---

The bundled `relays` plugin (`pi-web-plugins/relays/`) is now also a standalone Pi package (`@jmfederico/pi-relay`, versioned independently) with its own name and version, so a plain `pi` user with no PI WEB installed can install the directory with `pi install <path>` and get the `/relay`/`/relay-worktree` prompt templates and the `relay` skill in any `pi` session. Nothing changes for existing PI WEB users: the plugin keeps the same id, browser contribution, and bundled discovery, and remains enabled by default exactly as before. Publishing the package to npm and auto-installing it for `pi`-only users remain future work.
