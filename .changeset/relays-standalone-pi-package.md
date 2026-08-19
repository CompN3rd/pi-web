---
"@jmfederico/pi-web": patch
---

The `relays` plugin is now a standalone Pi package (`@jmfederico/pi-relay`, versioned independently, shipped at `pi-packages/relays/` inside `@jmfederico/pi-web`) instead of a bundled, directory-scanned PI WEB plugin. A plain `pi` user with no PI WEB installed can install it with `pi install <path>` and get the `/relay`/`/relay-worktree` prompt templates and the `relay` skill in any `pi` session. For PI WEB users, the plugin now needs to be installed as a Pi package (for example from **Settings → Pi packages**) to be available — it is no longer found by PI WEB's bundled plugin scan. Publishing the package to npm remains deferred; automatic install and an opt-out for PI WEB users are in progress in this same release.
