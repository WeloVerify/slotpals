import express from "express"
import { Telegraf, Markup } from "telegraf"
import cron from "node-cron"

const bot = new Telegraf(process.env.BOT_TOKEN)
const app = express()
app.use(express.json())

const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/telegram/webhook"
const CASINO_URL = process.env.CASINO_URL || "https://8spin.com"
const SUPPORT_URL = process.env.SUPPORT_URL || "https://8spin.com"

// 🔔 Dove inviare i messaggi automatici (consigliato: canale)
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || "" // es: @yourchannel OR -1001234567890
const ALERT_TIMEZONE = process.env.ALERT_TIMEZONE || "Europe/Rome" // cambia se vuoi

// ✅ Banner pubblici (i tuoi link)
const PROMO_IMAGES = [
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc8a929099d7bc16d8_Frame%202147224851.png",
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce940b2742d8b175e_Frame%202147224852.png",
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9ddb11b6cfb66af44ff_Frame%202147224853.png",
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc875e0cfad9cffe83_Frame%202147224834.png",
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dc0d32b32837f20197_Frame%202147224839.png",
  "https://cdn.prod.website-files.com/696e1363f17d66577979e157/699ad9dce4ea29439feea0a3_Frame%202147224840.png"
]

const PROMOS_TEXT =
  "🎁 Current Promotions\n" +
  "• 100% up to $1,000 + 200 FS (First deposit)\n" +
  "• 50% up to $200 (Second deposit)\n" +
  "• 75% up to $300 (Third deposit)\n\n" +
  "⚡ Reload Bonuses\n" +
  "• Monday: 40% up to $80 + 10 FS\n" +
  "• Wednesday: 50% up to $100 + 15 FS\n" +
  "• Friday: 60% up to €240 + 20 FS\n\n" +
  "Offers may be time-limited. Check the website for full details."

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎁 Promotions", "PROMOS")],
    [Markup.button.url("🌐 Open 8Spin", CASINO_URL)],
    [Markup.button.url("🧑‍💻 Support", SUPPORT_URL)]
  ])
}

async function sendPromos(ctx) {
  await ctx.reply(
    PROMOS_TEXT,
    Markup.inlineKeyboard([
      [Markup.button.url("Play now", CASINO_URL)],
      [Markup.button.url("Support", SUPPORT_URL)]
    ])
  )

  // Album immagini (max 10, qui 6)
  const media = PROMO_IMAGES.slice(0, 10).map((url) => ({ type: "photo", media: url }))
  try {
    await ctx.replyWithMediaGroup(media)
  } catch (e) {
    await ctx.reply("I couldn’t load promo images. (Image URLs must be public direct links.)")
  }
}

// Commands
bot.start(async (ctx) => {
  await ctx.reply("Welcome to 8Spin 🤝 Choose an option:", mainMenu())
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

// 🔥 Scheduled Reload messages (to channel/group)
async function sendReloadReminder(kind) {
  if (!ALERT_CHAT_ID) return

  const map = {
    monday:    "🚀 Reload Bonus is LIVE today (Monday)\n40% up to $80 + 10 FS\n\nTap below to claim 👇",
    wednesday: "🚀 Reload Bonus is LIVE today (Wednesday)\n50% up to $100 + 15 FS\n\nTap below to claim 👇",
    friday:    "🚀 Reload Bonus is LIVE today (Friday)\n60% up to €240 + 20 FS\n\nTap below to claim 👇"
  }

  const text = map[kind]
  await bot.telegram.sendMessage(
    ALERT_CHAT_ID,
    text,
    Markup.inlineKeyboard([[Markup.button.url("Open 8Spin", CASINO_URL)]]).reply_markup
  )
}

// Orario: 10:00 Europe/Rome (modificalo se vuoi)
cron.schedule("0 10 * * 1", () => sendReloadReminder("monday"),    { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 3", () => sendReloadReminder("wednesday"), { timezone: ALERT_TIMEZONE })
cron.schedule("0 10 * * 5", () => sendReloadReminder("friday"),    { timezone: ALERT_TIMEZONE })

// Healthcheck + webhook
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
