const express = require('express');
const config = require('./config');
const db = require('./db');
const { verifyInitData } = require('./api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function makeAdminApi(bot) {
  const router = express.Router();
  router.use(express.json());

  // sudhu ADMIN_IDS er user dhukte parbe
  router.use((req, res, next) => {
    const tg = verifyInitData(req.get('X-Init-Data'));
    if (!tg || !config.ADMIN_IDS.includes(tg.id)) return res.status(403).json({ error: 'Admin only' });
    req.adminId = tg.id;
    next();
  });

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error('Admin API error:', e);
      res.status(500).json({ error: 'Server error' });
    });

  router.get('/stats', wrap(async (req, res) => res.json(await db.getStats())));

  // ----- tasks -----
  router.get('/tasks', wrap(async (req, res) => res.json({ tasks: await db.listAllTasks() })));

  router.post('/tasks', wrap(async (req, res) => {
    const b = req.body || {};
    const type = ['telegram_join', 'timer', 'proof'].includes(b.type) ? b.type : null;
    const title = String(b.title || '').trim().slice(0, 100);
    const reward = Number(b.reward);
    if (!type || !title || !(reward > 0) || reward > 10000) {
      return res.status(400).json({ error: 'Type, title ar reward thik dian' });
    }

    const task = {
      type,
      title,
      description: String(b.description || '').trim().slice(0, 200),
      reward: Math.round(reward * 100) / 100,
      order: Number.isFinite(Number(b.order)) && b.order !== '' ? Number(b.order) : 99,
    };

    if (type === 'telegram_join') {
      const name = String(b.channel || '').trim().replace(/\/+$/, '').split('/').pop().replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{5,32}$/.test(name)) {
        return res.status(400).json({ error: 'Channel username thik dian (@name)' });
      }
      task.channel = '@' + name;
      task.url = 'https://t.me/' + name;
    } else {
      const url = String(b.url || '').trim();
      if (!/^https:\/\//.test(url)) return res.status(400).json({ error: 'Link https:// diye shuru hote hobe' });
      task.url = url;
      if (type === 'timer') {
        const s = Number(b.seconds);
        if (!(s >= 5 && s <= 300)) return res.status(400).json({ error: 'Seconds 5 theke 300 er moddhe' });
        task.seconds = Math.round(s);
      }
    }

    const id = await db.createTask(task);
    res.json({ ok: true, id });
  }));

  router.post('/tasks/:id/toggle', wrap(async (req, res) => {
    const t = await db.getTask(req.params.id);
    if (!t) return res.status(404).json({ error: 'Task paoa jayni' });
    await db.setTaskActive(t.id, !t.active);
    res.json({ ok: true, active: !t.active });
  }));

  router.delete('/tasks/:id', wrap(async (req, res) => {
    await db.deleteTask(req.params.id);
    res.json({ ok: true });
  }));

  // ----- users -----
  router.get('/user', wrap(async (req, res) => {
    const u = await db.findUser(req.query.q);
    if (!u) return res.status(404).json({ error: 'User paoa jayni' });
    res.json({ user: u });
  }));

  router.post('/user/:id/ban', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const banned = !!(req.body && req.body.banned);
    if (config.ADMIN_IDS.includes(id)) return res.status(400).json({ error: 'Admin ke ban kora jay na' });
    const u = await db.getUser(id);
    if (!u) return res.status(404).json({ error: 'User paoa jayni' });
    await db.updateUser(id, { banned });
    res.json({ ok: true, banned });
  }));

  router.post('/user/:id/balance', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const amount = Math.round(Number(req.body && req.body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) {
      return res.status(400).json({ error: 'Amount thik dian (+ ba -)' });
    }
    const u = await db.getUser(id);
    if (!u) return res.status(404).json({ error: 'User paoa jayni' });
    if ((u.balance || 0) + amount < 0) return res.status(400).json({ error: 'Balance minus hoye jabe' });
    await db.incUser(id, { balance: amount });
    const nu = await db.getUser(id);
    res.json({ ok: true, balance: nu.balance });
  }));

  // ----- broadcast -----
  router.post('/broadcast', wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text || text.length > 3500) return res.status(400).json({ error: 'Message 1 theke 3500 akkhor' });

    const ids = await db.listUserIds();
    res.json({ ok: true, total: ids.length });

    // background e pathay (Telegram limit er jonno ektu ektu gap diye)
    (async () => {
      let sent = 0;
      let failed = 0;
      for (const id of ids) {
        try { await bot.telegram.sendMessage(id, text); sent++; } catch (_) { failed++; }
        await sleep(50);
      }
      bot.telegram
        .sendMessage(req.adminId, `📢 Broadcast shesh\nPathano: ${sent}\nFail: ${failed}`)
        .catch(() => {});
    })();
  }));

  return router;
};
