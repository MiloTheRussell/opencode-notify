# opencode-notify

An [OpenCode](https://opencode.ai) V2 plugin that sends [ntfy](https://ntfy.sh)
push notifications so you know when OpenCode needs you:

- ✅ **Task done** — a run finished
- ❓ **Needs your input** — the agent asked a question (`question` tool / forms)
- 🔐 **Approval needed** — a tool is waiting for permission
- ⚠️ **Error** — a run failed or is retrying

It watches OpenCode's public event stream and works across all concurrent
sessions. Deduplication ensures exactly one notification per event.

## Requirements

- OpenCode V2
- An ntfy topic (each user picks their own — see below)

The plugin has **no dependencies** and does not import anything, so it loads
anywhere OpenCode looks for plugins.

## Install

### 1. Pick your own ntfy channel

Generate a long random topic and keep it private (anyone who knows it can read
or spam the channel):

```sh
echo "oc-$(openssl rand -hex 16)"
# e.g. oc-1f0c9b2e7a4d4f5e8b6c3a2d1e0f9a8b
```

Subscribe to that topic in the **ntfy** app (iOS / Android / desktop) or in a
browser at `https://ntfy.sh/<your-topic>`.

### 2. Install the plugin

Copy this folder to your global OpenCode config directory:

```sh
mkdir -p ~/.config/opencode
cp -r opencode-notify ~/.config/opencode/notify
```

Then register it in `~/.config/opencode/opencode.jsonc` (create the file if it
does not exist):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./notify",
      "options": {
        "topic": "oc-REPLACE-WITH-YOUR-TOPIC",
        "webUrl": "http://localhost:49374"
      }
    }
  ]
}
```

Use your own OpenCode web UI URL for `webUrl` (the address you open in the
browser). It becomes the "tap to open" target on the notification.

Restart or reload OpenCode:

```sh
opencode service restart
```

## Configuration

All options live under `plugins[].options`:

| Option          | Default              | Description                                                                 |
| --------------- | -------------------- | --------------------------------------------------------------------------- |
| `topic`         | `$NTFY_TOPIC`        | **Required.** ntfy topic to publish to. Treat it as a secret.                |
| `server`        | `$NTFY_SERVER` / `https://ntfy.sh` | ntfy base URL (for self-hosted ntfy).                           |
| `token`         | `$NTFY_TOKEN`        | Optional ntfy access token for protected topics.                            |
| `webUrl`        | `$NTFY_CLICK`        | URL opened when the notification is tapped.                                 |
| `events`        | all                  | Which triggers fire: `done`, `question`, `permission`, `error`, `retry`.    |
| `minIntervalMs` | `0`                  | Minimum spacing between pushes, to avoid burst floods.                      |
| `debug`         | `false`              | Log every received event to the OpenCode log for troubleshooting.           |

Every option except the topic can be omitted. `topic` can come from the
`NTFY_TOPIC` environment variable instead, so you can install the package
without editing the config object form.

### Example: only questions and approvals

```jsonc
{
  "plugins": [
    {
      "package": "./notify",
      "options": {
        "topic": "oc-REPLACE-WITH-YOUR-TOPIC",
        "events": ["question", "permission"]
      }
    }
  ]
}
```

## Installing as a package instead

You can also publish this folder to npm or a Git host and let OpenCode install
it:

```sh
opencode plugin add github:YOUR_USER/opencode-notify
```

Then set your options (or the `NTFY_TOPIC` environment variable). Changes under
watched config directories reload automatically; otherwise run
`opencode service restart`.

## Notes

- OpenCode sends a private `form` when an agent uses the `question` tool; this
  plugin treats `form.created` as "needs your input".
- Notifications include the session title and project directory, so concurrent
  sessions are easy to tell apart.
- Child/subagent sessions are filtered out to reduce noise.
- This notifies you through **ntfy**, not as a browser notification inside the
  OpenCode web UI (the web UI does not implement the browser Notification API).

## License

MIT
