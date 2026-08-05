---
"@jmfederico/pi-web": patch
---

Keep the session daemon's own runtime environment out of agent processes: agent shells, terminals, and spawned sessions no longer inherit keys such as `NODE_ENV=production` or `PI_WEB_DATA_DIR`, so commands like `npm install` behave normally inside sessions and a second PI WEB instance started from a session no longer picks up the live daemon's data directory or socket.
