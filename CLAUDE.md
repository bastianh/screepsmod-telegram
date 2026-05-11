# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`screepsmod-telegram` is an npm-published Screeps private server mod that forwards `Game.notify()` calls to Telegram. It also implements a bot-driven account linking flow so players can associate their Telegram chat with their Screeps account.

Published at: https://www.npmjs.com/package/screepsmod-telegram  
Repository: https://github.com/bastianh/screepsmod-telegram

## Development commands

```bash
npm install          # install dependencies (only telegraf)
node -e "require('./index')"   # syntax check — no output means clean
```

There are no tests and no build step. The mod is plain CommonJS.

## Architecture

### Entry point flow

```
index.js
  └── lib/index.js        receives config object from Screeps server
        ├── lib/common.js   runs for all processes (currently empty)
        └── lib/backend.js  runs only when config.backend is present
```

`lib/backend.js` contains all logic: bot initialization, bot commands, the `sendUserNotifications` hook, and helpers.

### How the Screeps mod system works

The Screeps server passes a `config` object to the mod function. Relevant properties:

- `config.backend` — an EventEmitter; hooks are registered here
- `config.backend.router` — Express Router mounted at `/api`; add API routes here
- `config.common.storage.db` — LokiJS database with MongoDB-style query API

Relevant events emitted by the backend (from `reference/backend-local/lib/game/server.js`):

| Event | Argument | When |
|---|---|---|
| `expressPreConfig` | `app` | Before body-parser and auth middleware |
| `expressPostConfig` | `app` | After all middleware, before `server.listen` |
| `sendUserNotifications` | `user, notifications` | Per-user notification batch (see cronjob section) |

The backend fires the `sendUserNotifications` event from its `sendNotifications` cronjob, which runs **every 60 seconds**. The event signature is:

```js
config.backend.emit('sendUserNotifications', user, notifications)
// user: full user document from db.users
// notifications: [{ message, date, count, type }]
```

### Critical known limitation

The cronjob in the Screeps backend (`reference/backend-local/lib/cronjobs.js:144`) skips the event entirely if the user has **no email set** or `notifyPrefs.disabled` is true:

```js
if (user.notifyPrefs && (user.notifyPrefs.disabled || !user.email)) {
    // notifications are deleted, event is never emitted
    return;
}
```

This means **the Telegram link command (`Game.notify('telegram:link:...')`) will be silently dropped for users without an email address**. Any future improvement to the mod must work around this — either by patching the cronjob behavior or by requiring users to have a dummy email set.

Additionally, notifications are throttled by `user.notifyPrefs.interval` (default: 60 minutes), so the link command may be delayed significantly.

### Account linking flow

1. Player sends `/start` to the bot → mod generates a hex token, stores `token → chatId` in a `Map` (in-memory, 10 min TTL)
2. Player runs `Game.notify('telegram:link:<TOKEN>')` in game
3. `sendUserNotifications` fires; mod detects the prefix, matches the token, writes `{ telegram: { chatId, verified: true } }` to `db.users`
4. Bot sends confirmation to the player

### Database schema extension

The mod adds a `telegram` field to the `users` collection:
```json
{ "telegram": { "chatId": "123456789", "verified": true } }
```

To remove the link: `$set: { telegram: null }` (LokiJS doesn't reliably support `$unset`).

### Releasing

Releases are triggered by pushing a version tag. The GitHub Actions workflow (`.github/workflows/publish.yml`) verifies the tag matches `package.json`, determines the npm dist-tag (`beta` for pre-release identifiers, `latest` otherwise), and publishes with `--provenance` via OIDC trusted publishing — no `NPM_TOKEN` secret required.

```bash
# bump version in package.json, commit, then:
git tag v0.9.0-beta.1
git push origin v0.9.0-beta.1
```

The `reference/` directory contains the upstream Screeps backend source for reference only and is not part of the published package.
