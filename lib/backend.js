const crypto = require('crypto')
const { Telegraf } = require('telegraf')

const LINK_PREFIX = 'telegram:link:'
const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes
const LOG_PREFIX = '[screepsmod-notify-telegram]'

module.exports = function (config) {
  const botToken = process.env.TELEGRAM_TOKEN
  if (!botToken) {
    console.error(`${LOG_PREFIX} TELEGRAM_TOKEN not set — mod disabled`)
    return
  }

  const bot = new Telegraf(botToken)

  // token -> { chatId: string, expiresAt: number }
  const pendingLinks = new Map()

  setInterval(() => {
    const now = Date.now()
    for (const [tok, data] of pendingLinks) {
      if (data.expiresAt < now) pendingLinks.delete(tok)
    }
  }, 60_000).unref()

  // ── Bot commands ────────────────────────────────────────────────────────────

  bot.command('start', (ctx) => {
    const linkToken = crypto.randomBytes(4).toString('hex').toUpperCase()
    pendingLinks.set(linkToken, {
      chatId: String(ctx.chat.id),
      expiresAt: Date.now() + TOKEN_TTL_MS
    })

    return ctx.reply(
      `Welcome to the Screeps notification bot!\n\n` +
      `To link your Screeps account, open the in-game console and run:\n\n` +
      `Game.notify('${LINK_PREFIX}${linkToken}')\n\n` +
      `This token expires in 10 minutes.`
    )
  })

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const db = config.common.storage.db

    try {
      const users = await db.users.find({ 'telegram.chatId': chatId })
      if (!users || users.length === 0) {
        return ctx.reply('No Screeps account is linked to this chat.\n\nSend /start to begin linking.')
      }

      const lines = users.map(u => {
        const checks = []
        if (u.notifyPrefs && u.notifyPrefs.disabled) {
          checks.push('✗ Notifications disabled in your Screeps account settings')
        } else {
          checks.push('✓ Notifications active')
        }
        return `Account: ${u.username}\n${checks.join('\n')}`
      })

      return ctx.reply(lines.join('\n\n'))
    } catch (err) {
      console.error(`${LOG_PREFIX} status error:`, err)
      return ctx.reply('An error occurred. Please try again later.')
    }
  })

  bot.command('unlink', async (ctx) => {
    const chatId = String(ctx.chat.id)
    const db = config.common.storage.db

    try {
      const users = await db.users.find({ 'telegram.chatId': chatId })
      if (!users || users.length === 0) {
        return ctx.reply('No Screeps account is linked to this chat.')
      }

      await Promise.all(
        users.map(u => db.users.update({ _id: u._id }, { $set: { telegram: null } }))
      )

      const names = users.map(u => u.username).join(', ')
      return ctx.reply(`Unlinked Screeps account(s): ${names}`)
    } catch (err) {
      console.error(`${LOG_PREFIX} unlink error:`, err)
      return ctx.reply('An error occurred. Please try again later.')
    }
  })

  // ── Notification hook ───────────────────────────────────────────────────────

  config.backend.on('sendUserNotifications', async (user, notifications) => {
    const linkNotif = notifications.find(
      n => n.message && n.message.startsWith(LINK_PREFIX)
    )

    if (linkNotif) {
      await handleLinking(user, linkNotif.message)
      // remaining non-link notifications still forwarded below
    }

    const regular = notifications.filter(
      n => !n.message || !n.message.startsWith(LINK_PREFIX)
    )

    if (regular.length === 0) return

    const chatId = user.telegram && user.telegram.chatId
    if (!chatId) return

    const text = formatNotifications(user.username, regular)

    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' })
      console.log(`${LOG_PREFIX} Sent ${regular.length} notification(s) to ${user.username} (chat ${chatId})`)
    } catch (err) {
      if (err.code === 403) {
        // User blocked the bot — clean up the stored chatId
        await config.common.storage.db.users
          .update({ _id: user._id }, { $set: { telegram: null } })
          .catch(e => console.error(`${LOG_PREFIX} cleanup error:`, e))
      } else {
        console.error(`${LOG_PREFIX} sendMessage error:`, err)
      }
    }
  })

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function handleLinking (user, message) {
    const linkToken = message.slice(LINK_PREFIX.length).trim()
    const pending = pendingLinks.get(linkToken)

    if (!pending) {
      console.log(`${LOG_PREFIX} unknown or expired link token from user ${user.username}`)
      return
    }

    if (pending.expiresAt < Date.now()) {
      pendingLinks.delete(linkToken)
      await bot.telegram.sendMessage(
        pending.chatId,
        'The link token has expired. Send /start to generate a new one.'
      ).catch(() => {})
      return
    }

    const db = config.common.storage.db
    try {
      await db.users.update(
        { _id: user._id },
        { $set: { telegram: { chatId: pending.chatId, verified: true } } }
      )
      pendingLinks.delete(linkToken)

      const warned = user.notifyPrefs && user.notifyPrefs.disabled
        ? '\n\n⚠️ Notifications are currently disabled in your Screeps account settings.'
        : ''

      await bot.telegram.sendMessage(
        pending.chatId,
        `Your Screeps account <b>${escapeHtml(user.username)}</b> has been linked successfully!\n\nYou will now receive game notifications here.${warned}`,
        { parse_mode: 'HTML' }
      )

      console.log(`${LOG_PREFIX} linked user ${user.username} to chat ${pending.chatId}`)
    } catch (err) {
      console.error(`${LOG_PREFIX} linking error:`, err)
    }
  }

  function formatNotifications (username, notifications) {
    const lines = notifications.map(n => {
      const icon = n.type === 'error' ? '&#x1F534;' : '&#x1F514;'
      const count = n.count > 1 ? ` (x${n.count})` : ''
      return `${icon}${count} ${escapeHtml(n.message)}`
    })

    return `<b>Screeps: ${escapeHtml(username)}</b>\n\n${lines.join('\n')}`
  }

  function escapeHtml (text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  // ── Cronjob patch ───────────────────────────────────────────────────────────
  // The stock sendNotifications cronjob silently deletes notifications for
  // users without an email address and never fires sendUserNotifications.
  // We wrap it so telegram-linked users without email are handled first.

  config.backend.on('expressPostConfig', () => {
    if (!config.cronjobs || !config.cronjobs.sendNotifications) {
      console.error(`${LOG_PREFIX} sendNotifications cronjob not found — linking will not work for users without email`)
      return
    }

    const db = config.common.storage.db
    const originalFn = config.cronjobs.sendNotifications[1]

    config.cronjobs.sendNotifications[1] = function (args) {
      const now = Date.now()

      return db['users.notifications'].find({ date: { $lt: now } })
        .then(notifications => {
          if (!notifications.length) return originalFn(args)

          const userIds = [...new Set(notifications.map(n => String(n.user)))]
          return db.users.find({ _id: { $in: userIds } })
            .then(users => {
              // Only patch users who have telegram linked but no email set.
              // Users with email are handled correctly by the original function.
              const targets = users.filter(u => u.telegram && u.telegram.chatId && !u.email)
              if (!targets.length) return originalFn(args)

              const updatePromises = []

              for (const user of targets) {
                if (user.notifyPrefs && user.notifyPrefs.disabled) continue

                const userNotifs = notifications.filter(n => String(n.user) === String(user._id))
                if (!userNotifs.length) continue

                const linkNotif = userNotifs.find(n => n.message && n.message.startsWith(LINK_PREFIX))
                const regular = userNotifs.filter(n => !n.message || !n.message.startsWith(LINK_PREFIX))

                // Link tokens are always processed immediately, no throttle
                if (linkNotif) {
                  config.backend.emit('sendUserNotifications', user, [
                    { message: linkNotif.message, date: linkNotif.date, count: linkNotif.count, type: linkNotif.type }
                  ])
                }

                // Regular notifications respect the user's interval setting,
                // tracked separately so it doesn't interfere with email timing
                if (regular.length) {
                  const interval = (user.notifyPrefs && user.notifyPrefs.interval || 60) * 60 * 1000
                  const lastDate = (user.telegram && user.telegram.lastNotifyDate) || 0

                  if (now - lastDate > interval) {
                    config.backend.emit('sendUserNotifications', user,
                      regular.map(n => ({ message: n.message, date: n.date, count: n.count, type: n.type }))
                    )
                    updatePromises.push(
                      db.users.update(
                        { _id: user._id },
                        { $set: { telegram: { ...user.telegram, lastNotifyDate: now } } }
                      )
                    )
                  }
                }
              }

              return Promise.all(updatePromises).then(() => originalFn(args))
            })
        })
        .catch(err => {
          console.error(`${LOG_PREFIX} cronjob patch error:`, err)
          return originalFn(args)
        })
    }

    console.log(`${LOG_PREFIX} sendNotifications cronjob patched for telegram-only users`)
  })

  // ── Launch ──────────────────────────────────────────────────────────────────

  const updateMethod = process.env.TELEGRAM_UPDATE_METHOD || 'polling'

  if (updateMethod === 'webhook') {
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ||
      (process.env.TELEGRAM_WEBHOOK_DOMAIN && `https://${process.env.TELEGRAM_WEBHOOK_DOMAIN}/telegram-webhook/${botToken}`)

    if (!webhookUrl) {
      console.error(`${LOG_PREFIX} Neither TELEGRAM_WEBHOOK_URL nor TELEGRAM_WEBHOOK_DOMAIN set — falling back to polling`)
      launchPolling()
    } else {
      // Register the route on the Screeps Express app — no extra port needed.
      // expressPostConfig fires after body-parser is set up, so req.body is available.
      config.backend.on('expressPostConfig', (app) => {
        const webhookPath = `/telegram-webhook/${botToken}`
        app.post(webhookPath, bot.webhookCallback(webhookPath))
        console.log(`${LOG_PREFIX} Webhook route registered at ${webhookPath}`)
      })

      bot.telegram.setWebhook(webhookUrl)
        .then(() => console.log(`${LOG_PREFIX} Bot started (webhook → ${webhookUrl})`))
        .catch(err => console.error(`${LOG_PREFIX} Failed to set webhook:`, err))
    }
  } else {
    launchPolling()
  }

  function launchPolling () {
    bot.launch()
      .then(() => console.log(`${LOG_PREFIX} Bot started (polling)`))
      .catch(err => console.error(`${LOG_PREFIX} Bot failed to start:`, err))

    process.once('SIGINT', () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
  }
}
