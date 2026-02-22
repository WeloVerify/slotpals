import express from "express"
import { Telegraf, Markup } from "telegraf"
import cron from "node-cron"

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json())

// ENV
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/telegram/webhook"
const CASINO_URL = process.env.CASINO_URL || "https://8spin.com"
const SUPPORT_URL = process.env.SUPPORT_URL || "https://8spin.com"
const ALERT_TIMEZONE = process.env.ALERT_TIMEZONE || "Europe/Rome"
const REMINDERS_ENABLED = (process.env.REMINDERS_ENABLED || "true").toLowerCase() === "true"

// Follow-up image (10 minutes after /start, ONLY if user did NOT click "Play Now")
const FOLLOWUP_IMAGE =
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ae261d7562f0fa01b91dc_Frame%202147224854.png"

// In-memory state (resets on redeploy/restart)
const subscribers = new Set()        // users who did /start (for reload reminders)
const playNowClicked = new Set()     // users who clicked Play Now (this session)
const followupTimers = new Map()     // chatId -> timeoutId
const followupSent = new Set()       // avoid sending followup multiple times (this session)

const PROMOS = [
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc8a929099d7bc16d8_Frame%202147224851.png",
    caption:
      "<b>💰 Deposit Bonus</b>\n<b>100% up to $1,000 + 200 FS</b>\n<i>First deposit</i>\n\nBoost your first top-up with extra cash + free spins.",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce940b2742d8b175e_Frame%202147224852.png",
    caption:
      "<b>💰 Deposit Bonus</b>\n<b>50% up to $200</b>\n<i>Second deposit</i>\n\nReload and keep the momentum going with an extra boost.",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9ddb11b6cfb66af44ff_Frame%202147224853.png",
    caption:
      "<b>💰 Deposit Bonus</b>\n<b>75% up to $300</b>\n<i>Third deposit</i>\n\nBigger boost on your third deposit — more balance, more play.",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc875e0cfad9cffe83_Frame%202147224834.png",
    caption:
      "<b>⚡ Reload Bonus</b>\n<b>40% up to $80 + 10 FS</b>\n<i>Every Monday</i>\n\nMonday reload is live — grab it before the day ends.",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc0d32b32837f20197_Frame%202147224839.png",
    caption:
      "<b>⚡ Reload Bonus</b>\n<b>50% up to $100 + 15 FS</b>\n<i>Every Wednesday</i>\n\nMidweek boost + extra free spins.",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce4ea29439feea0a3_Frame%202147224840.png",
    caption:
      "<b>⚡ Reload Bonus</b>\n<b>60% up to €240 + 20 FS</b>\n<i>Every Friday</i>\n\nFriday reload hits harder — big boost + free spins.",
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function registerSubscriber(chatId) {
  if (typeof chatId === "number") subscribers.add(chatId)
}

function markPlayNow(chatId) {
  if (typeof chatId !== "number") return
  playNowClicked.add(chatId)

  const t = followupTimers.get(chatId)
  if (t) {
    clearTimeout(t)
    followupTimers.delete(chatId)
  }
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
    [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
    [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)],
  ])
}

async function sendCasinoLink(ctx, introHtml = "<b>Open 8Spin</b> 👇") {
  await ctx.replyWithHTML(
    introHtml,
    Markup.inlineKeyboard([[Markup.button.url("Open 8Spin", CASINO_URL)]])
  )
}

async function sendPromos(ctx) {
  await ctx.replyWithHTML(
    "<b>🎁 Current promotions</b>\nPick one below 👇",
    Markup.inlineKeyboard([
      [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
      [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)],
    ])
  )

  for (const p of PROMOS) {
    await ctx.replyWithPhoto(p.image, {
      caption: p.caption + "\n\n<b>Ready?</b> Tap <b>Play Now</b> 👇",
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
        [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)],
      ]),
    })
    await sleep(250)
  }
}

function scheduleFollowup(chatId) {
  if (followupSent.has(chatId)) return

  const existing = followupTimers.get(chatId)
  if (existing) clearTimeout(existing)

  const timeoutId = setTimeout(async () => {
    // ✅ Only condition: user did NOT click Play Now
    if (playNowClicked.has(chatId)) {
      followupTimers.delete(chatId)
      return
    }

    try {
      const caption =
        "<b>🔥 Live winners right now</b>\n" +
        "@yuri.lop66 just won.\n" +
        "@lucky777, @sven_mori51 and 100+ others have won a total of <b>$2,883,973.17</b>.\n\n" +
        "<b>Be next.</b> Get your <b>First Deposit Bonus: 100% up to $1,000 + 200 FS</b> 👇\n\n" +
        "<i>Play responsibly. 18+.</i>"

      await bot.telegram.sendPhoto(chatId, FOLLOWUP_IMAGE, {
        caption,
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
          [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)],
        ]).reply_markup,
      })

      followupSent.add(chatId)
      followupTimers.delete(chatId)
    } catch {
      subscribers.delete(chatId)
      followupTimers.delete(chatId)
    }
  }, 10 * 60 * 1000)

  followupTimers.set(chatId, timeoutId)
}

// COMMANDS
bot.start(async (ctx) => {
  const chatId = ctx.chat.id
  registerSubscriber(chatId)
  scheduleFollowup(chatId)

  await ctx.reply("Welcome to 8Spin 🤝\nChoose an option:", mainMenu())
})

bot.command("promos", async (ctx) => sendPromos(ctx))

bot.command("play", async (ctx) => {
  // /play counts as Play Now
  markPlayNow(ctx.chat.id)
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nTap below to open 8Spin 👇")
})

bot.command("placeorder", async (ctx) => {
  // /placeorder counts as Play Now
  markPlayNow(ctx.chat.id)
  await sendCasinoLink(ctx, "<b>🎁 Offer unlocked</b>\nOpen 8Spin to claim it 👇")
})

bot.command("support", async (ctx) => {
  await ctx.replyWithHTML(
    "<b>Support</b> 👇",
    Markup.inlineKeyboard([[Markup.button.url("Contact support", SUPPORT_URL)]])
  )
})

// CALLBACKS
bot.action("PROMOS", async (ctx) => {
  await ctx.answerCbQuery()
  await sendPromos(ctx)
})

bot.action("PLAY_NOW", async (ctx) => {
  await ctx.answerCbQuery("✅ Let’s go")
  markPlayNow(ctx.chat.id)
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nOpen 8Spin 👇")
})

// RELOAD REMINDERS (DM to users who started) — lun/mer/ven
async function sendReloadReminder(kind) {
  if (!REMINDERS_ENABLED) return
  if (!subscribers.size) return

  const map = {
    monday:
      "🚀 <b>Reload Bonus is LIVE today (Monday)</b>\n40% up to $80 + 10 FS\n\nTap below 👇",
    wednesday:
      "🚀 <b>Reload Bonus is LIVE today (Wednesday)</b>\n50% up to $100 + 15 FS\n\nTap below 👇",
    friday:
      "🚀 <b>Reload Bonus is LIVE today (Friday)</b>\n60% up to €240 + 20 FS\n\nTap below 👇",
  }

  const reply_markup = Markup.inlineKeyboard([
    [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
  ]).reply_markup

  for (const chatId of [...subscribers]) {
    try {
      await bot.telegram.sendMessage(chatId, map[kind], { parse_mode: "HTML", reply_markup })
      await sleep(120)
    } catch {
      subscribers.delete(chatId)
    }
  }
}

// Cron schedule (10:00 Europe/Rome). Change "10" to your hour.
cron.schedule("0 10 * * 1", () => sendReloadReminder("monday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 3", () => sendReloadReminder("wednesday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 5", () => sendReloadReminder("friday"), { timezone: ALERT_TIMEZONE })

// HEALTHCHECK + WEBHOOK
app.get("/", (_, res) => res.send("OK"))
app.post(WEBHOOK_PATH, (req, res) => bot.handleUpdate(req.body, res))

async function start() {
  const PUBLIC_URL = process.env.PUBLIC_URL
  if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL")

  const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`
  await bot.telegram.setWebhook(webhookUrl)

  const port = process.env.PORT || 3000
  app.listen(port, () => console.log("Listening on", port, "Webhook:", webhookUrl))
}

start()
