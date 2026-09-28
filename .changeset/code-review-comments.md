---
"@jmfederico/pi-web": patch
---

Add inline code review comments: select line ranges in the Files and Git tabs, attach comments to your next message as removable chips, and send them to the agent as review feedback when you send the prompt. Keep pending comments when sending fails or success is not confirmed. Keep feedback bound to its originating session across navigation and session creation, prevent duplicate in-flight review sends, and distinguish Files, staged Git, and unstaged Git snapshots without discarding legacy feedback. Validate edited line ranges, discard cancelled range edits, show per-file review counts, and render feedback end markers as Markdown.
