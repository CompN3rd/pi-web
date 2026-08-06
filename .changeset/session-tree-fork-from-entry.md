---
"@jmfederico/pi-web": patch
---

Add a two-step session tree flow that first selects a history entry, then either continues from it in the same session or forks it into a separate session while leaving the original unchanged. Forking from a user message restores that message as the new session draft.
