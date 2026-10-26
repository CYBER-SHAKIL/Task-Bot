const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const config = require('./config');
const db = require('./db');
const makeApi = require('./api');
const makeAdminApi = require('./admin-api');
const registerFeatures = require('./features');

if (!config.BOT_TOKEN) throw new Error('BOT_TOKEN missing');

const bot = new Telegraf(config.BOT_TOKEN);

// ---------- helpers ----------
const isAdmin = (id) => config.ADMIN_IDS.includes(id);
const fullName = (from) => [from.first_name, from.last_name].filter(Boolean).join(' ');
const MENU = ['📋 Tasks', '💰 Balance', '👥 Refer', '🎁 Daily Bonus', '💸 Withdraw', 'ℹ️ Help'];

async function getMissingChannels(telegram, userId) {
  const missing = [];
  for (const ch of config.CHANNELS) {
    try {
      const m = await telegram.getChatMember(ch.username, userId);
      if (['left', 'kicked'].includes(m.status)) missing.push(ch);
    } catch (e) {
      console.error(`getChatMember failed for ${ch.username}:`, e.message);
      missing.push(ch);
    }
  }
  return missing;
}

function joinKeyboard() {
  const rows = config.CHANNELS.map((ch) => [Markup.button.url(`📢 Join ${ch.title}`, ch.url)]);
  rows.push([Markup.button.callback('✅ Verify', 'verify')]);
  return Markup.inlineKeyboard(rows);
}

function mainMenu() {
  const tasksBtn = config.WEBAPP_URL
    ? Markup.button.webApp('📋 Tasks', config.WEBAPP_URL)
    : '📋 Tasks';
  return Markup.keyboard([
    [tasksBtn],
    ['💰 Balance', '👥 Refer'],
    ['🎁 Daily Bonus', '💸 Withdraw'],
    ['ℹ️ Help'],
  ]).resize();
}

const sendJoinPrompt = (ctx) =>
  ctx.reply(
    '👋 Welcome!\n\nBot use korar age nicher channel(gulo) join korun, tarpor ✅ Verify chapun.',
    joinKeyboard()
  );

const sendMainMenu = (ctx) => ctx.reply('🏠 Main Menu', mainMenu());

// Channel join na thakle menu kaj korbe na
async function requireJoined(ctx, next) {
  const missing = await getMissingChannels(ctx.telegram, ctx.from.id);
  if (missing.length) return ctx.reply('⚠️ Age sob channel join korun:', joinKeyboard());
  return next();
}

// User ke verified mark kore, referral bonus dey (ekbar-i)
async function verifyUser(ctx) {
  let user = await db.getUser(ctx.from.id);
  if (!user) {
    user = await db.createUser({
      tgId: ctx.from.id,
      name: fullName(ctx.from),
      username: ctx.from.username,
    });
  }

  const res = await db.claimVerify(ctx.from.id);
  if (res?.first && user.referredBy && !user.referralPaid) {
    const ref = await db.getUser(user.referredBy);
    if (ref) {
      await db.incUser(ref.tgId, {
        balance: config.REFERRAL_BONUS,
        totalEarned: config.REFERRAL_BONUS,
        refCount: 1,
      });
      await db.updateUser(ctx.from.id, { referralPaid: true });
      ctx.telegram
        .sendMessage(ref.tgId, `🎉 Apnar refer e notun user join korlo! +${config.REFERRAL_BONUS}৳`)
        .catch(() => {});
    }
  }
}

// ---------- middleware: user load, ban check, state reset ----------
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return next();
  const user = await db.getUser(ctx.from.id);
  if (user?.banned) return ctx.reply('🚫 Apnar account ban kora hoyeche.');

  // menu button / command chaple cholte thaka withdraw/proof flow bondho
  const text = ctx.message?.text;
  if (user?.state && text && (MENU.includes(text) || text.startsWith('/'))) {
    await db.setState(ctx.from.id, null);
    user.state = null;
  }
  ctx.user = user;
  return next();
});

// ---------- /start ----------
bot.start(async (ctx) => {
  const payload = ctx.startPayload || '';
  const refId = /^\d+$/.test(payload) ? Number(payload) : null;

  if (!ctx.user) {
    await db.createUser({
      tgId: ctx.from.id,
      name: fullName(ctx.from),
      username: ctx.from.username,
      referredBy: refId && refId !== ctx.from.id ? refId : null,
    });
  }

  const missing = await getMissingChannels(ctx.telegram, ctx.from.id);
  if (missing.length) return sendJoinPrompt(ctx);

  await verifyUser(ctx);
  return sendMainMenu(ctx);
});

// ---------- Verify ----------
bot.action('verify', async (ctx) => {
  const missing = await getMissingChannels(ctx.telegram, ctx.from.id);
  if (missing.length) {
    return ctx.answerCbQuery('❌ Ekhono sob channel join kora hoyni!', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Verified!');
  try { await ctx.deleteMessage(); } catch (_) {}
  await verifyUser(ctx);
  return sendMainMenu(ctx);
});

// ---------- Menu actions ----------
bot.hears('💰 Balance', requireJoined, async (ctx) => {
  const u = await db.getUser(ctx.from.id);
  return ctx.reply(
    `💰 Balance: ${u.balance.toFixed(2)}৳\n📈 Total Earned: ${u.totalEarned.toFixed(2)}৳\n👥 Referrals: ${u.refCount}`
  );
});

bot.hears('👥 Refer', requireJoined, (ctx) => {
  const link = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
  return ctx.reply(
    `👥 Refer & Earn\n\nProti valid refer e ${config.REFERRAL_BONUS}৳ paben.\n\nApnar link:\n${link}`
  );
});

bot.hears('🎁 Daily Bonus', requireJoined, async (ctx) => {
  const r = await db.claimDaily(ctx.from.id, config.DAILY_BONUS, 24 * 60 * 60 * 1000);
  if (!r.ok) {
    const h = Math.floor(r.left / 3600000);
    const m = Math.floor((r.left % 3600000) / 60000);
    return ctx.reply(`⏳ Abar nite parben ${h}h ${m}m pore.`);
  }
  return ctx.reply(`🎁 +${config.DAILY_BONUS}৳ Daily Bonus peyechen!`);
});

bot.hears('📋 Tasks', requireJoined, (ctx) =>
  ctx.reply('📋 Tasks website open korte WEBAPP_URL (https) set korun, tarpor /start din.')
);

bot.hears('ℹ️ Help', (ctx) =>
  ctx.reply(
    `ℹ️ Kivabe kaj kore:\n1. Channel join kore verify korun\n2. 📋 Tasks e jan, task complete korun\n3. Balance ${config.MIN_WITHDRAW}৳ hole 💸 Withdraw diye bKash/Nagad e nin`
  )
);

// ---------- withdraw, proof review, /admin, /pending (features.js) ----------
registerFeatures(bot, { requireJoined });

bot.catch((err, ctx) => console.error(`Error for ${ctx.updateType}:`, err));

// ---------- website (Mini App) file khuje ber kora ----------
// Folder er nam "Public"/"public" je-i hok, ba ek dhap upore thakleo khuje nibe
function findPublicDir() {
  for (const base of [__dirname, path.join(__dirname, '..')]) {
    try {
      const dir = fs
        .readdirSync(base, { withFileTypes: true })
        .find((e) => e.isDirectory() && e.name.toLowerCase() === 'public');
      if (dir && fs.existsSync(path.join(base, dir.name, 'index.html'))) {
        return path.join(base, dir.name);
      }
    } catch (_) {}
  }
  return null;
}

// ---------- server + launch ----------
async function main() {
  await db.connectDB();
  await db.seedTasks();
  bot.botInfo = await bot.telegram.getMe();

  const app = express();
  app.get('/health', (_, res) => res.send('Bot is running'));
  // admin age, noile /api er user-auth oi path ke atke dey
  app.use('/api/admin', makeAdminApi(bot));
  app.use('/api', makeApi(bot));

  const publicDir = findPublicDir();
  console.log('Website folder:', publicDir || 'NOT FOUND');
  app.get('/', (req, res) => {
    const file = publicDir
      ? path.join(publicDir, 'index.html')
      : fs.existsSync(path.join(__dirname, 'index.html')) && path.join(__dirname, 'index.html');
    if (file) return res.sendFile(file);
    res.status(500).send('index.html paoa jayni. Repo te public/index.html (choto haater public) rakhun.');
  });
  if (publicDir) app.use(express.static(publicDir));

  if (config.WEBHOOK_URL) {
    const hookPath = `/webhook/${config.BOT_TOKEN.split(':')[0]}`;
    app.use(bot.webhookCallback(hookPath));
    app.listen(config.PORT, async () => {
      await bot.telegram.setWebhook(`${config.WEBHOOK_URL}${hookPath}`);
      console.log('Webhook mode on port', config.PORT);
    });
  } else {
    app.listen(config.PORT, () => console.log('Server on port', config.PORT));
    await bot.launch();
    console.log('Polling mode');
  }

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
