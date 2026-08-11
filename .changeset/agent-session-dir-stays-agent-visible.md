---
"@jmfederico/pi-web": patch
---

Keep `PI_CODING_AGENT_SESSION_DIR` visible to agent processes: when a deployment overrides the session storage directory, `pi` CLIs started from sessions, terminals, and subsessions now use the same session store as the session daemon instead of silently falling back to the default store.
