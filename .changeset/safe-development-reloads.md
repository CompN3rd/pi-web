---
"@jmfederico/pi-web": patch
---

Keep the session daemon outside development autoreload so UI/API restarts do not stop active sessions. Preserve the last successful bundled plugin build on compilation errors and watch added or replaced plugin directories.

Refresh app data now rediscovers and reloads browser plugins, cleans up removed/replaced activations, and keeps working plugins when a replacement fails. Package discovery rereads settings without restarting services. Custom-element class changes and unversioned transitive imports still require a full page reload; existing agent resources are not reloaded.
