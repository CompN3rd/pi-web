---
"@jmfederico/pi-web": patch
---

Bound the idle-session transcript snapshot cache so a long-running session daemon no longer accumulates the parsed transcript of every session ever polled; snapshots are now evicted least-recently-used first past a small limit.
