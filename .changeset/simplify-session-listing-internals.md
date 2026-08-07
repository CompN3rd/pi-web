---
"@jmfederico/pi-web": patch
---

Speed up session listing and keep its cached rows reliable. The scanner reads each changed valid session file through the end, while avoiding decoding or parsing message bodies that no longer affect its row, and rebuilds the row from that complete pass instead of carrying partial parse state forward. Opening, prompting, or running a command in a directly named session does not build a full transcript listing or wait behind a listing promise already in progress.
