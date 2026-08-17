---
"@jmfederico/pi-web": patch
---

PI WEB now always honors pi's project-trust model; the `respectProjectTrust` opt-in (env var and config key) is removed. A saved trust decision wins, an extension may decide and request that the choice be remembered, and otherwise `defaultProjectTrust` applies — with `ask` or no decision a workspace is untrusted (there is no browser prompt, matching headless `pi`).

This is a breaking change for existing projects without a saved trust decision: after this release they become untrusted by default, so their project-local `.pi/` resources — settings, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md — do not load until you trust the workspace (workspace-menu toggle) or set `defaultProjectTrust` to `always`.