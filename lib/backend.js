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
      const names = users.map(u => u.username).join(', ')
      return ctx.reply(`Linked Screeps account(s): ${names}`)
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

      await bot.telegram.sendMessage(
        pending.chatId,
        `Your Screeps account <b>${escapeHtml(user.username)}</b> has been linked successfully!\n\nYou will now receive game notifications here.`,
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

  // ── Launch ──────────────────────────────────────────────────────────────────

  const updateMethod = process.env.TELEGRAM_UPDATE_METHOD || 'polling'

  if (updateMethod === 'webhook') {
    const domain = process.env.TELEGRAM_WEBHOOK_DOMAIN
    const port = parseInt(process.env.TELEGRAM_WEBHOOK_PORT) || 8443
    if (!domain) {
      console.error(`${LOG_PREFIX} TELEGRAM_WEBHOOK_DOMAIN not set — falling back to polling`)
      launchPolling()
    } else {
      bot.launch({ webhook: { domain, port } })
        .then(() => console.log(`${LOG_PREFIX} Bot started (webhook, port ${port})`))
        .catch(err => console.error(`${LOG_PREFIX} Bot failed to start:`, err))
    }
  } else {
    launchPolling()
  }

  function launchPolling () {
    bot.launch()
      .then(() => console.log(`${LOG_PREFIX} Bot started (polling)`))
      .catch(err => console.error(`${LOG_PREFIX} Bot failed to start:`, err))
  }

  process.once('SIGINT', () => bot.stop('SIGINT'))
  process.once('SIGTERM', () => bot.stop('SIGTERM'))
}
