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

// ---------- user state (withdraw / proof flow) ----------
async function setState(uid, state) {
  await users().doc(String(uid)).update({ state: state || null });
}

async function findUser(q) {
  const s = String(q || '').trim().replace(/^@/, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return getUser(Number(s));
  const snap = await users().where('username', '==', s).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { tgId: Number(d.id), ...d.data() };
}

async function listUserIds() {
  const snap = await users().select().get();
  return snap.docs.map((d) => Number(d.id));
}

// ---------- proof submissions (YouTube subscribe etc.) ----------
async function createSubmission({ uid, taskId, name, title, reward, fileId, uniqueId }) {
  // ekta screenshot onno account e abar use kora jabe na
  const dup = await db.collection('submissions').where('uniqueId', '==', uniqueId).get();
  if (dup.docs.some((d) => d.data().status !== 'rejected')) return { ok: false, error: 'duplicate' };

  const sRef = db.collection('submissions').doc(`${uid}_${taskId}`);
  const cRef = db.collection('completions').doc(`${uid}_${taskId}`);
  return db.runTransaction(async (t) => {
    const [s, c] = await t.getAll(sRef, cRef);
    if (c.exists) return { ok: false, error: 'done' };
    if (s.exists && s.data().status === 'pending') return { ok: false, error: 'pending' };
    const data = {
      uid: Number(uid), taskId, name: name || '', title, reward, fileId, uniqueId,
      status: 'pending', at: Date.now(),
    };
    t.set(sRef, data);
    return { ok: true, data };
  });
}

async function getProofStatuses(uid) {
  const snap = await db.collection('submissions').where('uid', '==', Number(uid)).get();
  const out = {};
  snap.docs.forEach((d) => { out[d.data().taskId] = d.data().status; });
  return out;
}

async function resolveSubmission(uid, taskId, approve) {
  const sRef = db.collection('submissions').doc(`${uid}_${taskId}`);
  const cRef = db.collection('completions').doc(`${uid}_${taskId}`);
  const uRef = users().doc(String(uid));
  return db.runTransaction(async (t) => {
    const [s, c] = await t.getAll(sRef, cRef);
    if (!s.exists || s.data().status !== 'pending') return { ok: false, error: 'handled' };
    const sub = s.data();
    if (!approve) {
      t.update(sRef, { status: 'rejected', resolvedAt: Date.now() });
      return { ok: true, sub };
    }
    t.update(sRef, { status: 'approved', resolvedAt: Date.now() });
    if (!c.exists) {
      t.set(cRef, { uid: Number(uid), taskId, reward: sub.reward, at: Date.now() });
      t.update(uRef, {
        balance: FV.increment(sub.reward),
        totalEarned: FV.increment(sub.reward),
      });
    }
    return { ok: true, sub };
  });
}

// ---------- withdrawals ----------
async function createWithdrawal({ uid, method, number, amount }) {
  const uRef = users().doc(String(uid));
  const wRef = db.collection('withdrawals').doc();
  return db.runTransaction(async (t) => {
    const s = await t.get(uRef);
    if (!s.exists) return { ok: false, error: 'no_user' };
    const u = s.data();
    if (u.banned) return { ok: false, error: 'banned' };
    if (amount > (u.balance || 0) + 1e-9) return { ok: false, error: 'low' };
    const w = {
      uid: Number(uid), name: u.name || '', method, number, amount,
      status: 'pending', at: Date.now(),
    };
    t.update(uRef, { balance: FV.increment(-amount) });
    t.set(wRef, w);
    return { ok: true, id: wRef.id, w };
  });
}

async function resolveWithdrawal(id, paid) {
  const wRef = db.collection('withdrawals').doc(String(id));
  return db.runTransaction(async (t) => {
    const s = await t.get(wRef);
    if (!s.exists || s.data().status !== 'pending') return { ok: false, error: 'handled' };
    const w = s.data();
    t.update(wRef, { status: paid ? 'paid' : 'rejected', resolvedAt: Date.now() });
    // reject hole taka balance e ferot
    if (!paid) t.update(users().doc(String(w.uid)), { balance: FV.increment(w.amount) });
    return { ok: true, w };
  });
}

async function listPending() {
  const [subs, wds] = await Promise.all([
    db.collection('submissions').where('status', '==', 'pending').get(),
    db.collection('withdrawals').where('status', '==', 'pending').get(),
  ]);
  return {
    submissions: subs.docs.map((d) => d.data()),
    withdrawals: wds.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

// ---------- admin ----------
async function getStats() {
  const count = async (q) => (await q.count().get()).data().count;
  const [total, verified, proofs, wds, paidSnap] = await Promise.all([
    count(users()),
    count(users().where('verified', '==', true)),
    count(db.collection('submissions').where('status', '==', 'pending')),
    count(db.collection('withdrawals').where('status', '==', 'pending')),
    db.collection('withdrawals').where('status', '==', 'paid').get(),
  ]);
  const paidTotal = paidSnap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
  return {
    users: total, verified,
    pendingProofs: proofs, pendingWithdrawals: wds,
    paidCount: paidSnap.size, paidTotal,
  };
}

async function listAllTasks() {
  const snap = await tasksCol().get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function createTask(data) {
  const ref = await tasksCol().add({ ...data, active: true, createdAt: Date.now() });
  return ref.id;
}

async function setTaskActive(id, active) {
  await tasksCol().doc(String(id)).update({ active: !!active });
}

async function deleteTask(id) {
  await tasksCol().doc(String(id)).delete();
}

module.exports = {
  connectDB, getUser, createUser, updateUser, incUser, claimVerify, claimDaily,
  seedTasks, listTasks, getTask, getCompletedTaskIds, getStarts, startTask, completeTask,
  setState, findUser, listUserIds,
  createSubmission, getProofStatuses, resolveSubmission,
  createWithdrawal, resolveWithdrawal, listPending,
  getStats, listAllTasks, createTask, setTaskActive, deleteTask,
};
