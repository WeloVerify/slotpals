import express from "express"
import { Telegraf, Markup } from "telegraf"
import cron from "node-cron"
import { createClient } from "@supabase/supabase-js"

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json({ limit: "1mb" }))

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

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null

// Follow-up message (10 minutes after /start, ONLY if user DID NOT click Play Now)
const FOLLOWUP_IMAGE =
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ae261d7562f0fa01b91dc_Frame%202147224854.png"

const FOLLOWUP_TYPE = "start_10min"

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

function isHttpsUrl(u) {
  try {
    const x = new URL(u)
    return x.protocol === "https:"
  } catch {
    return false
  }
}

function clampText(s, max = 3500) {
  if (!s) return ""
  return String(s).slice(0, max)
}

function formatPct(num, den) {
  if (!den) return "0%"
  const p = (num / den) * 100
  return `${p.toFixed(1)}%`
}

async function track(chatId, event, meta = {}) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase.from("tg_events").insert({ chat_id: chatId, event, meta })
  } catch {}
}

async function upsertUser(chatId) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase
      .from("tg_users")
      .upsert({ chat_id: chatId, last_seen_at: new Date().toISOString(), subscribed: true }, { onConflict: "chat_id" })
  } catch {}
}

async function setSubscribed(chatId, subscribed) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase.from("tg_users").update({ subscribed }).eq("chat_id", chatId)
  } catch {}
}

// DB FOLLOW-UP (persistente)
async function scheduleDbFollowup(chatId) {
  if (!supabase || typeof chatId !== "number") return

  try {
    // cancella eventuali pending vecchi
    await supabase
      .from("tg_followups")
      .update({ status: "canceled" })
      .eq("chat_id", chatId)
      .eq("type", FOLLOWUP_TYPE)
      .eq("status", "pending")

    const dueAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    const payload = {
      image: FOLLOWUP_IMAGE,
    }

    await supabase.from("tg_followups").insert({
      chat_id: chatId,
      type: FOLLOWUP_TYPE,
      due_at: dueAt,
      status: "pending",
      payload,
    })

    await track(chatId, "followup_scheduled", { type: FOLLOWUP_TYPE })
  } catch {}
}

async function cancelDbFollowup(chatId) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase
      .from("tg_followups")
      .update({ status: "canceled" })
      .eq("chat_id", chatId)
      .eq("type", FOLLOWUP_TYPE)
      .eq("status", "pending")

    await track(chatId, "followup_canceled", { type: FOLLOWUP_TYPE })
  } catch {}
}

async function userClickedPlayNowAfter(followupCreatedAt, chatId) {
  if (!supabase) return false
  try {
    const { data } = await supabase
      .from("tg_events")
      .select("id")
      .eq("chat_id", chatId)
      .eq("event", "play_now_click")
      .gte("created_at", followupCreatedAt)
      .limit(1)

    return !!(data && data.length)
  } catch {
    return false
  }
}

async function processDueFollowups() {
  if (!supabase) return

  try {
    const nowIso = new Date().toISOString()

    const { data: rows } = await supabase
      .from("tg_followups")
      .select("id, chat_id, type, payload, created_at")
      .eq("status", "pending")
      .lte("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(50)

    if (!rows || !rows.length) return

    for (const f of rows) {
      const chatId = f.chat_id

      // sicurezza extra: se ha cliccato Play Now dopo la creazione del follow-up, annulla e stop
      const clicked = await userClickedPlayNowAfter(f.created_at, chatId)
      if (clicked) {
        await supabase.from("tg_followups").update({ status: "canceled" }).eq("id", f.id)
        continue
      }

      try {
        const caption =
          "<b>🔥 Live winners right now</b>\n" +
          "@yuri.lop66 just won.\n" +
          "@lucky777, @sven_mori51 and 100+ others have won a total of <b>$2,883,973.17</b>.\n\n" +
          "<b>Be next.</b> Get your <b>First Deposit Bonus: 100% up to $1,000 + 200 FS</b> 👇\n\n" +
          "<i>Play responsibly. 18+.</i>"

        await bot.telegram.sendPhoto(chatId, f.payload?.image || FOLLOWUP_IMAGE, {
          caption,
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
            [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
          ]).reply_markup,
        })

        await supabase
          .from("tg_followups")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", f.id)

        await track(chatId, "followup_sent", { type: f.type, followup_id: f.id })
        await sleep(80)
      } catch {
        await supabase
          .from("tg_followups")
          .update({ status: "failed", sent_at: new Date().toISOString() })
          .eq("id", f.id)

        await setSubscribed(chatId, false)
        await track(chatId, "followup_failed", { type: f.type, followup_id: f.id })
      }
    }
  } catch {}
}

// menu bot
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
    [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
    [Markup.button.callback("🧑‍💻 Support", "OPEN_SUPPORT")],
  ])
}

async function sendCasinoLink(ctx, introHtml = "<b>Open 8Spin</b> 👇") {
  await ctx.replyWithHTML(introHtml, Markup.inlineKeyboard([[Markup.button.url("Open 8Spin", CASINO_URL)]]))
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
    await sleep(180)
  }
}

// COMMANDS
bot.start(async (ctx) => {
  const chatId = ctx.chat.id

  await upsertUser(chatId)
  await track(chatId, "start")

  // follow-up persistente
  await scheduleDbFollowup(chatId)

  await ctx.reply("Welcome to 8Spin 🤝\nChoose an option:", mainMenu())
})

bot.command("promos", async (ctx) => sendPromos(ctx))

bot.command("play", async (ctx) => {
  const chatId = ctx.chat.id
  await cancelDbFollowup(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "command" })
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nTap below to open 8Spin 👇")
})

bot.command("placeorder", async (ctx) => {
  const chatId = ctx.chat.id
  await cancelDbFollowup(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "placeorder" })
  await sendCasinoLink(ctx, "<b>🎁 Offer unlocked</b>\nOpen 8Spin to claim it 👇")
})

bot.command("support", async (ctx) => {
  const chatId = ctx.chat.id
  await upsertUser(chatId)
  await track(chatId, "support_click", { source: "command" })
  await ctx.replyWithHTML("<b>Support</b> 👇", Markup.inlineKeyboard([[Markup.button.url("Contact support", SUPPORT_URL)]]))
})

// CALLBACKS
bot.action("PROMOS", async (ctx) => {
  await ctx.answerCbQuery()
  await sendPromos(ctx)
})

bot.action("PLAY_NOW", async (ctx) => {
  await ctx.answerCbQuery("✅ Let’s go")
  const chatId = ctx.chat.id
  await cancelDbFollowup(chatId)
  await upsertUser(chatId)
  await track(chatId, "play_now_click", { source: "callback" })
  await sendCasinoLink(ctx, "<b>▶️ Play Now</b>\nOpen 8Spin 👇")
})

bot.action("OPEN_SUPPORT", async (ctx) => {
  await ctx.answerCbQuery()
  const chatId = ctx.chat.id
  await upsertUser(chatId)
  await track(chatId, "support_click", { source: "callback" })
  await ctx.replyWithHTML("<b>Need help?</b> Tap below 👇", Markup.inlineKeyboard([[Markup.button.url("Support", SUPPORT_URL)]]))
})

// Helpers for DB list users subscribed
async function fetchSubscribedChatIds() {
  if (!supabase) return []
  const out = []
  let from = 0
  const page = 1000

  while (true) {
    const { data, error } = await supabase
      .from("tg_users")
      .select("chat_id")
      .eq("subscribed", true)
      .range(from, from + page - 1)

    if (error) break
    if (!data || data.length === 0) break
    for (const r of data) out.push(r.chat_id)
    if (data.length < page) break
    from += page
  }

  return out
}

// RELOAD REMINDERS
async function sendReloadReminder(kind) {
  if (!REMINDERS_ENABLED) return
  const ids = await fetchSubscribedChatIds()
  if (!ids.length) return

  const map = {
    monday: "🚀 <b>Reload Bonus is LIVE today (Monday)</b>\n40% up to $80 + 10 FS\n\nTap below 👇",
    wednesday: "🚀 <b>Reload Bonus is LIVE today (Wednesday)</b>\n50% up to $100 + 15 FS\n\nTap below 👇",
    friday: "🚀 <b>Reload Bonus is LIVE today (Friday)</b>\n60% up to €240 + 20 FS\n\nTap below 👇",
  }

  const reply_markup = Markup.inlineKeyboard([
    [Markup.button.callback("▶️ Play Now", "PLAY_NOW")],
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
  ]).reply_markup

  for (const chatId of ids) {
    try {
      await bot.telegram.sendMessage(chatId, map[kind], { parse_mode: "HTML", reply_markup })
      await track(chatId, "reload_reminder_sent", { kind })
      await sleep(110)
    } catch {
      await setSubscribed(chatId, false)
    }
  }
}

// Schedulers
cron.schedule("*/1 * * * *", () => processDueFollowups(), { timezone: "UTC" }) // follow-up worker ogni minuto

cron.schedule("0 10 * * 1", () => sendReloadReminder("monday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 3", () => sendReloadReminder("wednesday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 5", () => sendReloadReminder("friday"), { timezone: ALERT_TIMEZONE })

// ======= ADMIN ANALYTICS (giorno / settimana / mese) =======
async function fetchEventsSince(sinceIso) {
  if (!supabase) return []
  const out = []
  let from = 0
  const page = 1000

  while (true) {
    const { data, error } = await supabase
      .from("tg_events")
      .select("chat_id,event,created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(from, from + page - 1)

    if (error) break
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < page) break
    from += page
  }
  return out
}

function startIsoForRange(range) {
  const now = Date.now()
  if (range === "day") return new Date(now - 24 * 60 * 60 * 1000).toISOString()
  if (range === "month") return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString() // week default
}

app.get("/admin/stats", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })

  const range = (req.query.range || "week").toString()

  try {
    const { count: totalUsers } = await supabase.from("tg_users").select("*", { count: "exact", head: true })
    const { count: subscribedUsers } = await supabase.from("tg_users").select("*", { count: "exact", head: true }).eq("subscribed", true)

    const { count: pendingFollowups } = await supabase
      .from("tg_followups")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")

    const sinceIso = startIsoForRange(range)
    const events = await fetchEventsSince(sinceIso)

    const unique = new Set()
    const byEvent = {}
    const byDay = {} // YYYY-MM-DD -> { starts, play, promos, broadcasts }

    let starts = 0
    let play = 0
    let promos = 0
    let followupsSent = 0
    let broadcastsSent = 0
    let reloadsSent = 0

    for (const e of events) {
      unique.add(e.chat_id)
      byEvent[e.event] = (byEvent[e.event] || 0) + 1

      const day = String(e.created_at).slice(0, 10)
      if (!byDay[day]) byDay[day] = { starts: 0, play: 0, promos: 0, broadcasts: 0, followups: 0 }

      if (e.event === "start") { starts++; byDay[day].starts++ }
      if (e.event === "play_now_click") { play++; byDay[day].play++ }
      if (e.event === "promos_view") { promos++; byDay[day].promos++ }
      if (e.event === "followup_sent") { followupsSent++; byDay[day].followups++ }
      if (e.event === "broadcast_sent") { broadcastsSent++; byDay[day].broadcasts++ }
      if (e.event === "reload_reminder_sent") { reloadsSent++ }
    }

    const series = Object.entries(byDay)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, ...v }))

    const payload = {
      range,
      sinceIso,
      totalUsers: totalUsers || 0,
      subscribedUsers: subscribedUsers || 0,
      pendingFollowups: pendingFollowups || 0,
      activeUsers: unique.size,
      starts,
      playNowClicks: play,
      promosViews: promos,
      followupsSent,
      broadcastsSent,
      reloadRemindersSent: reloadsSent,
      conversionPlayNowFromStart: formatPct(play, starts),
      eventsByEvent: byEvent,
      series,
    }

    if (req.query.pretty === "1") return res.status(200).type("application/json").send(JSON.stringify(payload, null, 2))
    return res.json(payload)
  } catch {
    return res.status(500).json({ error: "stats_failed" })
  }
})

// ADMIN: ultimi broadcast
app.get("/admin/broadcasts", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })
  const { data } = await supabase.from("tg_broadcasts").select("*").order("created_at", { ascending: false }).limit(10)
  res.json({ broadcasts: data || [] })
})

// ADMIN: broadcast (NO fallback “Open 8Spin” se non metti bottoni)
app.post("/admin/broadcast", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })

  const message_html_full = clampText(req.body?.message_html || "", 3500)
  const image_url = (req.body?.image_url || "").trim()

  const button1_text = clampText(req.body?.button1_text || "", 32)
  const button1_url = (req.body?.button1_url || "").trim()
  const button2_text = clampText(req.body?.button2_text || "", 32)
  const button2_url = (req.body?.button2_url || "").trim()

  if (!message_html_full) return res.status(400).json({ error: "message_html_required" })
  if (image_url && !isHttpsUrl(image_url)) return res.status(400).json({ error: "image_url_must_be_https" })
  if (button1_url && !isHttpsUrl(button1_url)) return res.status(400).json({ error: "button1_url_must_be_https" })
  if (button2_url && !isHttpsUrl(button2_url)) return res.status(400).json({ error: "button2_url_must_be_https" })

  // Telegram: caption foto max ~1024. Noi teniamo margine.
  const telegramText = image_url ? clampText(message_html_full, 900) : message_html_full

  const keyboard = []
  if (button1_text && button1_url) keyboard.push([Markup.button.url(button1_text, button1_url)])
  if (button2_text && button2_url) keyboard.push([Markup.button.url(button2_text, button2_url)])

  const reply_markup = keyboard.length ? Markup.inlineKeyboard(keyboard).reply_markup : undefined

  // salva broadcast
  const { data: row } = await supabase
    .from("tg_broadcasts")
    .insert({
      message_html: message_html_full,
      image_url: image_url || null,
      button1_text: button1_text || null,
      button1_url: button1_url || null,
      button2_text: button2_text || null,
      button2_url: button2_url || null,
    })
    .select("*")
    .single()

  const ids = await fetchSubscribedChatIds()
  let sent = 0
  let fail = 0

  for (const chatId of ids) {
    try {
      if (image_url) {
        await bot.telegram.sendPhoto(chatId, image_url, {
          caption: telegramText,
          parse_mode: "HTML",
          reply_markup,
        })
      } else {
        await bot.telegram.sendMessage(chatId, telegramText, {
          parse_mode: "HTML",
          reply_markup,
        })
      }
      sent++
      await track(chatId, "broadcast_sent", { broadcast_id: row?.id || null })
      await sleep(110)
    } catch {
      fail++
      await setSubscribed(chatId, false)
      await track(chatId, "broadcast_fail", { broadcast_id: row?.id || null })
    }
  }

  if (row?.id) {
    await supabase.from("tg_broadcasts").update({ sent_count: sent, fail_count: fail }).eq("id", row.id)
  }

  res.json({ ok: true, sent, fail, total: ids.length, broadcast_id: row?.id || null })
})

// ======= ADMIN UI (minimal bianco, Inter, italiano, preview) =======
app.get("/admin", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).send("unauthorized")

  const token = String(req.query.token || "")
  return res.type("html").send(`<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Slotpals Admin</title>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
:root{
  --bg:#fff;
  --text:#0b0f19;
  --muted:#667085;
  --border:rgba(16,24,40,.12);
  --shadow:0 1px 2px rgba(16,24,40,.06), 0 10px 24px rgba(16,24,40,.06);
  --soft:#f6f7fb;
  --ok:#12b76a;
  --err:#f04438;
}
*{box-sizing:border-box;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
body{margin:0;background:var(--bg);color:var(--text)}
.wrap{max-width:1120px;margin:28px auto;padding:0 18px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
h1{margin:0;font-size:16px;font-weight:800;letter-spacing:-.2px}
.sub{margin-top:6px;font-size:12px;color:var(--muted);line-height:1.45}
.btn{
  border:1px solid var(--border);
  background:#fff;
  color:var(--text);
  padding:10px 12px;
  border-radius:10px;
  box-shadow:0 1px 0 rgba(16,24,40,.03);
  cursor:pointer;
}
.btn:hover{background:#fafafa}
.pills{display:flex;gap:8px;flex-wrap:wrap}
.pill{
  border:1px solid var(--border);
  background:#fff;
  padding:8px 10px;
  border-radius:999px;
  font-size:12px;
  color:var(--text);
  cursor:pointer;
}
.pill.active{background:var(--soft);border-color:rgba(16,24,40,.18)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}
.card{
  background:#fff;
  border:1px solid var(--border);
  border-radius:14px;
  padding:14px;
  box-shadow:var(--shadow);
}
.label{font-size:12px;color:var(--muted)}
.value{font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-.4px}
.row{display:grid;grid-template-columns:1.1fr .9fr;gap:12px;margin-top:12px}
.panel{
  background:#fff;
  border:1px solid var(--border);
  border-radius:14px;
  box-shadow:var(--shadow);
  overflow:hidden;
}
.panel h2{
  margin:0;
  padding:12px 14px;
  font-size:12px;
  color:var(--muted);
  border-bottom:1px solid var(--border);
  background:#fcfcfd;
}
.panel .in{padding:14px}
input,textarea{
  width:100%;
  border:1px solid var(--border);
  background:#fff;
  color:var(--text);
  padding:10px 11px;
  border-radius:10px;
  outline:none;
}
input:focus,textarea:focus{border-color:rgba(16,24,40,.28)}
textarea{min-height:130px;resize:vertical}
.small{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.45}
.inline{display:grid;grid-template-columns:1fr 1fr;gap:10px}
table{width:100%;border-collapse:separate;border-spacing:0}
th,td{padding:10px 12px;text-align:left;font-size:13px}
th{color:var(--muted);background:#fcfcfd;border-bottom:1px solid var(--border)}
tr:not(:last-child) td{border-bottom:1px solid var(--border)}
.right{text-align:right}
.ok{color:var(--ok)}
.err{color:var(--err)}
.previewWrap{display:grid;grid-template-columns:1fr;gap:10px;margin-top:10px}
.preview{
  border:1px solid var(--border);
  border-radius:14px;
  background:linear-gradient(180deg,#ffffff,#fbfbfe);
  padding:12px;
}
.phone{
  border:1px solid rgba(16,24,40,.10);
  border-radius:18px;
  background:#fff;
  width:100%;
  max-width:430px;
  padding:12px;
  box-shadow:0 8px 18px rgba(16,24,40,.08);
}
.bubble{
  background:var(--soft);
  border:1px solid rgba(16,24,40,.08);
  border-radius:14px;
  padding:10px;
}
.bubble img{width:100%;border-radius:12px;border:1px solid rgba(16,24,40,.08)}
.bubbleText{margin-top:8px;font-size:13px;line-height:1.45}
.btnRow{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.tgBtn{
  border:1px solid rgba(16,24,40,.10);
  background:#fff;
  border-radius:12px;
  padding:8px 10px;
  font-size:12px;
}
.countRow{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.kpi{border:1px solid var(--border);background:#fff;border-radius:999px;padding:6px 10px;font-size:12px;color:var(--muted)}
@media(max-width:980px){
  .grid{grid-template-columns:1fr 1fr}
  .row{grid-template-columns:1fr}
  .inline{grid-template-columns:1fr}
  .right{text-align:left}
}
@media(max-width:520px){
  .grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>Slotpals Admin</h1>
      <div class="sub">Dashboard analytics + broadcast. Consiglio: salva questo link nei preferiti.</div>
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <div class="pills">
        <button class="pill active" data-range="day">Giorno</button>
        <button class="pill" data-range="week">Settimana</button>
        <button class="pill" data-range="month">Mese</button>
      </div>
      <button class="btn" id="refresh">Aggiorna</button>
    </div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Utenti totali</div><div class="value" id="totalUsers">0</div></div>
    <div class="card"><div class="label">Iscritti (subscribed)</div><div class="value" id="subscribedUsers">0</div></div>
    <div class="card"><div class="label">Attivi nel periodo</div><div class="value" id="activeUsers">0</div></div>
    <div class="card"><div class="label">Follow-up in coda</div><div class="value" id="pendingFollowups">0</div></div>
  </div>

  <div class="card" style="margin-top:12px">
    <div class="label">Metriche periodo selezionato</div>
    <div class="countRow" id="kpis"></div>
  </div>

  <div class="row">
    <div class="panel">
      <h2>Broadcast</h2>
      <div class="in">
        <div class="small">Supporta HTML Telegram (es. &lt;b&gt;bold&lt;/b&gt;, &lt;i&gt;italic&lt;/i&gt;). Se non inserisci bottoni, non verrà aggiunto alcun link.</div>

        <textarea id="msg" placeholder="<b>Nuova promo live</b> ..."></textarea>
        <div class="small" id="lenInfo"></div>

        <div style="height:10px"></div>
        <input id="img" placeholder="Immagine (opzionale) — URL https://...png/jpg" />

        <div style="height:12px"></div>

        <div class="inline">
          <div>
            <div class="small"><b>Bottone 1</b> (opzionale)</div>
            <input id="b1t" placeholder="Testo (es. Play now)" />
            <div style="height:8px"></div>
            <input id="b1u" placeholder="URL (https://...)" />
          </div>
          <div>
            <div class="small"><b>Bottone 2</b> (opzionale)</div>
            <input id="b2t" placeholder="Testo (es. Promozioni)" />
            <div style="height:8px"></div>
            <input id="b2u" placeholder="URL (https://...)" />
          </div>
        </div>

        <div class="previewWrap">
          <div class="preview">
            <div class="small"><b>Anteprima</b></div>
            <div class="phone">
              <div class="bubble">
                <div id="prevImg"></div>
                <div class="bubbleText" id="prevText"></div>
                <div class="btnRow" id="prevBtns"></div>
              </div>
              <div class="small" id="captionWarn" style="margin-top:10px"></div>
            </div>
          </div>
        </div>

        <div style="height:12px"></div>
        <button class="btn" id="send">Invia broadcast</button>
        <div id="status" class="small"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Eventi (periodo)</h2>
      <div class="in" style="padding:0">
        <table>
          <thead><tr><th>Evento</th><th class="right">Conteggio</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>

      <h2>Ultimi broadcast</h2>
      <div class="in" style="padding:0">
        <table>
          <thead><tr><th>Quando</th><th>Inviati</th><th class="right">Falliti</th></tr></thead>
          <tbody id="brows"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
const token = ${JSON.stringify(token)}
let currentRange = "day"
const fmt = (n)=> new Intl.NumberFormat().format(n||0)

function escapeHtml(s){
  return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
}

function updatePreview(){
  const msg = document.getElementById("msg").value || ""
  const img = document.getElementById("img").value || ""
  const b1t = document.getElementById("b1t").value || ""
  const b1u = document.getElementById("b1u").value || ""
  const b2t = document.getElementById("b2t").value || ""
  const b2u = document.getElementById("b2u").value || ""

  // testo: render "simile" telegram (admin-only)
  document.getElementById("prevText").innerHTML = msg || "<span style='color:#667085'>Scrivi un messaggio…</span>"

  // immagine
  const prevImg = document.getElementById("prevImg")
  if(img){
    prevImg.innerHTML = "<img src='"+escapeHtml(img)+"' alt='preview' />"
  } else {
    prevImg.innerHTML = ""
  }

  // bottoni
  const prevBtns = document.getElementById("prevBtns")
  prevBtns.innerHTML = ""
  if(b1t && b1u) prevBtns.innerHTML += "<div class='tgBtn'>"+escapeHtml(b1t)+"</div>"
  if(b2t && b2u) prevBtns.innerHTML += "<div class='tgBtn'>"+escapeHtml(b2t)+"</div>"
  if(!prevBtns.innerHTML) prevBtns.innerHTML = "<span style='color:#667085;font-size:12px'>Nessun bottone</span>"

  // warning caption foto
  const captionWarn = document.getElementById("captionWarn")
  if(img && msg.length > 900){
    captionWarn.innerHTML = "<span style='color:#f04438'>Nota:</span> con immagine, Telegram limita la caption. Verrà inviata una versione abbreviata."
  } else {
    captionWarn.innerHTML = ""
  }

  document.getElementById("lenInfo").textContent = "Lunghezza messaggio: " + msg.length + " caratteri"
}

async function loadStats(){
  const r = await fetch("/admin/stats?token="+encodeURIComponent(token)+"&range="+encodeURIComponent(currentRange))
  const d = await r.json()

  document.getElementById("totalUsers").textContent = fmt(d.totalUsers)
  document.getElementById("subscribedUsers").textContent = fmt(d.subscribedUsers)
  document.getElementById("activeUsers").textContent = fmt(d.activeUsers)
  document.getElementById("pendingFollowups").textContent = fmt(d.pendingFollowups)

  const kpis = document.getElementById("kpis")
  kpis.innerHTML = ""
  const items = [
    ["Start", d.starts],
    ["Play Now click", d.playNowClicks],
    ["Promos view", d.promosViews],
    ["Follow-up inviati", d.followupsSent],
    ["Broadcast inviati", d.broadcastsSent],
    ["Reload reminder", d.reloadRemindersSent],
    ["Conversione (Play/Start)", d.conversionPlayNowFromStart],
  ]
  for(const it of items){
    const el = document.createElement("div")
    el.className="kpi"
    el.textContent = it[0] + ": " + it[1]
    kpis.appendChild(el)
  }

  const rows = document.getElementById("rows")
  rows.innerHTML = ""
  const entries = Object.entries(d.eventsByEvent||{}).sort((a,b)=>(b[1]||0)-(a[1]||0))
  if(!entries.length){
    const tr=document.createElement("tr")
    tr.innerHTML="<td colspan='2' style='color:#667085'>Nessun dato</td>"
    rows.appendChild(tr)
    return
  }
  for(const [k,v] of entries){
    const tr=document.createElement("tr")
    tr.innerHTML = "<td>"+k+"</td><td class='right'>"+fmt(v)+"</td>"
    rows.appendChild(tr)
  }
}

async function loadBroadcasts(){
  const r = await fetch("/admin/broadcasts?token="+encodeURIComponent(token))
  const d = await r.json()
  const rows = document.getElementById("brows")
  rows.innerHTML=""
  const list = (d.broadcasts||[])
  if(!list.length){
    const tr=document.createElement("tr")
    tr.innerHTML="<td colspan='3' style='color:#667085'>Nessun broadcast</td>"
    rows.appendChild(tr)
    return
  }
  for(const b of list){
    const when = new Date(b.created_at).toLocaleString()
    const tr=document.createElement("tr")
    tr.innerHTML="<td>"+when+"</td><td>"+fmt(b.sent_count)+"</td><td class='right'>"+fmt(b.fail_count)+"</td>"
    rows.appendChild(tr)
  }
}

async function refreshAll(){ await loadStats(); await loadBroadcasts(); }

document.getElementById("refresh").onclick = refreshAll

document.querySelectorAll(".pill").forEach(btn=>{
  btn.onclick = async ()=>{
    document.querySelectorAll(".pill").forEach(x=>x.classList.remove("active"))
    btn.classList.add("active")
    currentRange = btn.dataset.range
    await refreshAll()
  }
})

document.getElementById("send").onclick = async () => {
  const status = document.getElementById("status")
  status.className="small"
  status.textContent="Invio in corso..."

  const payload = {
    message_html: document.getElementById("msg").value,
    image_url: document.getElementById("img").value,
    button1_text: document.getElementById("b1t").value,
    button1_url: document.getElementById("b1u").value,
    button2_text: document.getElementById("b2t").value,
    button2_url: document.getElementById("b2u").value,
  }

  const r = await fetch("/admin/broadcast?token="+encodeURIComponent(token), {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  })
  const d = await r.json()

  if(!r.ok){
    status.className="small err"
    status.textContent = "Errore: " + (d.error || "unknown")
    return
  }
  status.className="small ok"
  status.textContent = "Fatto. Inviati: " + d.sent + " | Falliti: " + d.fail + " | Totale: " + d.total

  await refreshAll()
}

;["msg","img","b1t","b1u","b2t","b2u"].forEach(id=>{
  document.getElementById(id).addEventListener("input", updatePreview)
})

updatePreview()
refreshAll()
</script>
</body>
</html>`)
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
