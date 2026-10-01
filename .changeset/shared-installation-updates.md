---
"@jmfederico/pi-web": patch
---

Add `pi-web update` as the shared update entry point for the CLI and Updates panel, with installation-aware handling, clean-checkout fast-forward updates, and explicit confirmation before disruptive updates. Keep nested Linux and macOS restarts detached from the initiating terminal. Add `pi-web version --check` to report the latest available npm release.
