# screepsmod-telegram

A [Screeps private server](https://github.com/screeps/screeps) mod that forwards game notifications to Telegram instead of (or in addition to) email. Each player links their own Telegram account via a secure in-game token exchange — no admin intervention required.

---

## How it works

1. A player sends `/start` to your server's Telegram bot.
2. The bot responds with a short-lived link token.
3. The player pastes the token into their in-game console: `Game.notify('telegram:link:ABCD1234')`.
4. The mod intercepts the special message, verifies the token, and permanently associates the player's Telegram chat ID with their Screeps account.
5. All subsequent `Game.notify()` calls are delivered to Telegram instead of being silently dropped (when no email is set) or sent via email.

---

## Requirements

- Screeps private server (`screeps` npm package ≥ 4.3.0)
- Node.js ≥ 22.9.0
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

---

## Installation

```bash
# In your Screeps server directory
npm install screepsmod-telegram
```

Add the mod to your `mods.json`:

```json
[
  "screepsmod-telegram"
]
```

---

## Configuration

All configuration is done via environment variables — either exported in your shell, set in a `.env` file loaded by your process manager, or placed in your `.screepsrc`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_TOKEN` | **yes** | — | Bot token from @BotFather |
| `TELEGRAM_UPDATE_METHOD` | no | `polling` | `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_DOMAIN` | webhook only | — | Publicly reachable domain (e.g. `screeps.example.com`) |
| `TELEGRAM_WEBHOOK_PORT` | no | `8443` | Port for the webhook server |

### Minimal setup (polling)

Polling is the easiest option for most private servers — no public domain or SSL certificate required.

```bash
export TELEGRAM_TOKEN=123456789:AABBccDDeeFFggHH...
```

### Webhook setup

Webhook mode is more efficient for high-traffic servers. It requires a domain with a valid SSL certificate reachable by Telegram's servers.

```bash
export TELEGRAM_TOKEN=123456789:AABBccDDeeFFggHH...
export TELEGRAM_UPDATE_METHOD=webhook
export TELEGRAM_WEBHOOK_DOMAIN=screeps.example.com
export TELEGRAM_WEBHOOK_PORT=8443
```

---

## Player guide

### Linking your account

1. Open Telegram and start a conversation with your server's bot.
2. Send `/start`. The bot will reply with a link command, e.g.:
   ```
   Game.notify('telegram:link:ABCD1234')
   ```
3. Open the Screeps client, go to the in-game console, and run that command.
4. You will receive a confirmation message in Telegram within the next notification cycle (up to a few minutes depending on your server's `notifyPrefs.interval`).

The link token expires after **10 minutes**. If it expires, just send `/start` again.

### Bot commands

| Command | Description |
|---|---|
| `/start` | Generate a new link token |
| `/status` | Show which Screeps account(s) are linked to this chat |
| `/unlink` | Remove the link between this chat and all associated Screeps accounts |

---

## Database schema

The mod extends each user document in the `users` collection with a `telegram` field:

```json
{
  "_id": "user_id",
  "username": "Screeper",
  "telegram": {
    "chatId": "123456789",
    "verified": true
  }
}
```

No separate collection is created. Pending link tokens are held in memory only and are never persisted.

---

## Notification format

Notifications arrive formatted like this:

```
Screeps: YourUsername

🔴 Your creep Harvester42 died at E15N32
📢 (x3) Not enough energy in spawn
```

Error-type notifications are flagged with a red circle, all others with a bell. Identical messages within the same batch are collapsed with a repeat count.

---

## Troubleshooting

**The bot starts but players never receive messages**
Check that `notifyPrefs.disabled` is not set to `true` on the user document, and that the server's notification cron job is running. The `sendUserNotifications` event is only emitted when the server's internal notification batch fires, which depends on the user's `notifyPrefs.interval` setting (default: 60 minutes).

**`TELEGRAM_TOKEN not set — mod disabled` in logs**
The environment variable is not visible to the Screeps backend process. Make sure it is exported before the server starts, not just defined in a sub-shell.

**Bot is blocked / user stopped receiving messages**
When a player blocks the bot, Telegram returns error 403. The mod automatically clears the stored chat ID from that user's record. The player can re-link at any time by unblocking the bot and sending `/start`.

**Webhook mode: bot won't start**
Telegram requires webhooks to be served over HTTPS on one of four ports: 443, 80, 88, or 8443. Make sure `TELEGRAM_WEBHOOK_DOMAIN` resolves publicly and has a valid certificate.

---

## Future ideas

The mod is intentionally minimal, but the Telegraf bot instance and the DB access pattern make the following extensions straightforward:

### Interactive commands

| Idea | Description |
|---|---|
| `/pause` / `/resume` | Let players mute notifications temporarily without unlinking |
| `/filter errors` | Subscribe only to error-type notifications |
| `/notify <message>` | Send a test notification from Telegram back into the game log |

### Room & stats queries

| Idea | Description |
|---|---|
| `/stats` | Return current GCL, RCL per room, CPU usage, and bucket from the game state |
| `/rooms` | List all owned rooms with current energy and RCL |
| `/room E15N32` | Show a snapshot of room memory or structure counts |
| Screenshot delivery | Use the Screeps map renderer to generate a PNG of a room and send it inline via `bot.telegram.sendPhoto()` |

### Admin features (server-owner only)

| Idea | Description |
|---|---|
| Restricted bot | Lock the bot so only whitelisted Telegram user IDs can link accounts |
| `/admin broadcast <msg>` | Send a message to all linked players (e.g. maintenance notices) |
| Server health alerts | Push a Telegram message when CPU or tick time exceeds a threshold |
| `/admin unlink <username>` | Force-unlink a Screeps account from the CLI or via a bot admin command |

### Notification enhancements

| Idea | Description |
|---|---|
| Inline keyboard buttons | Add a "Silence for 1h" button directly on each notification message |
| Configurable grouping | Let players choose whether to receive each notification immediately or batched |
| Markdown formatting | Switch to `MarkdownV2` parse mode for richer message layout |

---

## License

MIT
