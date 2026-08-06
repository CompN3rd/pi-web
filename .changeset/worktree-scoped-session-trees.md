---
"@jmfederico/pi-web": patch
---

Scope session trees to the workspace you are viewing. The session list no longer counts a session's child sessions in other workspaces, no longer names the workspace a missing parent lives in, and no longer offers "Go to parent session" for it. A session whose parent is not in the current workspace is shown as a top-level row marked "parent unavailable". Parent and child sessions within the same workspace keep their tree, indentation, and detach behavior, and listing a workspace no longer reads session files from sibling workspaces.
