import type { APIRoute } from 'astro';
import { site } from '@/lib/site';

export const GET: APIRoute = () =>
  new Response((site.ads.adsTxt ?? []).join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
