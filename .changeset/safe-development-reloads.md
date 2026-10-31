---
"@jmfederico/pi-web": patch
---

Keep the session daemon out of development file watchers so source edits and UI/API restarts preserve active sessions. Start `npm run dev:sessiond` separately before `npm run dev` (or use the existing daemon service).

Recover bundled plugin build watching when source directories are added, removed, or recreated, and retain the last successful build when compilation fails.
