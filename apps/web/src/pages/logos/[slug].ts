// Employer logos served from this site's own domain (cached at the edge), sourced from the jobs API.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const slug = String(params.slug ?? '').replace(/\.(png|jpg|jpeg|webp|gif|svg)$/i, '').replace(/[^a-z0-9-]/g, '');
  const base = (env as any).JOBS_API_BASE as string | undefined;
  if (!slug || !base) return new Response(null, { status: 404 });
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(new URL(`/logos/${slug}`, request.url).href);
  const hit = await cache?.match(key);
  if (hit) return hit;
  const res = await fetch(`${base.replace(/\/$/, '')}/logos/${slug}`, { headers: { Authorization: `Bearer ${(env as any).JOBS_API_KEY ?? ''}` } });
  if (!res.ok) return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } });
  const out = new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  await cache?.put(key, out.clone());
  return out;
};
