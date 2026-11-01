// Jobs API adapter. All sites share one jobs API (on Google Cloud); each site passes its own filters.
// Secrets JOBS_API_BASE and JOBS_API_KEY live on the Worker, never in the browser.
//
// TODO(adesh): replace `toQuery` and `mapJob` with the real request/response shape of your API.
import { env } from 'cloudflare:workers';
import { site } from './site';

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  remote?: boolean;
  salary?: string;
  type?: string;
  postedAt?: string;
  url: string;
  snippet?: string;
}

export interface JobQuery {
  q?: string;
  location?: string;
  category?: string;
  remote?: string;
  level?: string;
  page?: number;
  [k: string]: string | number | undefined;
}

export interface JobResult { jobs: Job[]; total: number; page: number; pageSize: number; source: 'api' | 'demo' }

const CACHE_TTL = 300; // seconds

function toQuery(q: JobQuery, pageSize: number) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...site.jobs.defaultQuery, ...q })) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  p.set('limit', String(pageSize));
  p.set('offset', String(((q.page ?? 1) - 1) * pageSize));
  return p;
}

function mapJob(r: any): Job {
  return {
    id: String(r.id ?? r.job_id ?? r.uuid),
    title: r.title ?? r.job_title ?? '',
    company: r.company?.name ?? r.company ?? r.employer ?? '',
    location: r.location?.name ?? r.location ?? r.city ?? '',
    remote: Boolean(r.remote ?? r.is_remote),
    salary: r.salary ?? r.salary_text ?? undefined,
    type: r.type ?? r.employment_type ?? undefined,
    postedAt: r.posted_at ?? r.postedAt ?? r.created_at ?? undefined,
    url: r.apply_url ?? r.url ?? r.link ?? '#',
    snippet: r.snippet ?? r.summary ?? undefined,
  };
}

export async function searchJobs(q: JobQuery): Promise<JobResult> {
  const pageSize = site.jobs.pageSize || 20;
  const page = q.page ?? 1;
  const base = (env as any).JOBS_API_BASE as string | undefined;
  if (!base) return demoJobs(q, pageSize, page);

  const url = `${base.replace(/\/$/, '')}/jobs?${toQuery(q, pageSize)}`;
  const cacheKey = new Request(`https://jobs-cache.internal/${site.slug}?${toQuery(q, pageSize)}`);
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const hit = await cache?.match(cacheKey);
  if (hit) return hit.json();

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${(env as any).JOBS_API_KEY ?? ''}`, Accept: 'application/json', 'X-Site': site.slug },
  });
  if (!res.ok) throw new Error(`Jobs API ${res.status}`);
  const body: any = await res.json();
  const list = body.jobs ?? body.results ?? body.data ?? [];
  const result: JobResult = { jobs: list.map(mapJob), total: Number(body.total ?? body.count ?? list.length), page, pageSize, source: 'api' };
  await cache?.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'Cache-Control': `max-age=${CACHE_TTL}`, 'Content-Type': 'application/json' } }));
  return result;
}

// Demo data so every site works before the API is connected.
function demoJobs(q: JobQuery, pageSize: number, page: number): JobResult {
  const roles = ['Customer Success Associate', 'Junior Data Analyst', 'Registered Nurse', 'Sales Development Rep', 'IT Support Specialist', 'Marketing Coordinator', 'Project Coordinator', 'Accounts Payable Clerk', 'UX Designer', 'Warehouse Supervisor', 'Software Engineer I', 'HR Generalist'];
  const companies = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wide World', 'Adventure Works'];
  const cities = ['Austin, TX', 'Denver, CO', 'Remote', 'Chicago, IL', 'Atlanta, GA', 'Phoenix, AZ'];
  let jobs = roles.map((t, i) => ({
    id: `demo-${i + 1}`,
    title: t,
    company: companies[i % companies.length],
    location: cities[i % cities.length],
    remote: cities[i % cities.length] === 'Remote',
    salary: `$${45 + i * 5}k–$${60 + i * 6}k`,
    type: i % 4 === 0 ? 'Part-time' : 'Full-time',
    postedAt: new Date(Date.UTC(2026, 9, 28 - i)).toISOString(),
    url: '#',
    snippet: 'Demo listing shown until JOBS_API_BASE is configured for this site.',
  }));
  if (q.q) jobs = jobs.filter((j) => j.title.toLowerCase().includes(String(q.q).toLowerCase()));
  if (q.remote === 'yes') jobs = jobs.filter((j) => j.remote);
  return { jobs: jobs.slice((page - 1) * pageSize, page * pageSize), total: jobs.length, page, pageSize, source: 'demo' };
}
