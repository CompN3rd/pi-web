---
"@jmfederico/pi-web": patch
---

Give the web UI's custom overlay dialogs (authentication, settings, session cleanup, command picker, action palette, and the project/machine dialogs) a shared modal surface: dialogs now take focus when opened, Escape and backdrop presses close them consistently, Tab focus stays trapped inside the dialog, and focus returns to the element that was focused before the dialog opened.
