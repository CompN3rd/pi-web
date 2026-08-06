---
"@jmfederico/pi-web": patch
---

Speed up session listings and opening persisted sessions in projects with large session histories. The session daemon no longer parses every session transcript on each request: listings use a lightweight summary scan with an incremental cache that only re-reads newly appended transcript data, and opening a session no longer triggers redundant full-workspace scans.
