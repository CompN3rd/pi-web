---
"@jmfederico/pi-web": patch
---

Add trusted server-backed workspace provider plugins. Bundled Git now uses the same public lifecycle, claim, JSON backend, removal, federation, and diagnostics contracts available to installed third-party providers; PI WEB ships no replacement integration. Manage desired state per selected machine, and recover offline with `pi-web plugins disable` or `pi-web plugins safe-start ...` (`serverPlugins.safeStart`, including `bundled-only` and `none`).

Upgrade gateways and remote machines together: newer gateways withhold all remote plugin contributions from older targets that lack the lifecycle contract, while older gateways cannot use Git status/diff from updated targets after the legacy Git routes are removed. After upgrading each target, manually restart `pi-web-sessiond.service`, then reload the browser; a web/API restart alone is insufficient. Restarting sessiond may interrupt active sessions/runtime ownership.
