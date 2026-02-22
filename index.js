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

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null

// Follow-up (10 minutes after /start, ONLY if user did NOT click Play Now)
const FOLLOWUP_IMAGE =
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ae261d7562f0fa01b91dc_Frame%202147224854.png"

// In-memory (solo per timer follow-up)
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
      { chat_id: chatId, last_seen_at: new Date().toISOString(), subscribed: true },
      { onConflict: "chat_id" }
    )
  } catch {}
}

async function setSubscribed(chatId, subscribed) {
  if (!supabase || typeof chatId !== "number") return
  try {
    await supabase.from("tg_users").update({ subscribed }).eq("chat_id", chatId)
  } catch {}
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
    await sleep(180)
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
      followupTimers.delete(chatId)
      await setSubscribed(chatId, false)
    }
  }, 10 * 60 * 1000)

  followupTimers.set(chatId, timeoutId)
}

// COMMANDS
bot.start(async (ctx) => {
  const chatId = ctx.chat.id
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

// RELOAD REMINDERS (a tutti gli utenti subscribed=true)
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

// 10:00 Europe/Rome
cron.schedule("0 10 * * 1", () => sendReloadReminder("monday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 3", () => sendReloadReminder("wednesday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 5", () => sendReloadReminder("friday"), { timezone: ALERT_TIMEZONE })

// ADMIN: stats JSON
app.get("/admin/stats", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })

  try {
    const { count: totalUsers } = await supabase.from("tg_users").select("*", { count: "exact", head: true })

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: last24 } = await supabase.from("tg_events").select("chat_id").gte("created_at", since)
    const active24h = new Set((last24 || []).map((r) => r.chat_id)).size

    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: ev7 } = await supabase.from("tg_events").select("event").gte("created_at", since7)
    const byEvent7d = {}
    for (const r of ev7 || []) byEvent7d[r.event] = (byEvent7d[r.event] || 0) + 1

    const payload = { totalUsers: totalUsers || 0, activeUsersLast24h: active24h, eventsLast7d: byEvent7d }

    if (req.query.pretty === "1") {
      return res.status(200).type("application/json").send(JSON.stringify(payload, null, 2))
    }
    return res.json(payload)
  } catch {
    return res.status(500).json({ error: "stats_failed" })
  }
})

// ADMIN: lista ultimi broadcast
app.get("/admin/broadcasts", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })
  const { data } = await supabase.from("tg_broadcasts").select("*").order("created_at", { ascending: false }).limit(10)
  res.json({ broadcasts: data || [] })
})

// ADMIN: invio broadcast a tutti subscribed=true
app.post("/admin/broadcast", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" })
  if (!supabase) return res.status(500).json({ error: "supabase_not_configured" })

  const message_html = clampText(req.body?.message_html || "", 3500)
  const image_url = (req.body?.image_url || "").trim()
  const button1_text = clampText(req.body?.button1_text || "", 32)
  const button1_url = (req.body?.button1_url || "").trim()
  const button2_text = clampText(req.body?.button2_text || "", 32)
  const button2_url = (req.body?.button2_url || "").trim()

  if (!message_html) return res.status(400).json({ error: "message_html_required" })
  if (image_url && !isHttpsUrl(image_url)) return res.status(400).json({ error: "image_url_must_be_https" })
  if (button1_url && !isHttpsUrl(button1_url)) return res.status(400).json({ error: "button1_url_must_be_https" })
  if (button2_url && !isHttpsUrl(button2_url)) return res.status(400).json({ error: "button2_url_must_be_https" })

  let keyboard = []
  if (button1_text && button1_url) keyboard.push([Markup.button.url(button1_text, button1_url)])
  if (button2_text && button2_url) keyboard.push([Markup.button.url(button2_text, button2_url)])
  if (!keyboard.length) keyboard = [[Markup.button.url("Open 8Spin", CASINO_URL)]]

  const reply_markup = Markup.inlineKeyboard(keyboard).reply_markup

  // salva broadcast prima
  const { data: row } = await supabase.from("tg_broadcasts").insert({
    message_html, image_url: image_url || null,
    button1_text: button1_text || null, button1_url: button1_url || null,
    button2_text: button2_text || null, button2_url: button2_url || null,
  }).select("*").single()

  const ids = await fetchSubscribedChatIds()
  let sent = 0
  let fail = 0

  for (const chatId of ids) {
    try {
      if (image_url) {
        await bot.telegram.sendPhoto(chatId, image_url, { caption: message_html, parse_mode: "HTML", reply_markup })
      } else {
        await bot.telegram.sendMessage(chatId, message_html, { parse_mode: "HTML", reply_markup })
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

// ADMIN UI (dashboard + form broadcast)
app.get("/admin", async (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(401).send("unauthorized")

  const token = String(req.query.token || "")
  return res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Slotpals Admin</title>
<style>
:root{--bg:#0b1220;--card:#0f1a2e;--muted:#93a4c7;--text:#eaf0ff;--border:rgba(255,255,255,.10);--accent:#6ea8fe}
*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
body{margin:0;background:radial-gradient(900px 500px at 20% 0%, rgba(110,168,254,.18), transparent 55%), var(--bg);color:var(--text)}
.wrap{max-width:1040px;margin:26px auto;padding:0 16px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
h1{margin:0;font-size:18px;font-weight:900}
.sub{color:var(--muted);font-size:12px;margin-top:6px}
.btn{border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);padding:10px 12px;border-radius:12px;cursor:pointer}
.btn:hover{border-color:rgba(110,168,254,.35)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0 14px}
.card{background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));border:1px solid var(--border);border-radius:16px;padding:14px}
.label{color:var(--muted);font-size:12px}
.value{font-size:26px;font-weight:900;margin-top:6px}
.row{display:grid;grid-template-columns:1.2fr .8fr;gap:12px}
.panel{border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.02);overflow:hidden}
.panel h2{margin:0;padding:12px 14px;font-size:13px;color:var(--muted);border-bottom:1px solid var(--border);background:rgba(255,255,255,.03)}
.panel .in{padding:12px 14px}
table{width:100%;border-collapse:separate;border-spacing:0}
th,td{padding:10px 12px;text-align:left;font-size:13px}
th{color:var(--muted);background:rgba(255,255,255,.03);border-bottom:1px solid var(--border)}
tr:not(:last-child) td{border-bottom:1px solid var(--border)}
.right{text-align:right}
input,textarea{width:100%;padding:10px 11px;border-radius:12px;border:1px solid var(--border);background:rgba(0,0,0,.25);color:var(--text);outline:none}
textarea{min-height:120px;resize:vertical}
.small{font-size:12px;color:var(--muted);margin-top:6px}
hr{border:none;border-top:1px solid var(--border);margin:12px 0}
.ok{color:#4ade80;font-size:12px}
.err{color:#fb7185;font-size:12px}
@media(max-width:920px){.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}.right{text-align:left}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>Slotpals — Admin</h1>
      <div class="sub">Stats + Broadcast. Link: <span style="color:var(--accent)">/admin?token=***</span></div>
    </div>
    <button class="btn" id="refresh">Refresh</button>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Total users</div><div class="value" id="totalUsers">—</div></div>
    <div class="card"><div class="label">Active users (24h)</div><div class="value" id="active24">—</div></div>
    <div class="card"><div class="label">Events (7d)</div><div class="value" id="events7d">—</div></div>
  </div>

  <div class="row">
    <div class="panel">
      <h2>Broadcast to all users</h2>
      <div class="in">
        <div class="small">Message supports <b>HTML</b> (e.g. &lt;b&gt;bold&lt;/b&gt;). Keep it short and clean.</div>
        <textarea id="msg" placeholder="<b>New promo live</b> ..."></textarea>
        <div style="height:10px"></div>
        <input id="img" placeholder="Optional image URL (https://...png/jpg)"/>
        <div class="small">If image is set, it sends as photo + caption.</div>

        <hr/>

        <div class="small">Button 1 (optional)</div>
        <input id="b1t" placeholder="Button 1 text (e.g. Play now)"/>
        <div style="height:8px"></div>
        <input id="b1u" placeholder="Button 1 URL (https://...)"/>

        <div style="height:10px"></div>
        <div class="small">Button 2 (optional)</div>
        <input id="b2t" placeholder="Button 2 text (e.g. Promotions)"/>
        <div style="height:8px"></div>
        <input id="b2u" placeholder="Button 2 URL (https://...)"/>

        <div style="height:12px"></div>
        <button class="btn" id="send">Send broadcast</button>
        <div id="status" class="small"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Events (7d)</h2>
      <div class="in" style="padding:0">
        <table>
          <thead><tr><th>Event</th><th class="right">Count</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>

      <h2>Last broadcasts</h2>
      <div class="in" style="padding:0">
        <table>
          <thead><tr><th>When</th><th>Sent</th><th class="right">Fail</th></tr></thead>
          <tbody id="brows"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
const token = ${JSON.stringify(token)}
const fmt = (n)=> new Intl.NumberFormat().format(n||0)

async function loadStats(){
  const r = await fetch("/admin/stats?token="+encodeURIComponent(token))
  const d = await r.json()
  document.getElementById("totalUsers").textContent = fmt(d.totalUsers)
  document.getElementById("active24").textContent = fmt(d.activeUsersLast24h)
  const totalEvents = Object.values(d.eventsLast7d||{}).reduce((a,b)=>a+(b||0),0)
  document.getElementById("events7d").textContent = fmt(totalEvents)

  const rows = document.getElementById("rows")
  rows.innerHTML = ""
  const entries = Object.entries(d.eventsLast7d||{}).sort((a,b)=>(b[1]||0)-(a[1]||0))
  for(const [k,v] of entries){
    const tr=document.createElement("tr")
    tr.innerHTML = "<td>"+k+"</td><td class='right'>"+fmt(v)+"</td>"
    rows.appendChild(tr)
  }
  if(!entries.length){
    const tr=document.createElement("tr")
    tr.innerHTML="<td colspan='2' style='color:#93a4c7'>No data yet</td>"
    rows.appendChild(tr)
  }
}

async function loadBroadcasts(){
  const r = await fetch("/admin/broadcasts?token="+encodeURIComponent(token))
  const d = await r.json()
  const rows = document.getElementById("brows")
  rows.innerHTML=""
  const list = (d.broadcasts||[])
  for(const b of list){
    const when = new Date(b.created_at).toLocaleString()
    const tr=document.createElement("tr")
    tr.innerHTML="<td>"+when+"</td><td>"+fmt(b.sent_count)+"</td><td class='right'>"+fmt(b.fail_count)+"</td>"
    rows.appendChild(tr)
  }
  if(!list.length){
    const tr=document.createElement("tr")
    tr.innerHTML="<td colspan='3' style='color:#93a4c7'>No broadcasts yet</td>"
    rows.appendChild(tr)
  }
}

async function refreshAll(){ await loadStats(); await loadBroadcasts(); }
document.getElementById("refresh").onclick = refreshAll

document.getElementById("send").onclick = async () => {
  const status = document.getElementById("status")
  status.className="small"
  status.textContent="Sending..."

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
    status.textContent = "Error: "+(d.error||"unknown")
    return
  }
  status.className="small ok"
  status.textContent = "Done. Sent: "+d.sent+" | Fail: "+d.fail+" | Total: "+d.total
  await refreshAll()
}

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
