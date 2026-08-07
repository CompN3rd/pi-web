---
"@jmfederico/pi-web": patch
---

Opening a session by a shortened id now picks the same session the session list shows for that id. An id that exactly matches a session always opens that session, and when a short id is ambiguous between several sessions, opening it and the list now agree on which one it means — previously opening ranked ambiguous matches by the session's creation time while the list ranked them by most recently modified, so a short id could open a session other than the one you were looking at.
