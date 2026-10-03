# Developing the standalone plugin

All package code, tests, build configuration, and dependencies live under `plugins/code-review`. Copying this directory out of the PI WEB checkout preserves the package's build. It is intentionally not part of the host's bundled plugins, root test command, or npm release.

```sh
npm ci --ignore-scripts
npm run verify
npm pack --dry-run
```

`verify` runs strict typechecking, typed ESLint, Vitest, the standalone build, and browser/server artifact smoke checks. Tests cover source coordinates, durable storage failures and cross-tab updates, safe prompt handoff, DOM interactions and Markdown safety, request cancellation, and real staged/unstaged Git behavior. The build bundles browser dependencies under `dist/browser`; server JavaScript and its protocol module remain outside that public directory. `npm run check:artifacts` consumes existing output without rebuilding; `node scripts/check-artifacts.mjs /path/to/extracted/package` checks a packed copy using the developer checkout's DOM harness.

The development-only `@jmfederico/pi-web` dependency is pinned to 1.202610.1. `src/browser/selection.ts` describes the small optional public selection-service shape introduced on upstream main after that release. It is structurally compatible with current upstream, without importing private application types. Missing service support disables insertion with an actionable error; review/copy still work. Once the next declarations ship, replace that compatibility type with the exported public type.

The frontend owns comments via `ReviewStore` and scopes them to machine/project/workspace. It never interprets prompt insertion as successful submission. The backend accepts only read-only `changes` and `diff` operations, runs argv-based Git through the host's bounded executor with the request signal, and uses only the host-resolved workspace. Literal pathspecs, disabled external diff/textconv drivers, output bounds, and rejected absolute/traversal paths keep this surface narrow.

The Markdown renderer is adapted from PI WEB's MIT-licensed Captain's Log example. It renders known lexer tokens through Lit text bindings, not unsafe HTML. The coordinate/body feedback format follows the former Code Review UI branch. Keep these boundaries and failure tests when evolving the UI.

No package has been published and no npm namespace is reserved by this work. Choose an available package name and release workflow before publishing. Do not publish the PI WEB host to ship this plugin.
