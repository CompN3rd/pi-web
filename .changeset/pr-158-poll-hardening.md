---
"@jmfederico/pi-web": patch
---

Bound the idle-session transcript snapshot cache so a long-running session daemon no longer accumulates the parsed transcript of every session ever polled; snapshots are now evicted least-recently-used first past a small limit.

Fix status and message reads for idle sessions whose transcript file does not exist on disk (never persisted yet, or removed externally): they now serve the live runtime branch instead of failing.

Speed up polling of an idle session whose transcript file keeps growing: when another process appends to the file, only the appended bytes are read and parsed instead of the whole transcript being re-read every few seconds. Any change other than a pure append (replacement, truncation, in-place rewrite) still triggers a full re-read.
