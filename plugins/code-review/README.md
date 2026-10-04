# Code Review for PI WEB

A standalone Review tab for workspace files and staged/unstaged Git changes. Save line-range comments, then attach a removable review chip to the selected conversation. No host patches or prompt-text insertion are required.

**Unreleased design target: upstream main's composer-chip API.** The published PI WEB `1.202610.1` package does not contain that API. This package is private while we wait for a supporting release; the new integration has not been tested or built.

See the [composer design and release gate](docs/composer-design.md), [intended usage](docs/usage.md), and [development guide](docs/development.md). The dependency pin and verification must be updated after the supporting package is released, before installation or publishing.

Adapted from the Code Review UI branch and PI WEB's MIT-licensed plugin examples; see [LICENSE](LICENSE).
