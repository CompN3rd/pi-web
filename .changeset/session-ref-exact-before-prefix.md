---
"@jmfederico/pi-web": patch
---

Resolve a shortened session reference the same way everywhere: an id that exactly matches a session always opens that session, and an ambiguous prefix now picks the same session the session list shows for it. Previously opening a session ranked ambiguous prefix matches by creation time while the list ranked them by last-modified time, so the two could disagree.
