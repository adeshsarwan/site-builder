// Local smoke test: fake JSearch server + in-memory store.
import http from 'node:http';

const fake = http.createServer((req, res) => {
  calls++;
  if (!req.url.startsWith('/logo') && !req.url.startsWith('/v1/messages') && req.headers['x-api-key'] !== 'own-key') return res.writeHead(403).end('{}');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/logo.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (u.pathname === '/v1/messages') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: '{"industry":"Software","summary":"Acme builds tools. It is hiring across many roles in the US."}' }] }));
  if (!u.pathname.endsWith('/search')) return res.writeHead(404).end('{}');
  const country = u.searchParams.get('country');
  const page = Number(u.searchParams.get('page'));
  const remote = u.searchParams.get('work_from_home') === 'true';
  const q = u.searchParams.get('query');
  const data = Array.from({ length: page === 1 ? 10 : 4 }, (_, i) => ({
    job_id: `${country}-${q}-${page}-${i}`, job_title: `${q.split(' ')[0]} role ${page}.${i}`, employer_name: 'Acme',
    job_city: 'Austin', job_state: 'TX', job_country: country.toUpperCase(), job_is_remote: remote || i % 3 === 0,
    job_min_salary: 50000, job_max_salary: 70000, job_salary_period: 'YEAR', job_salary_currency: 'USD',
    job_employment_type: 'FULLTIME', job_apply_link: 'https://example.com/apply', employer_logo: `http://127.0.0.1:${fake.address().port}/logo.png`, employer_website: 'https://acme.example',
    job_posted_at_datetime_utc: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), job_description: 'Great job '.repeat(40),
    job_required_experience: { no_experience_required: i % 2 === 0, required_experience_in_months: i % 2 ? 36 : null },
  }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'OK', data }));
});
await new Promise((r) => fake.listen(0, r));
Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE: `http://127.0.0.1:${fake.address().port}`, OPENWEBNINJA_API_KEY: 'own-key', DATABASE_URL: 'pglite:memory', JSEARCH_BASE: `http://127.0.0.1:${fake.address().port}`, JOBS_API_KEY: 'test-key', NO_LISTEN: '1', PAGES_PER_BUCKET: '2', MONTHLY_CAP: '24', KEEP_DAYS: '3650' });
let calls = 0;
const { default: app } = await import('../src/server.mjs');
const call = (path, init = {}) => app.request(path, { ...init, headers: { 'x-api-key': 'test-key', ...(init.headers ?? {}) } });
const assert = (cond, msg) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } console.log('ok ', msg); };

assert((await app.request('/jobs')).status === 401, 'rejects missing key');
const r = await (await call('/internal/refresh?country=us', { method: 'POST' })).json();
assert(r.requests === 16, `refresh used 16 requests for 8 US buckets (got ${r.requests})`);
const all = await (await call('/jobs?country=us&limit=5')).json();
assert(all.total > 50 && all.jobs.length === 5, `merged buckets: ${all.total} jobs`);
const remote = await (await call('/jobs?country=us&remote=yes')).json();
assert(remote.jobs.every((j) => j.remote), 'remote filter');
const tech = await (await call('/jobs?country=usa&category=tech&level=entry')).json();
assert(tech.category === 'tech' && tech.jobs.every((j) => !j.level || j.level === 'entry'), 'category + level + alias');
assert(tech.jobs[0].salary === '$50k–$70k/yr' && tech.jobs[0].type === 'Full-time', 'normalised salary/type');
const before = calls;
const search = await (await call('/jobs?country=us&q=zookeeper')).json();
assert(search.source === 'database' && search.total === 0 && calls === before, 'visitor search never calls JSearch');
const hit = await (await call('/jobs?country=us&q=healthcare')).json();
assert(hit.total > 0 && calls === before, `search answered from database (${hit.total} matches)`);
const r2 = await (await call('/internal/refresh?country=us', { method: 'POST' })).json();
const u = await (await call('/internal/usage')).json();
assert(u.requests <= 24 && r2.report.some((b) => /cap/.test(b.error ?? '')), `monthly cap enforced (${u.requests}/24 used)`);
const merged = await (await call('/jobs?country=us&category=tech&limit=50')).json();
assert(merged.total === 14, `buckets accumulate without duplicates (${merged.total})`);
const comp = await (await call('/companies?country=us&limit=3')).json();
assert(comp.companies.length === 1 && comp.companies[0].company === 'Acme' && comp.companies[0].jobs > 50 && comp.companies[0].titles.length === 3, `top companies (${comp.companies[0]?.company}: ${comp.companies[0]?.jobs} jobs)`);
const en = await (await call('/internal/enrich', { method: 'POST' })).json();
assert(en.enriched === 1 && en.report[0].logo && en.report[0].summary, `enrichment stored logo + writeup (${JSON.stringify(en.report[0])})`);
const prof = await (await call('/companies/acme')).json();
assert(prof.company.description.startsWith('Acme builds') && prof.company.hasLogo && prof.company.website === 'https://acme.example' && prof.jobs.length === 30 && prof.total > 50, `company profile (${prof.total} roles, industry ${prof.company.industry})`);
const logo = await call('/logos/acme');
assert(logo.status === 200 && logo.headers.get('content-type') === 'image/png', 'logo served from database');
const top = await (await call('/companies?country=us&limit=1')).json();
assert(top.companies[0].slug === 'acme' && top.companies[0].hasLogo && top.companies[0].summary, 'top companies include slug, logo flag, summary');
const again = await (await call('/internal/enrich', { method: 'POST' })).json();
assert(again.enriched === 0, 'enriched companies are not redone');
fake.close();
console.log('all passed');
