---
"@jmfederico/pi-web": patch
---

Respect the Pi agent profile's `httpIdleTimeoutMs` in the session daemon so long model responses (e.g. slow local vLLM backends) no longer fail with "Model response failed: terminated" at the built-in 5-minute HTTP idle timeout; `0` disables the timeout. Restart pi-web-sessiond after changing the setting.
