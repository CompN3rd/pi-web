---
"@jmfederico/pi-web": patch
---

Fix session lookup so an id that exactly matches a session always opens that session. Previously a shortened session reference could open a different, more recently used session whose id started with the same characters.
