---
"@jmfederico/pi-web": patch
---

Run a repo-provided `.pi-web/hooks/worktree-pre-remove` hook before deleting a workspace worktree. When the hook exists and is executable, it runs with the target worktree path before `git worktree remove`; a non-zero exit blocks the removal. See the config reference for the hook contract.
