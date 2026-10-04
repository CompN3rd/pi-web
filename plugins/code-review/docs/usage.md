# Intended Code Review workflow

**Pending release verification:** this source targets main's composer-chip API, not the published PI WEB `1.202610.1` package. Do not install this revision yet. Complete the [release gate](composer-design.md#release-gate) first; the instructions below describe the intended workflow afterward.

## Install the standalone package after verification

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

## Attach feedback to the composer

Choose a ready, unarchived conversation in this workspace, then select **Attach review to composer**. One removable **Review (N)** chip contains a snapshot of all saved comments. Repeating the action replaces that conversation's review chip, not the text at its cursor. You can inspect the payload under **Feedback Markdown**.

Send the chip with a message or by itself. Failed sends keep it and the saved comments for retry. Server acceptance clears only unchanged comments from the submitted snapshot; later edits and new comments survive. Acceptance does not mean the assistant has finished answering. Removing the composer chip only detaches it—saved comments remain available.

Saving edits or removing comments withdraws this workspace's staged feedback; attach again when ready. Changes from another browser tab also withdraw this activation's copies. If withdrawal fails, remove the stale chip manually before sending. If clearing submitted comments fails, inspect the accepted conversation before reattaching to avoid duplicate feedback.

Chips survive closing the panel or navigating away, but not reloading the page. Saved comments survive reloads; open the intended conversation and attach again. Different conversations can hold independent snapshots, so attach to multiple conversations only if you intend to send the feedback more than once.

## Differences from the former core UI

This is an independent Review tab, not an extension of the bundled Files/Git tabs: main does not expose inline decoration hooks for those panels. Composer integration uses main's public chip API, including removal and server-accepted callbacks. There are no private DOM hooks, private HTTP routes, host-owned review services, or patches to PromptEditor.

Feedback is workspace-scoped rather than session-scoped, so it can be authored before choosing a session and requires no temporary-session migration hooks. The old branch's `pi-web:review-comments:` session stores are not automatically imported or deleted; copy any remaining feedback from the old UI before switching installations.

Comment ownership stays in the plugin; the host owns only the staged composer snapshot and its send lifecycle.
