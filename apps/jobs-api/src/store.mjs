// Firestore in production; in-memory for local dev/tests (STORE=memory).
import { createHash } from 'node:crypto';

const mem = new Map();
let db = null;
async function firestore() {
  if (!db) {
    const { Firestore } = await import('@google-cloud/firestore');
    db = new Firestore({ ignoreUndefinedProperties: true });
  }
  return db;
}
const useMem = () => process.env.STORE === 'memory';

async function get(col, id) {
  if (useMem()) return mem.get(`${col}/${id}`) ?? null;
  const snap = await (await firestore()).collection(col).doc(id).get();
  return snap.exists ? snap.data() : null;
}
async function set(col, id, data) {
  if (useMem()) return void mem.set(`${col}/${id}`, data);
  await (await firestore()).collection(col).doc(id).set(data);
}

// Small in-process cache so hot buckets don't hit Firestore on every request.
const hot = new Map();
export async function getBucket(country, category) {
  const id = `${country}_${category}`;
  const h = hot.get(id);
  if (h && Date.now() - h.at < 10 * 60_000) return h.data;
  const data = await get('buckets', id);
  hot.set(id, { at: Date.now(), data });
  return data;
}
export async function saveBucket(country, category, jobs) {
  const data = { country, category, jobs, fetchedAt: new Date().toISOString() };
  await set('buckets', `${country}_${category}`, data);
  hot.set(`${country}_${category}`, { at: Date.now(), data });
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
export async function getLive(key) {
  const d = await get('live', hash(key));
  return d && Date.now() - Date.parse(d.at) < 6 * 3600_000 ? d.jobs : null;
}
export const saveLive = (key, jobs) => set('live', hash(key), { key, jobs, at: new Date().toISOString() });

/** Counts JSearch requests per day and month; returns false if the daily live budget is spent. */
export async function useRequests(n, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const u = (await get('usage', day)) ?? { day, refresh: 0, live: 0 };
  if (kind === 'live' && u.live + n > Number(process.env.LIVE_DAILY_CAP ?? 100)) return false;
  u[kind] = (u[kind] ?? 0) + n;
  await set('usage', day, u);
  return true;
}
export const usage = async (day) => get('usage', day);
