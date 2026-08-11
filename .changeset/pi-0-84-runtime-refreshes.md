---
"@jmfederico/pi-web": patch
---

Upgrade the bundled Pi coding agent to 0.84.1 and require Pi Coding Agent `>=0.84.0`, so update Pi before updating PI WEB. Pi 0.84 makes provider logins, logouts, and catalog refreshes local-only and cancellable by default, so PI WEB no longer forces offline mode while creating its shared model runtime; bounded network catalog refreshes remain confined to the background refresher.
