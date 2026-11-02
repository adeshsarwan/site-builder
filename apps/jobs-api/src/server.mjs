// Jobs API (Cloud Run). The sites call GET /jobs; Cloud Scheduler calls POST /internal/refresh.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { timingSafeEqual } from 'node:crypto';
import { COUNTRIES, CATEGORIES, ALIASES } from './catalog.mjs';
import { jsearch } from './jsearch.mjs';
import { getBucket, saveBucket, getLive, saveLive, useRequests, usage } from './store.mjs';

const app = new Hono();
const PAGES = Number(process.env.PAGES_PER_BUCKET ?? 2);

app.get('/health', (c) => c.json({ ok: true }));

app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const given = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const want = process.env.JOBS_API_KEY ?? '';
  const ok = want && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
  return ok ? next() : c.json({ error: 'unauthorized' }, 401);
});

const pickCountry = (v) => {
  const k = String(v ?? 'us').toLowerCase();
  const a = k in ALIASES ? ALIASES[k] : k;
  return a && COUNTRIES[a] ? a : 'us';
};
const pickCategory = (v) => {
  const k = String(v ?? '').toLowerCase();
  return CATEGORIES[k] ? k : null;
};

app.get('/catalog', (c) => c.json({ countries: COUNTRIES, categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])) }));

// GET /jobs?country=us&category=tech&remote=yes&level=entry&q=nurse&location=austin&limit=20&offset=0
app.get('/jobs', async (c) => {
  const p = c.req.query();
  const country = pickCountry(p.country);
  const category = pickCategory(p.category);
  const remoteOnly = p.remote === 'yes' || p.remote === 'true';
  const limit = Math.min(50, Math.max(1, Number(p.limit ?? 20) || 20));
  const offset = Math.max(0, Number(p.offset ?? 0) || 0);
  const q = String(p.q ?? '').trim().toLowerCase();
  const loc = String(p.location ?? '').trim().toLowerCase();

  const cats = category ? [category] : remoteOnly ? ['remote', ...Object.keys(CATEGORIES).filter((k) => k !== 'remote')] : Object.keys(CATEGORIES);
  const buckets = await Promise.all(cats.map((k) => getBucket(country, k)));
  const seen = new Set();
  let jobs = buckets.flatMap((b) => b?.jobs ?? []).filter((j) => !seen.has(j.id) && seen.add(j.id));

  if (remoteOnly) jobs = jobs.filter((j) => j.remote);
  if (p.level && ['entry', 'mid', 'senior'].includes(p.level)) jobs = jobs.filter((j) => !j.level || j.level === p.level);
  if (loc && loc !== 'remote') jobs = jobs.filter((j) => j.location.toLowerCase().includes(loc));
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length) jobs = jobs.filter((j) => words.every((w) => `${j.title} ${j.company} ${j.snippet ?? ''}`.toLowerCase().includes(w)));

  // Free-text search the stored buckets can't answer → one live JSearch call (cached 6h, daily cap).
  let source = 'cache';
  if (words.length && jobs.length < 5) {
    const query = `${q}${loc && loc !== 'remote' ? ` in ${loc}` : ''} in ${COUNTRIES[country].name}`;
    const key = `${query}|${country}|${remoteOnly}`;
    let live = await getLive(key);
    if (!live && (await useRequests(1, 'live'))) {
      try {
        live = await jsearch({ query, country, remote: remoteOnly, datePosted: 'month' });
        await saveLive(key, live);
      } catch (e) {
        console.error('live search failed', e.message);
      }
    }
    if (live?.length) {
      for (const j of live) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
      source = 'live';
    }
  }

  jobs.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ jobs: jobs.slice(offset, offset + limit), total: jobs.length, country, category, source });
});

// POST /internal/refresh[?country=us&category=tech] — fetch fresh buckets from JSearch.
app.post('/internal/refresh', async (c) => {
  const onlyCountry = c.req.query('country');
  const onlyCat = c.req.query('category');
  const countries = onlyCountry ? [pickCountry(onlyCountry)] : Object.keys(COUNTRIES);
  const cats = onlyCat && pickCategory(onlyCat) ? [pickCategory(onlyCat)] : Object.keys(CATEGORIES);
  const report = [];
  let requests = 0;
  for (const country of countries) {
    for (const cat of cats) {
      const def = CATEGORIES[cat];
      const seen = new Set();
      const jobs = [];
      try {
        for (let page = 1; page <= PAGES; page++) {
          const res = await jsearch({ query: `${def.query} in ${COUNTRIES[country].name}`, country, page, remote: Boolean(def.remote) });
          requests++;
          for (const j of res) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
          if (res.length < 10) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        if (jobs.length) await saveBucket(country, cat, jobs);
        report.push({ bucket: `${country}_${cat}`, jobs: jobs.length });
      } catch (e) {
        report.push({ bucket: `${country}_${cat}`, error: e.message });
        if (e.status === 429) break;
      }
    }
  }
  await useRequests(requests, 'refresh');
  console.log(JSON.stringify({ event: 'refresh', requests, buckets: report.length }));
  return c.json({ requests, report });
});

app.get('/internal/usage', async (c) => c.json((await usage(c.req.query('day') ?? new Date().toISOString().slice(0, 10))) ?? {}));

const port = Number(process.env.PORT ?? 8080);
if (process.env.NO_LISTEN !== '1') serve({ fetch: app.fetch, port }, () => console.log(`jobs-api listening on ${port}`));
export default app;
