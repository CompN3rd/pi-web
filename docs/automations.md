# PI WEB Automations

Automations run durable, machine-local Pi jobs for a selected workspace. Create a disabled definition in the **Automations** workspace panel, test the exact revision, then enable its schedule. Every run uses a fresh Pi session, so scheduled work starts without conversation context from another run.

Automations ships in the main PI WEB package as a bundled paired plugin:

- **Plugin id:** `automations`
- **Browser entry:** an Automations workspace panel using browser plugin API v2
- **Server entry:** a scheduler and JSON workspace backend using server-plugin API v1
- **Machine scope:** `machineSpecific: true`; definitions, runs, models, and execution belong to the selected machine

It is enabled by default like other plugins. There is no separate package to install.

## Create, test, then enable

1. Select the machine, project, and workspace that should own the work.
2. Open the **Automations** workspace panel.
3. Select **New automation** and enter a name, prompt, trigger, model policy, thinking policy, and timeout.
4. Save the disabled draft.
5. Select **Run now / test** and wait for that revision to complete successfully.
6. Select **Enable** to start its schedule.

A successful manual run marks only that exact revision as tested. Editing its name, prompt, trigger, model, thinking level, or timeout creates a new revision, pauses the definition, and requires another successful manual test before it can be enabled. Revision checks also stop two open browser tabs from silently overwriting one another.

Definitions are scoped to one project and workspace. PI WEB revalidates both against the current authoritative workspace catalog before creating a run session; a stale, removed, or conflicting workspace fails rather than running in an unverified path.

## Triggers

- **Manual:** runs only when you select **Run now / test**.
- **One time:** runs once at a future timestamp and then disables its schedule.
- **Interval:** uses a fixed cadence of at least one minute.
- **Cron:** uses a six-field expression (`second minute hour day month weekday`) and an explicit IANA time zone.

The same automation never overlaps itself. If a scheduled occurrence collides with its active run, PI WEB records the occurrence as skipped instead of starting another session. The scheduler can run up to two different automations concurrently; additional work remains queued.

## Models and thinking

Choose the machine default or a fixed model from the selected machine's current model catalog. Fixed models are revalidated when the background session is created and are never silently replaced. Thinking choices are filtered to the selected model's supported levels.

Run history preserves both the configured policy and the actual model and thinking level used by the session. A model removed from the machine after a definition was saved causes that run to fail visibly.

## Timeouts, cancellation, and force-stop

The default run timeout is 60 minutes and may be set from 1 minute through 24 hours. The execution deadline begins when the fresh session is ready and prompt execution starts, not while the job is waiting in the queue.

Select **Cancel** to record cancellation intent and request a cooperative abort. If the run does not settle within the 15-second abort grace period, PI WEB force-stops the leased runtime. A force-stopped run becomes `unknown` when PI WEB cannot prove how prompt execution ended. Cancellation and force-stop cannot undo filesystem changes, network requests, or other external effects that already completed.

## History and usage

The workspace panel keeps recent definition and run history, including status, source, revision, queue/start/completion times, duration, configured and actual model/thinking values, failure or cancellation reason, and usage.

Usage is a snapshot of the fresh root Pi session. It includes input, output, cache-read, cache-write, and total tokens. Estimated cost is displayed only when the model runtime can provide one; unavailable cost remains unknown rather than becoming zero. Root-session totals do not claim to include untracked subagents, external services, or other paid tools.

Session IDs are shown for diagnosis, but the panel deliberately omits direct session-history links until PI WEB provides a public plugin navigation helper. Plugins do not construct private session URLs.

Deleting a definition disables and archives it. Existing run history remains available in the durable database.

## Persistence and restart recovery

The long-lived session daemon owns scheduling and execution. The Automations plugin stores definitions, revisions, occurrences, attempts, cancellation state, and usage in:

```text
$PI_WEB_DATA_DIR/plugin-state/automations/automations.sqlite
```

`PI_WEB_DATA_DIR` defaults to `~/.pi-web`. The database and its SQLite sidecar files are PI WEB-managed state, not a user-editable config file. Back it up only while the session daemon is stopped or with SQLite-aware tooling.

The data directory has one global session-daemon ownership marker, `$PI_WEB_DATA_DIR/sessiond-owner.json`. Automations does **not** create a separate owner file: it runs inside the daemon that already owns the data directory.

Closing or reloading the browser and restarting the web/API process do not stop schedules or active runs. The browser panel polls its paired backend—about every 2 seconds while a run is active and every 15 seconds while idle—so state reconstructs from sessiond after a reconnect. Automations adds no feature-specific realtime protocol.

On an unexpected session-daemon restart:

- queued runs stay queued and eligible;
- runs that were starting, running, or cancelling become `unknown` because completion cannot be proven;
- definitions, run history, and future schedule state remain in SQLite;
- ambiguous work is not blindly repeated.

A session-daemon restart can interrupt active sessions, including automation sessions. Changes to the Automations server plugin, plugin enablement, or its package revision require a manual restart on the target machine, followed by a browser reload. For the native systemd user service:

```bash
systemctl --user restart pi-web-sessiond
```

A browser reload, web/UI autoreload, restarting only the web/API process, and Pi's `/reload` command do not activate changed server-plugin code.

## Local and remote machines

Automations follows PI WEB's generic plugin federation. Select a remote machine and its compatible `automations` plugin supplies the panel through the gateway while that remote session daemon validates the workspace, stores the database, resolves models, schedules work, and runs sessions locally.

Definitions are not copied between machines and do not fail over. To move one, recreate it for a workspace on the destination machine so that machine validates its current workspace and model configuration. A gateway/browser disconnect does not stop work owned by a still-running remote session daemon.

After updating PI WEB on a federated machine, restart that machine's session daemon and reload the gateway browser. The paired browser/server plugin revision contract fails explicitly rather than using mismatched code.

## Enable, disable, and recover

Automations is enabled by default. Manage it in **Settings → PI WEB plugins**, or use the standard global plugin config on the target machine:

```json
{
  "plugins": {
    "automations": { "enabled": false }
  }
}
```

Because Automations has a server entry, enablement changes take effect after the target session daemon is restarted and the browser is reloaded. Disabling the plugin leaves its database unchanged. Re-enabling it resumes from the durable definitions and history after restart recovery rules are applied.

If a server plugin prevents normal startup, use the standard offline recovery commands described in the [plugin guide](https://pi-web.dev/plugins#lifecycle-recovery), such as `pi-web plugins disable automations --restart`.

## Security boundary

Automations and other PI WEB plugins are trusted code. The browser entry runs in the PI WEB page, and the server entry runs in-process with the session daemon's OS-user permissions. Install plugin packages only from trusted sources.

A fresh Pi session isolates conversational context, not the host. Automation prompts and tools can read, change, execute, or contact anything permitted by the target machine's Pi configuration and service user. Protect PI WEB with authentication and network controls, review prompts before enabling schedules, use least-privilege credentials, and remember that cancellation cannot reverse completed side effects.

The paired browser/server implementation uses only PI WEB's public plugin APIs. Browser requests go through `context.backend.request()` and generic machine federation; it does not expose automation-specific core routes or ask browser code to build private PI WEB URLs.
