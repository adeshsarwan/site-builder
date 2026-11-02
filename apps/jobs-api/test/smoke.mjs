// Local smoke test: fake JSearch server + in-memory store.
import http from 'node:http';

const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const country = u.searchParams.get('country');
  const page = Number(u.searchParams.get('page'));
  const remote = u.searchParams.get('work_from_home') === 'true';
  const q = u.searchParams.get('query');
  const data = Array.from({ length: page === 1 ? 10 : 4 }, (_, i) => ({
    job_id: `${country}-${q}-${page}-${i}`, job_title: `${q.split(' ')[0]} role ${page}.${i}`, employer_name: 'Acme',
    job_city: 'Austin', job_state: 'TX', job_country: country.toUpperCase(), job_is_remote: remote || i % 3 === 0,
    job_min_salary: 50000, job_max_salary: 70000, job_salary_period: 'YEAR', job_salary_currency: 'USD',
    job_employment_type: 'FULLTIME', job_apply_link: 'https://example.com/apply',
    job_posted_at_datetime_utc: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), job_description: 'Great job '.repeat(40),
    job_required_experience: { no_experience_required: i % 2 === 0, required_experience_in_months: i % 2 ? 36 : null },
  }));
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'OK', data }));
});
await new Promise((r) => fake.listen(0, r));
Object.assign(process.env, { JSEARCH_BASE: `http://127.0.0.1:${fake.address().port}`, STORE: 'memory', JOBS_API_KEY: 'test-key', NO_LISTEN: '1', PAGES_PER_BUCKET: '2' });
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
const live = await (await call('/jobs?country=gb&q=zookeeper')).json();
assert(live.source === 'live' && live.total > 0, 'live fallback for unmatched query');
const again = await (await call('/jobs?country=gb&q=zookeeper')).json();
const u = await (await call('/internal/usage')).json();
assert(again.source === 'live' && u.live === 1, `live result cached (live requests today: ${u.live})`);
fake.close();
console.log('all passed');
