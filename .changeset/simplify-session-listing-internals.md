---
"@jmfederico/pi-web": patch
---

Simplify session-listing internals: session-open resolution reuses the memoized listing, and the listing memo rescans changed session files whole instead of tracking incremental parse state.
