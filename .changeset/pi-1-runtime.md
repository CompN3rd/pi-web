---
"@jmfederico/pi-web": patch
---

Require Pi 1.x for all Pi SDK dependencies and bundled companions; Pi 0.x is no longer supported, and Pi 2.x is outside the supported range. Update Pi and PI WEB together, then restart the web/API service before the session daemon. Restarting the daemon interrupts active sessions.

Keep run-ending question and subsession-yield tools out of codemode scripts, preserve Pi's recorded thinking level, and keep nested tool calls attached to their parent transcript result across reconnects. Explicitly reject virtual-model routers because their session-bound context cannot safely use PI WEB's shared model runtime; select a physical model instead.
