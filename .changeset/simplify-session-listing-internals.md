---
"@jmfederico/pi-web": patch
---

Simplify session-listing internals: session-open resolution and sibling child counts reuse the memoized listing, and the listing memo rescans changed files whole instead of tracking incremental parse state. No user-visible behavior change.
