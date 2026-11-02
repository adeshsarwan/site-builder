// JSON jobs for in-page views (funnel results). Uses the funnel cookie answers plus query overrides.
import type { APIRoute } from 'astro';
import { searchJobs, type JobQuery } from '@/lib/jobs';
import { site } from '@/lib/site';
import { funnelCookie, decodeAnswers } from '@/lib/funnels';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const sp = url.searchParams;
  const answers = site.funnels.reduce<Record<string, string>>((acc, f) => ({ ...acc, ...(decodeAnswers(cookies.get(funnelCookie(f.id))?.value) ?? {}) }), {});
  const pick = (k: string) => sp.get(k) ?? answers[k] ?? undefined;
  const query: JobQuery = {
    q: sp.get('q') ?? undefined,
    location: pick('location'),
    country: pick('country'),
    category: pick('category'),
    level: pick('level'),
    remote: pick('remote'),
    page: Math.max(1, Number(sp.get('page') ?? 1) || 1),
  };
  try {
    const r = await searchJobs(query);
    return Response.json(r, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch {
    return Response.json({ jobs: [], total: 0, error: 'unavailable' }, { status: 502 });
  }
};
