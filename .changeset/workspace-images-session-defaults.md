---
"@jmfederico/pi-web": patch
---

Fix relative Markdown image previews in Windows and UNC workspaces while preserving explicit approval for paths outside the workspace. Return HTTP 404 instead of 400 when reading or updating defaults for a missing session, while retaining 400 responses for invalid requests.
