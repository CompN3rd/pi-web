---
"@jmfederico/pi-web": patch
---

Scope tracked subsessions (beta) to the spawning session's working directory. `spawn_subsession` no longer takes a `cwd` parameter, so a tracked child always runs in its parent's workspace and stays visible in the parent's session tree. To work in another workspace, instruct the child to do so, or use `spawn_session` for an independent session there.
