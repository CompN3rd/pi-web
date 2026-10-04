# Developing the standalone plugin

All package source, tests, configuration, and dependencies live under `plugins/code-review`. The package is separate from PI WEB's bundled plugins, root test command, and npm release.

## Verification is deferred

The source now targets upstream main's composer-chip API. The current development dependency pin, `1.202610.1`, predates that API and intentionally remains unchanged until a supporting package is published. There are no local replacement declarations. Do not treat the older implementation's verification results or build output as validation of this integration.

Follow the [release gate](composer-design.md#release-gate) before building or installing. Once the published dependency is updated:

```sh
npm ci --ignore-scripts
npm run verify
npm pack --dry-run
```

`verify` runs strict typechecking, typed ESLint, Vitest, the standalone build, and browser/server artifact smoke checks. `npm run check:artifacts` consumes already-built output without rebuilding; `node scripts/check-artifacts.mjs /path/to/extracted/package` checks a packed copy using this checkout's DOM harness.

Updated test cases cover captured chip ownership, user removal versus server acceptance, replacement during Send, unchanged-snapshot deletion, cross-tab withdrawal, persistence failures, and the panel's attach action. These tests are prepared for the released contract, **not yet executed**. Existing source-coordinate, Markdown, Git, and storage cases must also be rerun at the release gate.

## Boundaries

- The frontend stores workspace-scoped comments and delegates staging/acknowledgement to `ReviewChips`. Only public `prompt.setChip`/`prompt.removeChip` methods are used for handoff; prompt insertion and the provisional selection-service shim have been removed.
- The backend accepts only read-only `changes` and `diff` operations, runs argv-based Git through the host's bounded executor with the request signal, and uses the host-resolved workspace. Literal pathspecs, disabled external diff/textconv drivers, and output/path bounds keep this surface narrow.
- The Markdown renderer is adapted from PI WEB's MIT-licensed Captain's Log example. It renders known lexer tokens through Lit text bindings, not unsafe HTML.
- Browser dependencies are bundled under `dist/browser`; server JavaScript remains outside that public directory. The whole plugin can be built separately from the host after the dependency gate is satisfied.

No package has been published or npm name reserved. The package remains private until verification and a deliberate publication decision. Do not publish the PI WEB host to ship this plugin.
