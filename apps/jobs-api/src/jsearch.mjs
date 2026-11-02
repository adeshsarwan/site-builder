// JSearch via OpenWeb Ninja (api.openwebninja.com, x-api-key) + normalisation to the shape the sites expect.
const BASE = process.env.JSEARCH_BASE || 'https://api.openwebninja.com/jsearch';

const TIMEOUT = Number(process.env.JSEARCH_TIMEOUT_MS ?? 60_000);

export async function jsearch({ query, country, page = 1, remote = false, datePosted = 'week' }, attempt = 1) {
  const params = new URLSearchParams({ query, page: String(page), num_pages: '1', country, date_posted: datePosted });
  if (remote) params.set('work_from_home', 'true');
  let res;
  try {
    res = await fetch(`${BASE}/search?${params}`, {
      headers: { 'x-api-key': process.env.OPENWEBNINJA_API_KEY ?? '' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    if (attempt < 2) return jsearch({ query, country, page, remote, datePosted }, attempt + 1); // one retry on timeout/network error
    throw new Error(`JSearch request failed after ${attempt} attempts: ${e.message}`);
  }
  if (res.status >= 500 && attempt < 2) return jsearch({ query, country, page, remote, datePosted }, attempt + 1);
  if (res.status === 429) throw Object.assign(new Error('JSearch rate limit / quota reached'), { status: 429 });
  if (!res.ok) throw new Error(`JSearch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.data ?? []).map((r) => normalize(r, country));
}

function level(r) {
  const x = r.job_required_experience ?? {};
  if (x.no_experience_required) return 'entry';
  const m = Number(x.required_experience_in_months);
  if (!m) return null;
  return m <= 24 ? 'entry' : m <= 60 ? 'mid' : 'senior';
}

function salary(r) {
  const min = r.job_min_salary, max = r.job_max_salary;
  if (!min && !max) return undefined;
  const cur = r.job_salary_currency ?? '';
  const sym = { USD: '$', CAD: 'C$', AUD: 'A$', GBP: '£' }[cur] ?? (cur ? `${cur} ` : '');
  const fmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
  const per = { YEAR: '/yr', HOUR: '/hr', MONTH: '/mo' }[r.job_salary_period] ?? '';
  return min && max ? `${sym}${fmt(min)}–${sym}${fmt(max)}${per}` : `${sym}${fmt(min || max)}${per}`;
}

export function normalize(r, country) {
  const place = [r.job_city, r.job_state].filter(Boolean).join(', ');
  return {
    id: String(r.job_id),
    title: r.job_title ?? '',
    company: r.employer_name ?? '',
    logo: r.employer_logo ?? undefined,
    location: r.job_is_remote ? (place ? `Remote · ${place}` : 'Remote') : place || (r.job_country ?? '').toUpperCase(),
    country: (r.job_country ?? country ?? '').toLowerCase(),
    remote: Boolean(r.job_is_remote),
    salary: salary(r),
    type: r.job_employment_type ? r.job_employment_type.replace('FULLTIME', 'Full-time').replace('PARTTIME', 'Part-time').replace('CONTRACTOR', 'Contract').replace('INTERN', 'Internship') : undefined,
    level: level(r),
    postedAt: r.job_posted_at_datetime_utc ?? (r.job_posted_at_timestamp ? new Date(r.job_posted_at_timestamp * 1000).toISOString() : undefined),
    url: r.job_apply_link ?? r.job_google_link ?? '#',
    publisher: r.job_publisher ?? undefined,
    snippet: (r.job_description ?? '').replace(/\s+/g, ' ').trim().slice(0, 220) || undefined,
  };
}
