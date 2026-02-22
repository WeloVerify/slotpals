import express from "express"
import { Telegraf, Markup } from "telegraf"
import cron from "node-cron"
import { createClient } from "@supabase/supabase-js"

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json())

// ENV
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/telegram/webhook"
const CASINO_URL = process.env.CASINO_URL || "https://8spin.com"
const SUPPORT_URL = process.env.SUPPORT_URL || "https://8spin.com"
const ALERT_TIMEZONE = process.env.ALERT_TIMEZONE || "Europe/Rome"
const REMINDERS_ENABLED = (process.env.REMINDERS_ENABLED || "true").toLowerCase() === "true"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. DB tracking will fail.")
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null

// Follow-up (10 minutes after /start, ONLY if user did NOT click Play Now)
const FOLLOWUP_IMAGE =
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ae261d7562f0fa01b91dc_Frame%202147224854.png"

// In-memory state (DB handles analytics; memory handles timing)
const subscribers = new Set()
const playNowClicked = new Set()
const followupTimers = new Map()
const followupSent = new Set()

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

async function track(chatId, event, meta = {}) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase.from("tg_events").insert({ chat_id: chatId, event, meta })
  } catch {}
}

async function upsertUser(chatId) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase.from("tg_users").upsert(
      { chat_id: chatId, last_seen_at: new Date().toISOString() },
      { onConflict: "chat_id" }
    )
    // First seen: handled by default on insert; to keep it simple we don't backfill here.
  } catch {}
}

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
    [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
  ])
}

async function sendCasinoLink(ctx, introHtml = "<b>Open 8Spin</b> 👇") {
  await ctx.replyWithHTML(
    introHtml,
    Markup.inlineKeyboard([[Markup.button.url("Open 8Spin", CASINO_URL)]])
  )
}

async function sendPromos(ctx) {
  const chatId = ctx.chat?.id
  await track(chatId, "promos_view")

  await ctx.replyWithHTML(
    "<b>🎁 Current promotions</b>\nPick one below 👇",
    Markup.inlineKeyboard([
      [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
      [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
    ])
  )

  for (const p of PROMOS) {
    await ctx.replyWithPhoto(p.image, {
      caption: p.caption + "\n\n<b>Ready?</b> Tap <b>Play Now</b> 👇",
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
        [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
      ]),
    })
    await sleep(200)
  }
}

function scheduleFollowup(chatId) {
  if (followupSent.has(chatId)) return

  const existing = followupTimers.get(chatId)
  if (existing) clearTimeout(existing)

  track(chatId, "followup_scheduled")

  const timeoutId = setTimeout(async () => {
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
          [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
        ]).reply_markup,
      })

      followupSent.add(chatId)
      followupTimers.delete(chatId)
      await track(chatId, "followup_sent")
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

  await upsertUser(chatId)
  await track(chatId, "start")

  await ctx.reply("Welcome to 8Spin 🤝\nChoose an option:", mainMenu())
})

bot.command("promos", async (ctx) => sendPromos(ctx))

bot.command("play", async (ctx) => {
  const chatId = ctx.chat.id
  markPlayNow(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "command" })
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nTap below to open 8Spin 👇")
})

bot.command("placeorder", async (ctx) => {
  const chatId = ctx.chat.id
  markPlayNow(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "placeorder" })
  await sendCasinoLink(ctx, "<b>🎁 Offer unlocked</b>\nOpen 8Spin to claim it 👇")
})

bot.command("support", async (ctx) => {
  const chatId = ctx.chat.id
  await upsertUser(chatId)
  await track(chatId, "support_click", { source: "command" })
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
  const chatId = ctx.chat.id
  markPlayNow(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "callback" })
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nOpen 8Spin 👇")
})

bot.action("OPEN_SUPPORT", async (ctx) => {
  await ctx.answerCbQuery()
  const chatId = ctx.chat.id
  await upsertUser(chatId)
  await track(chatId, "support_click", { source: "callback" })
  await ctx.replyWithHTML(
    "<b>Need help?</b> Tap below 👇",
    Markup.inlineKeyboard([[Markup.button.url("Support", SUPPORT_URL)]])
  )
})

// RELOAD REMINDERS
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
      await track(chatId, "reload_reminder_sent", { kind })
      await sleep(120)
    } catch {
      subscribers.delete(chatId)
    }
  }
}

// 10:00 Europe/Rome
cron.schedule("0 10 * * 1", () => sendReloadReminder("monday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 3", () => sendReloadReminder("wednesday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 5", () => sendReloadReminder("friday"), { timezone: ALERT_TIMEZONE })

// ADMIN STATS (protected)
// Call: /admin/stats?token=YOUR_ADMIN_TOKEN
app.get("/admin/stats", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })

  try {
    // total users
    const { count: totalUsers } = await supabase.from("tg_users").select("*", { count: "exact", head: true })

    // last 24h active users (unique chat_id in last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: last24 } = await supabase
      .from("tg_events")
      .select("chat_id")
      .gte("created_at", since)

    const active24h = new Set((last24 || []).map((r) => r.chat_id)).size

    // counts by event (last 7 days)
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: ev7 } = await supabase
      .from("tg_events")
      .select("event")
      .gte("created_at", since7)

    const byEvent7d = {}
    for (const r of ev7 || []) byEvent7d[r.event] = (byEvent7d[r.event] || 0) + 1

    res.json({
      totalUsers: totalUsers || 0,
      activeUsersLast24h: active24h,
      eventsLast7d: byEvent7d,
    })
  } catch (e) {
    res.status(500).json({ error: "stats_failed" })
  }
})

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
