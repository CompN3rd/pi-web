---
"@jmfederico/pi-web": patch
---

Speed up session listing and make its cached rows more reliable. Listing reads only as much of each session file as a row needs, and its cache re-reads a changed session file whole rather than tracking partial parse state, which removes a class of stale-row bugs after a session file is rewritten in place. Opening, prompting, or running a command in a session you name directly stays independent of listing, so a large or busy session directory does not slow those down or make them wait behind a listing already in progress.
