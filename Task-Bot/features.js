// Withdraw (bKash / Nagad), YouTube proof review, admin buttons
const { Markup } = require('telegraf');
const config = require('./config');
const db = require('./db');

const MENU = new Set(['📋 Tasks', '💰 Balance', '👥 Refer', '🎁 Daily Bonus', '💸 Withdraw', 'ℹ️ Help']);
const METHOD = { bkash: 'bKash', nagad: 'Nagad' };
const isAdmin = (id) => config.ADMIN_IDS.includes(id);
const fmt = (n) => Number(n || 0).toFixed(2);
const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const proofButtons = (uid, taskId) =>
  Markup.inlineKeyboard([[
    Markup.button.callback('✅ Approve', `pa:${uid}:${taskId}`),
    Markup.button.callback('❌ Reject', `pr:${uid}:${taskId}`),
  ]]);

const withdrawButtons = (id) =>
  Markup.inlineKeyboard([[
    Markup.button.callback('✅ Paid', `wp:${id}`),
    Markup.button.callback('❌ Reject', `wr:${id}`),
  ]]);

function sendProofToAdmin(bot, adminId, s) {
  const caption = `📸 Proof\nUser: ${esc(s.name)} (${s.uid})\nTask: ${esc(s.title)}\nReward: ${fmt(s.reward)}৳`;
  return bot.telegram.sendPhoto(adminId, s.fileId, {
    caption, parse_mode: 'HTML', ...proofButtons(s.uid, s.taskId),
  });
}

function sendWithdrawToAdmin(bot, adminId, id, w) {
  const text =
    `💸 Withdraw request\nUser: ${esc(w.name)} (${w.uid})\nMethod: ${METHOD[w.method]}\n` +
    `Number: ${esc(w.number)}\nAmount: ${fmt(w.amount)}৳`;
  return bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML', ...withdrawButtons(id) });
}

async function toAdmins(fn) {
  for (const id of config.ADMIN_IDS) {
    try { await fn(id); } catch (e) { console.error('admin notify failed:', e.message); }
  }
}

// admin message e result likhe button soriye dey
async function stamp(ctx, note) {
  const m = ctx.callbackQuery.message;
  try {
    if (m.caption !== undefined) await ctx.editMessageCaption(`${m.caption}\n\n${note}`);
    else await ctx.editMessageText(`${m.text}\n\n${note}`);
  } catch (_) {}
}

module.exports = function register(bot, { requireJoined }) {
  // ---------- /cancel ----------
  bot.command('cancel', async (ctx) => {
    if (ctx.user) await db.setState(ctx.from.id, null);
    return ctx.reply('❎ Cancel kora hoyeche.');
  });

  // ---------- Withdraw: method ----------
  bot.hears('💸 Withdraw', requireJoined, async (ctx) => {
    const u = await db.getUser(ctx.from.id);
    if (!u) return ctx.reply('Age /start din.');
    if (u.balance < config.MIN_WITHDRAW) {
      return ctx.reply(
        `💸 Minimum withdraw ${config.MIN_WITHDRAW}৳.\nApnar balance ${fmt(u.balance)}৳, aro task korun 💪`
      );
    }
    return ctx.reply(
      `💸 Withdraw\nBalance: ${fmt(u.balance)}৳\nMinimum: ${config.MIN_WITHDRAW}৳\n\nMethod select korun:`,
      Markup.inlineKeyboard([[
        Markup.button.callback('bKash', 'wd:bkash'),
        Markup.button.callback('Nagad', 'wd:nagad'),
      ]])
    );
  });

  bot.action(/^wd:(bkash|nagad)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const u = await db.getUser(ctx.from.id);
    if (!u || !u.verified) return;
    if (u.balance < config.MIN_WITHDRAW) {
      return ctx.reply(`❌ Balance kom. Minimum ${config.MIN_WITHDRAW}৳.`);
    }
    const method = ctx.match[1];
    await db.setState(ctx.from.id, { step: 'wd_number', method });
    try { await ctx.deleteMessage(); } catch (_) {}
    return ctx.reply(`📱 Apnar ${METHOD[method]} number pathan (jemon 017XXXXXXXX)\n\nCancel korte /cancel`);
  });

  // ---------- Withdraw: number & amount (text) ----------
  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const st = ctx.user && ctx.user.state;
    if (!st) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();
    if (MENU.has(text)) {
      await db.setState(ctx.from.id, null); // menu chaple flow bondho
      return next();
    }

    if (st.step === 'wd_number') {
      if (!/^01[3-9]\d{8}$/.test(text)) {
        return ctx.reply('❌ Number thik noy. 11 digit, 01 diye shuru hote hobe. Abar pathan:');
      }
      await db.setState(ctx.from.id, { step: 'wd_amount', method: st.method, number: text });
      const u = await db.getUser(ctx.from.id);
      return ctx.reply(`💵 Koto taka withdraw korben?\n(${config.MIN_WITHDRAW}৳ theke ${fmt(u.balance)}৳ er moddhe)`);
    }

    if (st.step === 'wd_amount') {
      const amount = Math.round(Number(text) * 100) / 100;
      if (!Number.isFinite(amount) || amount < config.MIN_WITHDRAW) {
        return ctx.reply(`❌ Minimum ${config.MIN_WITHDRAW}৳. Sothik amount pathan:`);
      }
      const r = await db.createWithdrawal({
        uid: ctx.from.id, method: st.method, number: st.number, amount,
      });
      if (!r.ok) {
        if (r.error === 'low') return ctx.reply('❌ Apnar balance e eto taka nai. Kom amount pathan:');
        await db.setState(ctx.from.id, null);
        return ctx.reply('❌ Request kora jayni.');
      }
      await db.setState(ctx.from.id, null);
      await ctx.reply(
        `✅ Withdraw request pathano hoyeche!\n\n${METHOD[st.method]}: ${st.number}\nAmount: ${fmt(amount)}৳\n\nAdmin payment korle jananor message paben.`
      );
      await toAdmins((id) => sendWithdrawToAdmin(bot, id, r.id, r.w));
      return;
    }

    if (st.step === 'proof') return ctx.reply('📸 Screenshot ta photo hishebe pathan. Cancel korte /cancel');
    return next();
  });

  // ---------- Proof screenshot (photo) ----------
  bot.on('photo', async (ctx, next) => {
    const st = ctx.user && ctx.user.state;
    if (!st || st.step !== 'proof') return next();

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const task = await db.getTask(st.taskId);
    if (!task || !task.active) {
      await db.setState(ctx.from.id, null);
      return ctx.reply('❌ Ei task ta ar nai.');
    }

    const r = await db.createSubmission({
      uid: ctx.from.id,
      taskId: task.id,
      name: ctx.user.name,
      title: task.title,
      reward: task.reward,
      fileId: photo.file_id,
      uniqueId: photo.file_unique_id,
    });

    if (!r.ok) {
      if (r.error === 'duplicate') {
        return ctx.reply('❌ Ei screenshot ager e use kora hoyeche. Nijer notun screenshot pathan.');
      }
      await db.setState(ctx.from.id, null);
      return ctx.reply(
        r.error === 'done' ? '✅ Ei task ager e complete.' : '⏳ Ager proof ekhono review hocche.'
      );
    }

    await db.setState(ctx.from.id, null);
    await ctx.reply('✅ Proof pathano hoyeche! Admin review korle taka add hobe.');
    await toAdmins((id) => sendProofToAdmin(bot, id, r.data));
  });

  // ---------- Admin: proof approve / reject ----------
  bot.action(/^p([ar]):(\d+):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
    const approve = ctx.match[1] === 'a';
    const uid = Number(ctx.match[2]);
    const taskId = ctx.match[3];

    const r = await db.resolveSubmission(uid, taskId, approve);
    if (!r.ok) {
      await ctx.answerCbQuery('Ager e handle kora hoyeche', { show_alert: true });
      return stamp(ctx, '⚠️ Already handled');
    }
    await ctx.answerCbQuery(approve ? 'Approved' : 'Rejected');
    await stamp(ctx, `${approve ? '✅ APPROVED' : '❌ REJECTED'} by ${ctx.from.first_name}`);

    ctx.telegram
      .sendMessage(
        uid,
        approve
          ? `🎉 Proof approved! "${r.sub.title}" er jonno +${fmt(r.sub.reward)}৳ add hoyeche.`
          : `❌ "${r.sub.title}" er proof reject hoyeche. Sothik screenshot diye abar Tasks theke submit korun.`
      )
      .catch(() => {});
  });

  // ---------- Admin: withdraw paid / reject ----------
  bot.action(/^w([pr]):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admin only', { show_alert: true });
    const paid = ctx.match[1] === 'p';

    const r = await db.resolveWithdrawal(ctx.match[2], paid);
    if (!r.ok) {
      await ctx.answerCbQuery('Ager e handle kora hoyeche', { show_alert: true });
      return stamp(ctx, '⚠️ Already handled');
    }
    await ctx.answerCbQuery(paid ? 'Marked paid' : 'Rejected & refunded');
    await stamp(ctx, `${paid ? '✅ PAID' : '❌ REJECTED (refunded)'} by ${ctx.from.first_name}`);

    ctx.telegram
      .sendMessage(
        r.w.uid,
        paid
          ? `✅ ${fmt(r.w.amount)}৳ apnar ${METHOD[r.w.method]} (${r.w.number}) e pathano hoyeche!`
          : `❌ Withdraw reject hoyeche. ${fmt(r.w.amount)}৳ apnar balance e ferot dewa hoyeche.`
      )
      .catch(() => {});
  });

  // ---------- Admin commands ----------
  bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    if (!config.WEBAPP_URL) return ctx.reply('WEBAPP_URL set nai.');
    return ctx.reply(
      '👑 Admin Panel',
      Markup.inlineKeyboard([[Markup.button.webApp('Open Admin Panel', `${config.WEBAPP_URL}/admin.html`)]])
    );
  });

  bot.command('pending', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { submissions, withdrawals } = await db.listPending();
    if (!submissions.length && !withdrawals.length) return ctx.reply('✅ Kono pending nai.');
    for (const s of submissions) await sendProofToAdmin(bot, ctx.from.id, s).catch(() => {});
    for (const w of withdrawals) await sendWithdrawToAdmin(bot, ctx.from.id, w.id, w).catch(() => {});
    return ctx.reply(`Pending: ${submissions.length} proof, ${withdrawals.length} withdraw`);
  });
};
