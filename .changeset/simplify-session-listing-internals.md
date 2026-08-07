---
"@jmfederico/pi-web": patch
---

Make opening a session and listing sessions share one code path, so the two can no longer disagree about which session a short id refers to or how recently it was modified. The list's cached scan is now also what resolves an open-by-id request, and the cache re-reads a changed session file whole rather than tracking partial parse state, which removes a class of stale-row bugs after a session file is rewritten. Sessions you have not opened yet in a large session directory may take marginally longer to open the first time, since the first open warms that shared cache.
