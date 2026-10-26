const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const db = require('./db');

// Telegram Mini App login: initData er signature verify kore
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 24 * 60 * 60) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch (_) {
    return null;
  }
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error('API error:', e);
    res.status(500).json({ error: 'Server error, abar chesta korun' });
  });

async function auth(req, res, next) {
  const tgUser = verifyInitData(req.get('X-Init-Data'));
  if (!tgUser) return res.status(401).json({ error: 'Telegram bot theke open korun' });
  const user = await db.getUser(tgUser.id);
  if (!user || !user.verified) {
    return res.status(403).json({ error: 'Age bot e /start diye channel join kore verify korun' });
  }
  if (user.banned) return res.status(403).json({ error: 'Apnar account ban kora hoyeche' });
  req.user = user;
  next();
}

async function isChannelMember(bot, channel, userId) {
  try {
    const m = await bot.telegram.getChatMember(channel, userId);
    return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch (e) {
    console.error('getChatMember failed:', e.message);
    return false;
  }
}

module.exports = function makeApi(bot) {
  const router = express.Router();
  router.use(express.json());
  router.use((req, res, next) => auth(req, res, next).catch(() => res.status(500).json({ error: 'Server error' })));

  router.get('/me', wrap(async (req, res) => {
    const u = await db.getUser(req.user.tgId);
    res.json({ name: u.name, balance: u.balance, totalEarned: u.totalEarned });
  }));

  router.get('/tasks', wrap(async (req, res) => {
    const uid = req.user.tgId;
    const [tasks, done, starts, proofs] = await Promise.all([
      db.listTasks(),
      db.getCompletedTaskIds(uid),
      db.getStarts(uid),
      db.getProofStatuses(uid),
    ]);
    res.json({
      now: Date.now(),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description || '',
        type: t.type,
        reward: t.reward,
        url: t.url || '',
        seconds: t.seconds || 0,
        done: done.has(t.id),
        startedAt: starts[t.id] || null,
        proofStatus: proofs[t.id] || null,
      })),
    });
  }));

  // Timer task start (ad dekha / link visit)
  router.post('/tasks/:id/start', wrap(async (req, res) => {
    const task = await db.getTask(req.params.id);
    if (!task || !task.active || task.type !== 'timer') {
      return res.status(404).json({ error: 'Task paoa jayni' });
    }
    const startedAt = await db.startTask(req.user.tgId, task.id);
    res.json({ startedAt, now: Date.now() });
  }));

  // Proof task: user ke bot chat e screenshot pathate bole
  router.post('/tasks/:id/proof-start', wrap(async (req, res) => {
    const uid = req.user.tgId;
    const task = await db.getTask(req.params.id);
    if (!task || !task.active || task.type !== 'proof') {
      return res.status(404).json({ error: 'Task paoa jayni' });
    }
    const [done, proofs] = await Promise.all([db.getCompletedTaskIds(uid), db.getProofStatuses(uid)]);
    if (done.has(task.id)) return res.status(400).json({ error: 'Ei task ager e complete kora hoyeche' });
    if (proofs[task.id] === 'pending') return res.status(400).json({ error: 'Proof ekhono review hocche' });

    await db.setState(uid, { step: 'proof', taskId: task.id });
    await bot.telegram
      .sendMessage(uid, `📸 "${task.title}"\n\nEi chat e screenshot ta photo hishebe pathan (file hishebe na).\nCancel korte /cancel`)
      .catch(() => {});
    res.json({ ok: true });
  }));

  // Reward claim
  router.post('/tasks/:id/claim', wrap(async (req, res) => {
    const uid = req.user.tgId;
    const task = await db.getTask(req.params.id);
    if (!task || !task.active) return res.status(404).json({ error: 'Task paoa jayni' });

    if (task.type === 'proof') {
      return res.status(400).json({ error: 'Ei task e bot e screenshot proof submit korte hobe' });
    }

    if (task.type === 'telegram_join') {
      const ok = await isChannelMember(bot, task.channel, uid);
      if (!ok) return res.status(400).json({ error: 'Ekhono channel join kora hoyni' });
    }

    const r = await db.completeTask(uid, task);
    if (!r.ok) {
      const msg = {
        already: 'Ei task ager e complete kora hoyeche',
        not_started: 'Age task ta start korun',
        wait: `Ar ${Math.ceil((r.left || 0) / 1000)} second opekkha korun`,
      }[r.error] || 'Task complete kora jayni';
      return res.status(400).json({ error: msg });
    }
    const u = await db.getUser(uid);
    res.json({ ok: true, reward: task.reward, balance: u.balance });
  }));

  return router;
};

module.exports.verifyInitData = verifyInitData;
