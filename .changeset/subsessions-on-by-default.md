---
"@jmfederico/pi-web": patch
---

Enable tracked subsessions by default. Agents now receive the `spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, and `yield_to_subsessions` tools out of the box; set the `subsessions` config key or the `PI_WEB_SUBSESSIONS` environment variable to `false` to opt out. Tracked subsessions still require `spawnSessions` (also on by default). Restart the session daemon after upgrading for the new default to apply.
