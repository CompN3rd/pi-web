---
"@jmfederico/pi-web": patch
---

Bound the idle-session transcript snapshot cache so a long-running session daemon no longer accumulates the parsed transcript of every session ever polled; snapshots are now evicted least-recently-used first past a small limit.

Fix status and message reads for idle sessions whose transcript file does not exist on disk (never persisted yet, or removed externally): they now serve the live runtime branch instead of failing.
