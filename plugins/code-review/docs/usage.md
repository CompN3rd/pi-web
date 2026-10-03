# Install and use Code Review

## Install the standalone package

Build from `plugins/code-review`:

```sh
npm ci --ignore-scripts
npm run build
```

`--ignore-scripts` avoids native installation scripts from the development-only PI WEB dependency. This plugin's build does not use those native modules. The browser's Lit and Markdown dependencies are bundled; the server entry uses only the host-provided Git runner. Installed users need the built package, not its development dependencies.

Link this directory into the target machine's plugin directory. On Linux/macOS, while still in `plugins/code-review`:

```sh
mkdir -p "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins"
ln -s "$PWD" "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins/code-review"
```

On Windows, run PowerShell from the built plugin directory:

```powershell
$data = if ($env:PI_WEB_DATA_DIR) { $env:PI_WEB_DATA_DIR } else { Join-Path $env:USERPROFILE '.pi-web' }
New-Item -ItemType Directory -Force (Join-Path $data 'plugins')
New-Item -ItemType Junction -Path (Join-Path $data 'plugins/code-review') -Target (Get-Location).Path
```

Alternatively, copy the package's `package.json`, `dist`, `LICENSE`, `README.md`, and `docs` into that directory. For distribution, `npm pack` creates a self-contained tarball; extract it as the plugin directory, retaining `package.json` at its root. Do not copy `node_modules`.

Enable **Code Review** in **Settings → PI WEB plugins**. Because the package includes a server entry, **manually restart the target session daemon when safe**, then reload the browser. Restarting interrupts active sessions and terminals; do it from outside the sessions that daemon hosts. The plugin does not restart anything itself. Browser reload or Pi's `/reload` alone is insufficient after installing or updating this paired package.

For remote workspaces, install and enable the package on each target machine. Git runs on the panel's machine, never on the gateway as a fallback. Files and package-peer requests use the host's scoped helpers, including nested deployments.

## Review files and changes

1. Select a workspace and open the **Review** tab (or **Open Code Review** in the action palette).
2. Choose **Files**, **Git unstaged**, or **Git staged**. Files includes untracked files. Browse directories or enter a workspace-relative file path.
3. Click a line number. Shift-click extends its range on the same side; on touch screens, edit **Start line** and **End line** instead. Deleted diff lines use old-side coordinates; context and additions use new-side coordinates. Ranges cannot span omitted diff context.
4. Enter Markdown and choose **Save comment**. Ctrl/Cmd+Enter also saves; ordinary Enter inserts a newline.
5. Review the saved list. **Edit comment** reloads its source before allowing a save; **Remove comment** deletes that comment.

Comments render safe Markdown: raw HTML is displayed as text, images do not load, and links are limited to HTTP/HTTPS. Binary, truncated, very large sources (over 200,000 characters or 5,000 lines), and directories/change lists with over 2,000 entries are rejected rather than displaying incomplete selectable coordinates. Git must be installed. Git views show tracked changes; inspect untracked files in Files. Submodules are shown as Git's gitlink diff, not recursively expanded into another repository's file changes.

Saved comments are local to this browser origin, keyed by machine, project, and workspace. They survive reloads and session changes; they are not synchronized across browsers or machines. Other tabs' changes are re-read before saving. Storage errors are shown and an unsuccessful save leaves the editor text available. Corrupt or unrecognized storage is not overwritten automatically.

Switching away from the tab preserves the current editor within this activation. Switching workspace, reloading the browser, or disabling the plugin discards **unsaved** edits. Save before doing so.

Refreshing or host file invalidation reloads the current snapshot. A changed file does not silently delete feedback: saved comments remain in the list, are flagged as stale when that source is viewed, and are not attached to its new lines. Copy any unfinished text before cancelling a stale edit. Create a new comment against the current snapshot instead of automatically moving an old anchor. Sources you have not reopened have not been checked for staleness; verify coordinates before handing off.

## Hand off feedback

- **Insert into prompt** navigates to the existing, unarchived selected session in this workspace and inserts Markdown at its cursor. It refuses pending sessions, selection changes during navigation, and highlighted prompt text that would otherwise be replaced. It verifies that insertion changed the prompt. This action requires upstream's optional selection service; PI WEB 1.202610.1 does not yet include it.
- **Copy feedback** copies the same Markdown. If clipboard permissions are unavailable, expand **Feedback Markdown (manual copy)** and copy the text yourself.

Neither action sends a message. **Comments are retained after insertion or copying** because the public API does not expose send acknowledgement. Review and send the prompt normally, then remove the saved comments yourself. Repeated insertion deliberately inserts the feedback again.

## Differences from the former core UI

This is an independent Review tab, not an extension of the bundled Files/Git tabs. Current upstream exposes neither inline decoration hooks for those panels nor composer-chip/send-completion contributions. There are no private DOM hooks, private HTTP routes, host-owned review services, or patches to PromptEditor.

Feedback is workspace-scoped rather than session-scoped, so it can be authored before choosing a session and requires no temporary-session migration hooks. The old branch's `pi-web:review-comments:` session stores are not automatically imported or deleted; copy any remaining feedback from the old UI before switching installations.

When upstream ships composer contributions, the explicit handoff can be enhanced separately without moving comment ownership back into core.
