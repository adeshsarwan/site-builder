// Firestore in production; in-memory for local dev/tests (STORE=memory).

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
const KEEP_DAYS = Number(process.env.KEEP_DAYS ?? 21);
const MAX_PER_BUCKET = Number(process.env.MAX_PER_BUCKET ?? 200);

/** Merges fresh jobs into the stored bucket: newest first, deduped, drops jobs older than KEEP_DAYS. */
export async function saveBucket(country, category, fresh) {
  const prev = (await get('buckets', `${country}_${category}`))?.jobs ?? [];
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  const byId = new Map();
  for (const j of [...fresh, ...prev]) if (!byId.has(j.id)) byId.set(j.id, j);
  const jobs = [...byId.values()]
    .filter((j) => !j.postedAt || Date.parse(j.postedAt) >= cutoff)
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
    .slice(0, MAX_PER_BUCKET);
  const data = { country, category, jobs, fetchedAt: new Date().toISOString() };
  await set('buckets', `${country}_${category}`, data);
  hot.set(`${country}_${category}`, { at: Date.now(), data });
}

/** Monthly JSearch request counter. Returns false (and counts nothing) if `n` more would exceed MONTHLY_CAP. */
export async function useRequests(n) {
  const month = new Date().toISOString().slice(0, 7);
  const u = (await get('usage', month)) ?? { month, requests: 0 };
  if (u.requests + n > Number(process.env.MONTHLY_CAP ?? 9500)) return false;
  u.requests += n;
  await set('usage', month, u);
  return true;
}
export const usage = async (month) => get('usage', month);
