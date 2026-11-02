# PI WEB plugin API

PI WEB plugins are trusted browser-side ES modules that extend the PI WEB UI. They are intended for personal, team, and project-local customization, and simple enough for an LLM to create or modify directly.

Plugins can currently:

- add action-palette commands;
- add workspace tools/panels next to Files, Git, and Terminal;
- add compact workspace-label items in the workspace list, panel header, and status bar;
- call browser APIs and PI WEB HTTP/WebSocket APIs available to the current browser session;
- serve their own static assets from the plugin directory.

They do **not** run in the session daemon, do not get a server-side hook API, and are not sandboxed.

## Trust model

Plugins run as JavaScript in the browser app. Treat them as trusted code:

- they can call browser APIs;
- they can `fetch()` PI WEB API endpoints using the current browser access;
- they can read workspace files through PI WEB's file endpoints if the UI can read them;
- they can render arbitrary Lit templates/custom elements in plugin contribution areas;
- they should not be installed from untrusted sources.

## What to ask AI to build

Humans should not need to hand-code plugins. Give an AI agent a concrete UI goal and ask it to create or modify a local plugin.

Good plugin requests:

- "Show a workspace badge with the dev server URL from `.env`."
- "Add a workspace panel with links to logs, dashboards, and local services for this repo."
- "Add an action-palette command that starts a standard code-review prompt."
- "Show whether the current workspace is a git worktree, main checkout, staging env, or feature branch."
- "Add a compact status badge based on a project health file or command output saved in the repo."

Copy-paste prompt for creating a plugin:

```text
Build a PI WEB plugin for this project.
Goal: <describe the UI behavior>.
Before coding, read the PI WEB plugin docs:
https://pi-web.dev/plugins.html
Full API reference:
https://pi-web.dev/plugins.md
Create it as a local plugin under ~/.pi-web/plugins/<plugin-id>.
Use the appropriate extension points from the docs.
Validate by checking /pi-web-plugins/manifest.json and explain how to reload/debug it.
Do not modify PI WEB itself.
```

Copy-paste prompt for modifying a plugin:

```text
Improve the PI WEB plugin at <path>.
Before coding, read the PI WEB plugin docs:
https://pi-web.dev/plugins.html
Full API reference:
https://pi-web.dev/plugins.md
Keep the plugin compatible with the documented v1 API.
After editing, check the manifest endpoint and browser-console failure cases.
```

## Canonical example: bundled Info plugin

PI WEB ships a real bundled `info` plugin. Use it as the reference example because it is intentionally small while still exercising all core contribution types: an action, a workspace label, and a workspace panel.

Bundled PI WEB plugins are developed as TypeScript in the repository, but their `package.json` metadata still points at built JavaScript because plugins are loaded by the browser as JS ES modules. `npm run dev:web` watches and rebuilds bundled plugin TS into `dist/pi-web-plugins/` during development, and `npm run build` emits the JS before packaging a release.

Source files:

```text
pi-web-plugins/info/package.json
pi-web-plugins/info/pi-web-plugin.ts
```

Built module:

```text
dist/pi-web-plugins/info/pi-web-plugin.js
```

Package metadata:

```json
{
  "name": "@pi-web/info-plugin",
  "private": true,
  "piWeb": {
    "plugins": [
      { "id": "info", "module": "pi-web-plugin.js" }
    ]
  }
}
```

Module shape excerpt:

```js
export default {
  apiVersion: 1,
  name: "Info Plugin",
  activate: ({ html }) => ({
    contributions: {
      actions: [/* action definitions */],
      workspaceLabels: [/* compact label definitions */],
      workspacePanels: [/* panel definitions using html */],
    },
  }),
};
```

When copying the Info plugin, choose a new plugin id so it does not conflict with the bundled `info` plugin.

PI WEB also ships a `pi-web` status plugin that demonstrates dynamic `visible` and `badge` callbacks for tabs that only appear when the host has status messages or needs extra install visibility.

## Local plugin usage

This works with the production npm/systemd install. PI WEB discovers plugins from `~/.pi-web/plugins/<plugin-package>/` on the web/API side; no PI WEB rebuild or session-daemon restart is required. If `PI_WEB_DATA_DIR` is set, use `$PI_WEB_DATA_DIR/plugins` instead.

Symlink a plugin folder into PI WEB's local plugin directory:

```bash
mkdir -p ~/.pi-web/plugins
ln -s /path/to/plugin-folder ~/.pi-web/plugins/plugin-id
```

Use PI WEB's **Refresh app data** button/action after editing or installing a plugin. It rediscovers plugins and imports fresh entrypoint modules without restarting the daemon or interrupting sessions. A full page reload remains available for browser-module limitations described below.

## First-party separate plugin packages

First-party plugins that are published as their own npm packages can live in this repository under `plugins/*` as npm workspaces. These packages are **not bundled** into the main `@jmfederico/pi-web` npm package automatically; they are separate packages that share CI, tests, and local development tooling with the main repo.

A separate plugin package should:

- use type-only imports from `@jmfederico/pi-web/plugin-api` when it needs shared PI WEB plugin interfaces; this subpath is currently a `.d.ts`-only dogfooding surface, not a runtime JavaScript module;
- keep its PI WEB metadata in its own `package.json` with `piWeb.plugins` entries pointing at built JavaScript in `dist/`;
- include a package-level `build` script and `prepack` script so `npm pack --workspace <package>` and `npm publish --workspace <package>` produce a usable plugin package;
- use a local symlink into `~/.pi-web/plugins/<plugin-id>` while developing;
- document any private PI WEB APIs it dogfoods until those APIs become stable plugin runtime helpers.

Typical local development loop from this repository:

```bash
# Terminal 1: long-lived daemon; skip if the user service is already running
npm run dev:sessiond
# Terminal 2: autoreloading web/API, browser UI, and plugin builds
npm run dev
# Terminal 3: check discovery
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

The main PI WEB `dev` command watches bundled plugins in `pi-web-plugins/`, builds/watches separate plugin packages in `plugins/*`, and discovers those source-checkout plugin packages without symlinking them into `~/.pi-web/plugins`.

## Discovery and packaging

PI WEB builds `/pi-web-plugins/manifest.json` from these sources:

1. Bundled plugins in the PI WEB package:

   ```text
   pi-web-plugins/<plugin-package>/
   ```

2. User-local plugins:

   ```text
   ~/.pi-web/plugins/<plugin-package>/
   ```

   Entries may be real directories or symlinks. This is the recommended development workflow.

3. Installed Pi packages that expose PI WEB plugin metadata. Pi packages may be user or project scoped.

Discovery rereads Pi package settings on each manifest or asset request, so adding or removing an installed package does not require restarting the web/API process or session daemon. Project settings here belong to the web/API process's working directory, not the currently selected browser workspace. Discovery does not install or update packages. Refresh the browser to activate the resulting plugin set; discovery alone does not replace plugins already running in a tab. Invalid settings edits are logged and retain the last successfully read settings until corrected.

Plugin package directory names and plugin ids must be valid identifiers:

```text
^[a-z][a-z0-9.-]*$
```

A package can expose one or more PI WEB plugin modules. There is exactly one supported `package.json` metadata shape:

```json
{
  "private": true,
  "piWeb": {
    "plugins": [
      { "id": "review", "module": "dist/review.js" },
      { "id": "dashboard", "module": "dist/dashboard.js" }
    ]
  }
}
```

Rules:

- `piWeb.plugins` must be an array of objects.
- Each entry must have an explicit `id` and `module`.
- `id` must match `^[a-z][a-z0-9.-]*$`.
- `module` must be a safe relative path inside the plugin package root.
- Duplicate plugin ids are not auto-renamed; later duplicates are skipped.
- Legacy shortcuts such as `piWeb.plugin`, string entries in `piWeb.plugins`, `piWeb.id` fallback ids, and no-`package.json` fallbacks are not supported.

### Manifest and assets

The manifest contains each discovered plugin module:

```json
{
  "plugins": [
    {
      "id": "my-plugin",
      "module": "/pi-web-plugins/my-plugin/pi-web-plugin.js?v=1234567890",
      "source": "local",
      "scope": "local"
    }
  ]
}
```

`source` describes where the plugin came from (`bundled`, `local`, or the Pi package source). `scope` is `bundled`, `local`, `user`, or `project`.

A plugin can fetch its own static assets with URLs under:

```text
/pi-web-plugins/<plugin-id>/<path-inside-plugin-root>
```

PI WEB prevents asset path traversal outside the plugin root. JavaScript, JSON, CSS, and HTML get appropriate content types; other files are served as octet-stream.

## Plugin module shape

The entry module must default-export a plugin object:

```ts
interface PiWebPlugin {
  apiVersion: 1;
  name: string;
  activate: (context: PluginActivationContext) => PluginActivationResult;
}

interface PluginActivationContext {
  apiVersion: 1;
  pluginId: string;
  html: typeof import("lit").html;
}

interface PluginActivationResult {
  contributions: PluginContributions;
  dispose?: () => void;
}
```

Example:

```js
export default {
  apiVersion: 1,
  name: "My Plugin",
  activate: ({ pluginId, html }) => ({
    contributions: {
      actions: [],
      workspacePanels: [],
      workspaceLabels: [],
    },
  }),
};
```

`activate()` is called when the UI loads the plugin. Keep it cheap: define contributions there, but move expensive or async work into actions, custom elements, or explicit user interactions.

An activation may return a synchronous `dispose()` callback to release activation-owned listeners, timers, or subscriptions. The registry calls it once when that activation is removed/replaced, or if its returned contributions fail validation. A failed registration leaves no partial contributions behind; a failed replacement retains the previous activation. Cleanup errors are logged without preventing other plugins from being cleaned up. If `activate()` itself throws before returning, it must clean up its own partially created resources. Module-level side effects cannot be cleaned up by the registry, and custom elements must clean up instance resources in `disconnectedCallback()`.

Browser discovery runs at startup and on **Refresh app data**. Successfully activated replacements replace previous contributions; import/activation failures keep the previous activation and log a warning in the browser console. Plugins removed from the manifest are disposed and unregistered. A failed manifest request leaves all current plugins intact. Concurrent refreshes share one load. This refresh affects only this browser tab and does not reload Pi session resources; chat `/reload` is not yet wired to this lifecycle.

Reload cache-busts entrypoint modules, not their transitive imports. Bundle dependencies into the entrypoint (or use content-hashed dependency URLs) for reliable reload. Browser custom element definitions cannot be replaced: guarding `customElements.define()` avoids duplicate-definition errors but retains the old class, so class changes still require a full page reload. Module-level side effects and previously evaluated module instances remain until page reload; keep resources in activation-owned state with `dispose()`, and use a full page reload periodically during long development sessions.

The plugin id comes from `package.json`, not from the JavaScript module. Contribution ids are local to the plugin and PI WEB qualifies them internally as:

```text
<plugin-id>:<local-contribution-id>
```

For example, plugin `info` with action `workspace.show-path` becomes `info:workspace.show-path`.

## Contributions

`activate()` returns a `contributions` object with any combination of these arrays:

```ts
interface PluginContributions {
  actions?: PluginAction[];
  workspacePanels?: WorkspacePanelContribution[];
  workspaceLabels?: WorkspaceLabelContribution[];
}
```

### Actions

Actions appear in the action palette. They can inspect app state and call UI/runtime helpers.

```js
actions: [
  {
    id: "workspace.show-path",
    title: "Show Current Workspace Path",
    description: "Display the selected workspace path",
    shortcut: "mod+shift+p",
    group: "Info",
    enabled: (context) => context.state.selectedWorkspace !== undefined,
    run: (context) => {
      window.alert(context.state.selectedWorkspace?.path ?? "No workspace selected");
    },
  },
]
```

Action type:

```ts
interface PluginAction {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  group?: string;
  enabled?: (context: PluginRuntimeContext) => boolean;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
}
```

Stable runtime context fields:

```ts
interface PluginRuntimeContext {
  state: {
    selectedWorkspace?: Workspace;
    selectedSession?: unknown;
  };
  openActionPalette: () => void;
  focusPrompt: () => void;
  addProject: () => void | Promise<void>;
  configureAuth: () => void | Promise<void>;
  logoutAuth: () => void | Promise<void>;
  selectWorkspaceTool: (tool: QualifiedContributionId) => void;
  openTerminal: (options?: { terminalId?: string }) => void;
  refreshFiles: () => void | Promise<void>;
  refreshGit: () => void | Promise<void>;
  startSession: () => void | Promise<void>;
  archiveSession: () => void | Promise<void>;
  stopActiveWork: () => void | Promise<void>;
}
```

Notes:

- `state` is a snapshot of current UI state when actions are built.
- Only `state.selectedWorkspace` and `state.selectedSession` are documented as stable for plugin authors.
- Other `state` fields may exist at runtime, but they are PI WEB internals and can change quickly.
- `enabled` is evaluated when the action palette asks for actions.
- `selectWorkspaceTool()` expects a qualified panel id such as `my-plugin:workspace.info`.
- `openTerminal()` switches to the built-in terminal panel. Pass `{ terminalId }` to deep-link to a specific terminal after creating one through the terminal API.

#### Keyboard shortcuts

- App-level keyboard shortcuts must be attached to actions. PI WEB does not support standalone plugin keyboard commands; contribute an action first, then add a `shortcut` if it needs a keybinding.
- `shortcut` is the action's default keybinding. It is displayed in the action palette and handled by the global shortcut dispatcher when the action is enabled.
- Use modified shortcuts such as `mod+shift+p`; plain letter shortcuts are intentionally ignored so normal typing is never captured.
- Future PI WEB versions may allow users to override or disable action shortcuts by action id, so plugins should treat `shortcut` as a default rather than a guaranteed final binding.
- Choose shortcuts carefully to avoid conflicts. There is no user-facing shortcut override or conflict resolver yet.
- Local text input, terminal input, list navigation, and dialog keys such as Enter, Escape, and arrow keys do not need to be plugin actions unless they are app-level commands.

### Workspace panels

Workspace panels add tools next to built-in workspace tools. They render inside the workspace side panel on desktop and as mobile tabs on smaller screens.

```js
workspacePanels: [
  {
    id: "workspace.info",
    title: "Info",
    order: 100,
    visible: ({ workspace }) => workspace.isGitRepo,
    render: ({ workspace }) => html`
      <section class="toolbar"><strong>Info</strong></section>
      <section class="viewer">
        <p class="muted">${workspace.label}</p>
        <p class="muted">${workspace.path}</p>
      </section>
    `,
  },
]
```

Panel type:

```ts
interface WorkspacePanelContribution {
  id: string;
  title: string;
  order?: number;
  visible?: (context: { workspace: Workspace }) => boolean;
  badge?: (context: WorkspacePanelContext) => string | number | TemplateResult | undefined;
  render: (context: WorkspacePanelContext) => TemplateResult;
}

interface WorkspacePanelContext {
  workspace: Workspace;
  openTerminal: (options?: { terminalId?: string }) => void;
}
```

`workspace` and `openTerminal()` are documented as stable for panel callbacks. Other fields may exist at runtime, but they are PI WEB internals and can change quickly. Use `openTerminal({ terminalId })` when a panel creates a terminal and wants PI WEB to navigate to that specific terminal. If a panel needs file, git, or session data, prefer explicit `fetch()` calls and keep them isolated.

Useful workspace shape:

```ts
interface Workspace {
  id: string;
  projectId: string;
  path: string;
  label: string;
  branch?: string;
  isMain: boolean;
  isGitRepo: boolean;
  isGitWorktree: boolean;
}
```

Use existing classes such as `toolbar`, `viewer`, `empty`, and `muted` for panel content when possible. Do not assume a panel owns the whole page; keep layout contained.

### Workspace labels

Workspace labels add compact inline metadata wherever PI WEB displays a workspace label: workspace list, workspace panel header, and status bar.

Use them for short facts like project environment, local URL, branch status, container name, or health state.

```js
workspaceLabels: [
  {
    id: "dev-url",
    order: 10,
    visible: ({ workspace }) => workspace.path.includes("my-app"),
    items: () => [{
      type: "link",
      text: "web:5173",
      href: "http://localhost:5173",
      title: "Open dev server",
      target: "_blank",
    }],
  },
]
```

Label contribution type:

```ts
interface WorkspaceLabelContribution {
  id: string;
  order?: number;
  visible?: (context: WorkspaceLabelContext) => boolean;
  items: (context: WorkspaceLabelContext) => WorkspaceLabelItem[];
}

interface WorkspaceLabelContext {
  workspace: Workspace;
}
```

Only `workspace` is documented as stable for label callbacks. Other fields may exist at runtime, but they are PI WEB internals and can change quickly.

Items are sorted by `order` and then id. Return an empty array to render nothing.

#### Text items

```js
{ type: "text", text: "staging", title: "Staging workspace" }
```

#### Link items

```js
{
  type: "link",
  text: "web:5173",
  href: "http://localhost:5173",
  title: "Open dev server",
  target: "_blank"
}
```

PI WEB renders the anchor and adds safe defaults such as `rel="noopener noreferrer"` for `_blank` links. `javascript:` and `data:` links are rendered as plain text instead of links.

#### Render items

Use render items when a label contribution needs custom UI, async data, or caching. Render items should stay compact and inline.

```js
class MyWorkspaceBadge extends HTMLElement {
  set workspace(value) {
    this._workspace = value;
    this.textContent = value?.branch === "main" ? "main" : "branch";
  }
}

if (!customElements.get("my-workspace-badge")) {
  customElements.define("my-workspace-badge", MyWorkspaceBadge);
}

export default {
  apiVersion: 1,
  name: "My Plugin",
  activate: ({ html }) => ({
    contributions: {
      workspaceLabels: [
        {
          id: "badge",
          order: 10,
          items: ({ workspace }) => [{
            type: "render",
            render: () => html`<my-workspace-badge .workspace=${workspace}></my-workspace-badge>`,
          }],
        },
      ],
    },
  }),
};
```

## Reading workspace files

Plugins can use existing PI WEB endpoints. For example, to read a file in a workspace:

```js
async function readWorkspaceFile(workspace, path) {
  const url =
    `/api/projects/${encodeURIComponent(workspace.projectId)}` +
    `/workspaces/${encodeURIComponent(workspace.id)}` +
    `/file?path=${encodeURIComponent(path)}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`);
  return await response.json();
}
```

The file response includes fields such as `path`, `content`, `truncated`, and `binary`, but endpoint response shapes are private PI WEB implementation details for now and can change between releases.

Be careful with sensitive files such as `.env`: plugins are trusted browser code, and file contents are exposed to the plugin.

## Other useful PI WEB APIs

Plugins may call any endpoint available to the browser, but these HTTP endpoints are considered private PI WEB implementation APIs for now. They can change quickly between releases. Prefer plugin runtime context helpers when they cover the interaction, and keep any direct HTTP usage small and isolated.

Common read endpoints:

```text
GET /api/projects
GET /api/projects/:projectId/workspaces
GET /api/projects/:projectId/workspaces/:workspaceId/tree?path=<dir>
GET /api/projects/:projectId/workspaces/:workspaceId/file?path=<file>
GET /api/projects/:projectId/workspaces/:workspaceId/git/status
GET /api/projects/:projectId/workspaces/:workspaceId/git/diff?path=<file>&staged=true|false
GET /api/sessions?cwd=<workspace-path>
GET /api/sessions/:sessionId/status
GET /api/sessions/:sessionId/messages?before=<cursor>&limit=<n>
```

Common write/action endpoints:

```text
POST /api/sessions                 { "cwd": "/path/to/workspace" }
POST /api/sessions/:id/prompt      { "text": "...", "streamingBehavior": "steer" | "followUp" }
POST /api/sessions/:id/shell       { "text": "..." }
POST /api/sessions/:id/stop
POST /api/sessions/:id/archive
POST /api/sessions/:id/restore
```

Prefer runtime context helpers (`startSession`, `stopActiveWork`, `refreshFiles`, `refreshGit`, etc.) when they cover the interaction. Use direct HTTP calls only for plugin-specific data or behavior, and expect to update them as PI WEB evolves.

## Async data and caching

PI WEB does not provide a plugin cache/invalidation framework. Keep host callbacks cheap:

- simple contributions should be synchronous and cheap;
- expensive or async work should live inside the plugin;
- custom elements in `type: "render"` label items or panels are a good place to own async loading;
- dedupe fetches and avoid unbounded polling;
- clean up intervals/event listeners in custom elements' `disconnectedCallback()`.

## Agent implementation checklist

If you are an AI agent building or editing a PI WEB plugin, follow this checklist:

1. Create or update a plugin folder with `package.json` and a JavaScript module such as `pi-web-plugin.js`.
2. Use the single supported package metadata shape: `piWeb.plugins` array with `{ id, module }` entries.
3. Default-export `{ apiVersion: 1, name, activate }` from the module.
4. Return `{ contributions: { actions, workspacePanels, workspaceLabels } }` from `activate()`.
5. Use ids matching `^[a-z][a-z0-9.-]*$`.
6. Use the activation context's `html` function for Lit templates.
7. Keep `activate()` synchronous and cheap; return contribution definitions only.
8. Add actions for command-palette operations.
9. Add workspace panels for larger workspace UI.
10. Add workspace labels for compact inline metadata.
11. Return arrays from workspace label `items()`; return an empty array to render nothing.
12. Use stable context fields first; only `workspace`, `state.selectedWorkspace`, and `state.selectedSession` are documented as stable.
13. Use `fetch()` against PI WEB APIs only for plugin-specific behavior not provided by runtime context helpers, and isolate those calls because HTTP endpoints are private for now.
14. Treat plugins as trusted code and avoid reading or displaying secrets unless intentional.
15. After local edits, tell the user to use **Refresh app data** and check the console for plugin errors. Use a full page reload for custom element class changes or unbundled dependency changes.

## Troubleshooting

Check discovery:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/manifest.json
```

Check a plugin module:

```bash
curl http://127.0.0.1:8504/pi-web-plugins/my-plugin/pi-web-plugin.js
```

Common issues:

- invalid plugin id or contribution id;
- missing default export;
- missing `apiVersion: 1`, `name`, or `activate` function;
- missing `package.json` or incorrect `piWeb.plugins` metadata;
- legacy shortcuts such as `piWeb.plugin`, string plugin entries, or no-`package.json` fallback;
- duplicate plugin ids; later duplicates are skipped rather than renamed;
- entry module path points outside the plugin root or file does not exist;
- browser cache not refreshed after editing;
- plugin directory is not under `~/.pi-web/plugins` or symlinked there;
- plugin throws during module import, `activate()`, `visible()`, `enabled()`, `items()`, or `render()`; check the browser console.
