const admin = require('firebase-admin');
const config = require('./config');

let db;
const FV = admin.firestore.FieldValue;
const users = () => db.collection('users');

function loadServiceAccount() {
  const raw = (config.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function connectDB() {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  db = admin.firestore();
  await db.collection('_meta').doc('ping').set({ t: Date.now() });
  console.log('Firebase connected');
}

async function getUser(tgId) {
  const s = await users().doc(String(tgId)).get();
  return s.exists ? { tgId: Number(s.id), ...s.data() } : null;
}

async function createUser({ tgId, name, username, referredBy }) {
  const data = {
    name: name || '',
    username: username || '',
    balance: 0,
    totalEarned: 0,
    verified: false,
    banned: false,
    referredBy: referredBy || null,
    referralPaid: false,
    refCount: 0,
    lastDaily: 0,
    joinedAt: Date.now(),
  };
  await users().doc(String(tgId)).set(data);
  return { tgId, ...data };
}

async function updateUser(tgId, data) {
  await users().doc(String(tgId)).update(data);
}

// Atomic increment, e.g. incUser(id, { balance: 5, totalEarned: 5 })
async function incUser(tgId, fields) {
  const upd = {};
  for (const [k, v] of Object.entries(fields)) upd[k] = FV.increment(v);
  await users().doc(String(tgId)).update(upd);
}

// Marks verified exactly once, so referral bonus can't be paid twice
async function claimVerify(tgId) {
  return db.runTransaction(async (t) => {
    const ref = users().doc(String(tgId));
    const s = await t.get(ref);
    if (!s.exists) return null;
    const u = s.data();
    if (u.verified) return { first: false, user: u };
    t.update(ref, { verified: true });
    return { first: true, user: u };
  });
}

// Daily bonus with cooldown, safe against double tap
async function claimDaily(tgId, amount, cooldownMs) {
  return db.runTransaction(async (t) => {
    const ref = users().doc(String(tgId));
    const s = await t.get(ref);
    const u = s.data();
    const now = Date.now();
    const passed = now - (u.lastDaily || 0);
    if (passed < cooldownMs) return { ok: false, left: cooldownMs - passed };
    t.update(ref, {
      balance: FV.increment(amount),
      totalEarned: FV.increment(amount),
      lastDaily: now,
    });
    return { ok: true };
  });
}

// ---------- tasks ----------
const tasksCol = () => db.collection('tasks');

async function seedTasks() {
  const snap = await tasksCol().limit(1).get();
  if (!snap.empty) return;
  const now = Date.now();
  const defaults = [
    {
      title: 'Join our Telegram channel',
      description: 'Channel join korun, tarpor Verify chapun',
      type: 'telegram_join',
      channel: '@Shakil_X9X',
      url: 'https://t.me/Shakil_X9X',
      reward: 2,
      order: 1,
    },
    {
      title: 'Watch ad (demo)',
      description: 'Link khule 15 second thakun, tarpor Claim korun. Admin e real ad link boshaben',
      type: 'timer',
      url: 'https://t.me/Shakil_X9X',
      seconds: 15,
      reward: 0.5,
      order: 2,
    },
    {
      title: 'Subscribe YouTube: ShakilX9X',
      description: 'Subscribe kore screenshot proof dite hobe',
      type: 'proof',
      url: 'https://www.youtube.com/@ShakilX9X',
      reward: 3,
      order: 3,
    },
    {
      title: 'Subscribe YouTube: Shakil_FX',
      description: 'Subscribe kore screenshot proof dite hobe',
      type: 'proof',
      url: 'https://www.youtube.com/@Shakil_FX',
      reward: 3,
      order: 4,
    },
  ];
  for (const t of defaults) await tasksCol().add({ ...t, active: true, createdAt: now });
  console.log('Default tasks seeded');
}

async function listTasks() {
  const snap = await tasksCol().where('active', '==', true).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function getTask(id) {
  const s = await tasksCol().doc(String(id)).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}

async function getCompletedTaskIds(uid) {
  const snap = await db.collection('completions').where('uid', '==', Number(uid)).get();
  return new Set(snap.docs.map((d) => d.data().taskId));
}

async function getStarts(uid) {
  const snap = await db.collection('starts').where('uid', '==', Number(uid)).get();
  const out = {};
  snap.docs.forEach((d) => { out[d.data().taskId] = d.data().startedAt; });
  return out;
}

// Start time ekbar-i set hoy (reset kora jabe na)
async function startTask(uid, taskId) {
  const ref = db.collection('starts').doc(`${uid}_${taskId}`);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.exists) return s.data().startedAt;
    const startedAt = Date.now();
    t.set(ref, { uid: Number(uid), taskId, startedAt });
    return startedAt;
  });
}

// Reward dewa: ekta task ekbar-i, timer server e check hoy
async function completeTask(uid, task) {
  return db.runTransaction(async (t) => {
    const cRef = db.collection('completions').doc(`${uid}_${task.id}`);
    const uRef = users().doc(String(uid));
    const refs = [cRef, uRef];
    if (task.type === 'timer') refs.push(db.collection('starts').doc(`${uid}_${task.id}`));
    const snaps = await t.getAll(...refs);

    if (snaps[0].exists) return { ok: false, error: 'already' };
    if (!snaps[1].exists) return { ok: false, error: 'no_user' };

    if (task.type === 'timer') {
      if (!snaps[2].exists) return { ok: false, error: 'not_started' };
      const left = (task.seconds || 0) * 1000 - (Date.now() - snaps[2].data().startedAt);
      if (left > 0) return { ok: false, error: 'wait', left };
    }

    t.set(cRef, { uid: Number(uid), taskId: task.id, reward: task.reward, at: Date.now() });
    t.update(uRef, {
      balance: FV.increment(task.reward),
      totalEarned: FV.increment(task.reward),
    });
    return { ok: true };
  });
}

module.exports = {
  connectDB, getUser, createUser, updateUser, incUser, claimVerify, claimDaily,
  seedTasks, listTasks, getTask, getCompletedTaskIds, getStarts, startTask, completeTask,
};
                       
