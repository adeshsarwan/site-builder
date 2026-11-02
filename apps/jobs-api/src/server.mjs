// Jobs API (Cloud Run). The sites call GET /jobs; Cloud Scheduler calls POST /internal/refresh.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { timingSafeEqual } from 'node:crypto';
import { COUNTRIES, CATEGORIES, ALIASES } from './catalog.mjs';
import { jsearch } from './jsearch.mjs';
import { upsertJobs, prune, searchJobs, topCompanies, useRequests, usage, ping } from './store.mjs';

const app = new Hono();
const PAGES = Number(process.env.PAGES_PER_BUCKET ?? 3);

app.get('/health', async (c) => {
  try { return c.json({ ok: true, jobs: await ping() }); } catch (e) { return c.json({ ok: false, error: 'database unavailable' }, 503); }
});

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
// Visitor searches are answered ONLY from the stored jobs — they never call JSearch.
app.get('/jobs', async (c) => {
  const p = c.req.query();
  const country = pickCountry(p.country);
  const category = pickCategory(p.category);
  const remoteOnly = p.remote === 'yes' || p.remote === 'true';
  const limit = Math.min(50, Math.max(1, Number(p.limit ?? 20) || 20));
  const offset = Math.max(0, Number(p.offset ?? 0) || 0);
  const q = String(p.q ?? '').trim().toLowerCase();
  const loc = String(p.location ?? '').trim().toLowerCase();

  const level = ['entry', 'mid', 'senior'].includes(p.level) ? p.level : null;
  const { jobs, total } = await searchJobs({ country, category, remoteOnly, level, q, location: loc, limit, offset });
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ jobs, total, country, category, source: 'database' });
});

// GET /companies?country=us&category=&remote=yes&limit=12 — top employers by open roles (database only)
app.get('/companies', async (c) => {
  const p = c.req.query();
  const country = pickCountry(p.country);
  const companies = await topCompanies({
    country, category: pickCategory(p.category), remoteOnly: p.remote === 'yes',
    limit: Math.min(48, Math.max(1, Number(p.limit ?? 12) || 12)),
  });
  c.header('Cache-Control', 'public, max-age=900');
  return c.json({ country, companies });
});

// POST /internal/refresh[?country=us&category=tech] — fetch fresh buckets from JSearch.
app.post('/internal/refresh', async (c) => {
  const onlyCountry = c.req.query('country');
  const onlyCat = c.req.query('category');
  const countries = onlyCountry ? [pickCountry(onlyCountry)] : Object.keys(COUNTRIES);
  const cats = onlyCat && pickCategory(onlyCat) ? [pickCategory(onlyCat)] : Object.keys(CATEGORIES);
  const report = [];
  let requests = 0;
  let stop = false;
  for (const country of countries) {
    for (const cat of cats) {
      const def = CATEGORIES[cat];
      const seen = new Set();
      const jobs = [];
      try {
        for (let page = 1; page <= PAGES; page++) {
          if (!(await useRequests(1))) throw Object.assign(new Error('Monthly request cap reached'), { status: 429 });
          const res = await jsearch({ query: `${def.query} in ${COUNTRIES[country].name}`, country, page, remote: Boolean(def.remote) });
          requests++;
          for (const j of res) if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
          if (res.length < 10) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        if (jobs.length) await upsertJobs(country, cat, jobs);
        report.push({ bucket: `${country}_${cat}`, jobs: jobs.length });
      } catch (e) {
        report.push({ bucket: `${country}_${cat}`, error: e.message });
        if (e.status === 429) { stop = true; break; }
      }
    }
    if (stop) break;
  }
  const pruned = await prune();
  console.log(JSON.stringify({ event: 'refresh', requests, buckets: report.length, pruned }));
  return c.json({ requests, pruned, report });
});

app.get('/internal/usage', async (c) => {
  const month = c.req.query('month') ?? new Date().toISOString().slice(0, 7);
  return c.json({ month, requests: 0, cap: Number(process.env.MONTHLY_CAP ?? 9500), ...((await usage(month)) ?? {}) });
});

const port = Number(process.env.PORT ?? 8080);
if (process.env.NO_LISTEN !== '1') serve({ fetch: app.fetch, port }, () => console.log(`jobs-api listening on ${port}`));
export default app;
