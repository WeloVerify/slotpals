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

// ⚠️ Subscribers in-memory (chi fa /start). Su riavvio/redeploy può resettarsi.
const subscribers = new Set()

const PROMOS = [
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc8a929099d7bc16d8_Frame%202147224851.png",
    caption:
      "*💰 Deposit Bonus*\n*100% up to $1,000 + 200 FS*\n_First deposit_\n\nBoost your first top-up with extra cash + free spins. Tap below to claim 👇",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce940b2742d8b175e_Frame%202147224852.png",
    caption:
      "*💰 Deposit Bonus*\n*50% up to $200*\n_Second deposit_\n\nReload and keep the momentum going with an extra boost. Tap below 👇",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9ddb11b6cfb66af44ff_Frame%202147224853.png",
    caption:
      "*💰 Deposit Bonus*\n*75% up to $300*\n_Third deposit_\n\nBigger boost on your third deposit — more balance, more play. Tap below 👇",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc875e0cfad9cffe83_Frame%202147224834.png",
    caption:
      "*⚡ Reload Bonus*\n*40% up to $80 + 10 FS*\n_Every Monday_\n\nMonday reload is live — grab it before the day ends. Tap below 👇",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc0d32b32837f20197_Frame%202147224839.png",
    caption:
      "*⚡ Reload Bonus*\n*50% up to $100 + 15 FS*\n_Every Wednesday_\n\nMidweek boost + extra free spins. Tap below to claim 👇",
  },
  {
    image:
      "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce4ea29439feea0a3_Frame%202147224840.png",
    caption:
      "*⚡ Reload Bonus*\n*60% up to €240 + 20 FS*\n_Every Friday_\n\nFriday reload hits harder — big boost + free spins. Tap below 👇",
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
    [Markup.button.url("🌐 Open 8Spin", CASINO_URL)],
    [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)],
  ])
}

function registerSubscriber(chatId) {
  if (typeof chatId === "number") subscribers.add(chatId)
}

async function sendPromos(ctx) {
  await ctx.replyWithMarkdown(
    "🎁 *Current promotions* — pick your bonus below 👇",
    Markup.inlineKeyboard([
      [Markup.button.url("Play now", CASINO_URL)],
      [Markup.button.url("Support", SUPPORT_URL)],
    ])
  )

  for (const p of PROMOS) {
    await ctx.replyWithPhoto(p.image, {
      caption: p.caption,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.url("Play now", CASINO_URL)],
        [Markup.button.url("Support", SUPPORT_URL)],
      ]),
    })
    await sleep(250)
  }
}

// COMMANDS
bot.start(async (ctx) => {
  registerSubscriber(ctx.chat.id)
  await ctx.reply("Welcome to 8Spin 🤝\nChoose an option:", mainMenu())
})

bot.command("promos", async (ctx) => sendPromos(ctx))

bot.action("PROMOS", async (ctx) => {
  await ctx.answerCbQuery()
  await sendPromos(ctx)
})

bot.command("play", async (ctx) => {
  await ctx.reply("Open 8Spin 👇", Markup.inlineKeyboard([[Markup.button.url("Play now", CASINO_URL)]]))
})

bot.command("placeorder", async (ctx) => {
  await ctx.reply("Access the current offer 👇", Markup.inlineKeyboard([[Markup.button.url("Play now", CASINO_URL)]]))
})

bot.command("support", async (ctx) => {
  await ctx.reply("Support 👇", Markup.inlineKeyboard([[Markup.button.url("Contact support", SUPPORT_URL)]]))
})

// (Opzionale) gestisci opt-out reminders
bot.command("alerts", async (ctx) => {
  const chatId = ctx.chat.id
  const parts = (ctx.message?.text || "").trim().split(/\s+/)
  const action = (parts[1] || "status").toLowerCase()

  if (action === "off") {
    subscribers.delete(chatId)
    return ctx.reply("🛑 Alerts disabled. You can re-enable anytime with /alerts on.")
  }
  if (action === "on") {
    registerSubscriber(chatId)
    return ctx.reply("✅ Alerts enabled. I’ll remind you on Reload Bonus days.")
  }

  return ctx.reply(subscribers.has(chatId) ? "✅ Alerts are ON." : "🛑 Alerts are OFF. Use /alerts on to enable.")
})

// REMINDERS (DM a tutti gli utenti registrati)
async function sendReloadReminder(kind) {
  if (!REMINDERS_ENABLED) return
  if (!subscribers.size) return

  const map = {
    monday: "🚀 Reload Bonus is LIVE today (Monday)\n40% up to $80 + 10 FS\n\nTap below to claim 👇",
    wednesday: "🚀 Reload Bonus is LIVE today (Wednesday)\n50% up to $100 + 15 FS\n\nTap below to claim 👇",
    friday: "🚀 Reload Bonus is LIVE today (Friday)\n60% up to €240 + 20 FS\n\nTap below to claim 👇",
  }

  const text = map[kind]
  const reply_markup = Markup.inlineKeyboard([[Markup.button.url("Open 8Spin", CASINO_URL)]]).reply_markup

  for (const chatId of [...subscribers]) {
    try {
      await bot.telegram.sendMessage(chatId, text, { reply_markup })
      await sleep(120)
    } catch {
      // se l’utente blocca il bot / chat non valida, lo rimuoviamo
      subscribers.delete(chatId)
    }
  }
}

// Orario: 10:00 (Europe/Rome). Cambia l’ora modificando "0 10 ..."
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
