# opencode-notify

An [OpenCode](https://opencode.ai) V2 plugin that pushes notifications over
[ntfy](https://ntfy.sh) and/or a **Telegram** bot so you know when OpenCode
needs you:

- ✅ **Task done** — a run finished
- ❓ **Needs your input** — the agent asked a question (`question` tool / forms)
- 🔐 **Approval needed** — a tool is waiting for permission
- ⚠️ **Error / retry** — a run failed or is retrying

It watches OpenCode's public event stream and works across all concurrent
sessions. Deduplication ensures exactly one notification per event.

**The channel is picked from configuration.** Configure an ntfy topic, a
Telegram bot token + chat id, or both — whatever has credentials gets used. Set
`channel` to force a specific one.

The plugin has **no dependencies** and does not import anything, so it loads
anywhere OpenCode looks for plugins.

## Requirements

- OpenCode V2
- One or both of:
  - An ntfy topic (each user picks their own — see below)
  - A Telegram bot from [@BotFather](https://t.me/BotFather) and your numeric
    user id (send any message to [@userinfobot](https://t.me/userinfobot)).
    Start a chat with your bot once — a bot cannot initiate a conversation.

## Install

### ntfy

Pick your own ntfy channel — generate a long random topic and keep it private
(anyone who knows it can read or spam the channel):

```sh
echo "oc-$(openssl rand -hex 16)"
# e.g. oc-1f0c9b2e7a4d4f5e8b6c3a2d1e0f9a8b
```

Subscribe to that topic in the **ntfy** app (iOS / Android / desktop) or in a
browser at `https://ntfy.sh/<your-topic>`.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather), copy its token, and get
your chat id from [@userinfobot](https://t.me/userinfobot). Message your bot once
so it is allowed to reply.

### Install the plugin

Copy this folder to your global OpenCode config directory:

```sh
mkdir -p ~/.config/opencode
cp -r opencode-notify ~/.config/opencode/notify
```

Then register it in `~/.config/opencode/opencode.jsonc` (create the file if it
does not exist). Use whichever channel(s) you want:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./notify",
      "options": {
        "ntfy": {
          "topic": "oc-REPLACE-WITH-YOUR-TOPIC"
        },
        "telegram": {
          "botToken": "123456:ABC-DEF...",
          "chatId": "123456789"
        },
        "webUrl": "https://opencode.example.com"
      }
    }
  ]
}
```

Drop the `ntfy` or `telegram` object to use only the other channel.

Use your own OpenCode web UI URL for `webUrl` (the address you open in the
browser). It becomes the "tap to open" / "Open in OpenCode" target, deep-linked
to the exact session when one is known.

Restart or reload OpenCode:

```sh
opencode service restart
```

## Configuration

All options live under `plugins[].options`:

| Option          | Default            | Description                                                                 |
| --------------- | ------------------ | --------------------------------------------------------------------------- |
| `channel`       | `"auto"`           | Which channel(s): `ntfy`, `telegram`, `both`, or `auto` (every configured channel). |
| `webUrl`        | `$NTFY_CLICK` / `$TELEGRAM_WEB_URL` | OpenCode web UI URL. Notifications deep-link to the exact session (`/server/<serverKey>/session/<id>`) or fall back to this URL. |
| `events`        | all                | Which triggers fire: `done`, `question`, `permission`, `error`, `retry`.    |
| `minIntervalMs` | `0`                | Minimum spacing between sends, to avoid burst floods.                       |
| `debug`         | `false`            | Log every received event to the OpenCode log for troubleshooting.           |
| `ntfy`          | `{}`               | ntfy settings object (see below). Configure `ntfy.topic` to enable ntfy.    |
| `telegram`      | `{}`               | Telegram settings object (see below). Configure it to enable Telegram.      |

`ntfy` object:

| Option   | Default            | Description                                                                 |
| -------- | ------------------ | --------------------------------------------------------------------------- |
| `topic`  | `$NTFY_TOPIC`      | ntfy topic to publish to. Configure this to enable ntfy. Treat it as a secret. |
| `server` | `$NTFY_SERVER` / `https://ntfy.sh` | ntfy base URL (for self-hosted ntfy).                       |
| `token`  | `$NTFY_TOKEN`      | Optional ntfy access token for protected topics.                            |

`telegram` object:

| Option     | Default               | Description                                                                 |
| ---------- | --------------------- | --------------------------------------------------------------------------- |
| `botToken` | `$TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. Configure with `chatId` to enable Telegram. Treat it as a secret. |
| `chatId`   | `$TELEGRAM_CHAT_ID`   | Target chat id(s): one value, a comma-separated list, or an array.          |
| `silent`   | `false`               | Send Telegram messages silently (no sound/vibration).                       |

With the default `channel: "auto"`, the plugin sends over every channel that has
credentials. Set `channel` to `"ntfy"` or `"telegram"` to force one, or
`"both"` to require both.

### Example: only questions and approvals, Telegram only

```jsonc
{
  "plugins": [
    {
      "package": "./notify",
      "options": {
        "channel": "telegram",
        "telegram": {
          "botToken": "123456:ABC-DEF...",
          "chatId": "123456789"
        },
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

Then set your options (or the `NTFY_TOPIC` / `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_CHAT_ID` environment variables). Changes under watched config
directories reload automatically; otherwise run `opencode service restart`.

## Notes

- OpenCode sends a private `form` when an agent uses the `question` tool; this
  plugin treats `form.created` as "needs your input".
- Notifications include the session title and project directory, so concurrent
  sessions are easy to tell apart.
- Child/subagent sessions are filtered out to reduce noise.
- Successful Telegram sends and API errors are logged as `[notify] ...` lines in
  the OpenCode server log.
- This notifies you through ntfy / Telegram, not as a browser notification inside
  the OpenCode web UI (the web UI does not implement the browser Notification API).

## License

MIT. Session deep-link logic derived from the Telegram fork
[MiloTheRussell/opencode-notify](https://github.com/MiloTheRussell/opencode-notify)
(MIT).
