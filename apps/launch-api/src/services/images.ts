import type { Env } from '../types';
import type { HeroImage } from './content';
import { createBlob } from './github';
import { bestHit, imageQueries as sharedQueries, photoScore } from '../../../../shared/photo-relevance.mjs';

// Free stock photos for article heroes.
//  - Pixabay (default): the API forbids permanent hotlinking, so the image is downloaded and committed
//    to the site's repo folder (sites/<slug>/public/images/), then served from the site's own domain.
//  - Unsplash: the API guidelines require hotlinking images.unsplash.com URLs, crediting the photographer
//    and Unsplash with UTM links, and calling download_location when an image is used.
// Requests are made one article at a time (no bulk downloads), and results are cached per query in the workflow.

export interface PickedImage { hero: HeroImage; blob?: { path: string; sha: string } }

const UTM = 'utm_source=site_builder&utm_medium=referral';

export { photoScore, looksOffTopic, MIN_PHOTO_SCORE } from '../../../../shared/photo-relevance.mjs';

/** Search phrases: the story's own photo query → its category → generic work scenes (never raw title words). */
export function imageQueries(primary: string | undefined, _title: string, categorySlug: string): string[] {
  return sharedQueries(primary, categorySlug);
}

/** Tries each phrase until one returns an unused photo. */
export async function pickImageWithFallback(env: Env, queries: string[], slug: string, siteSlug: string, used: Set<string>, errors?: string[]): Promise<PickedImage | null> {
  // Each phrase is tried inside Pixabay's "business" category first, then across all photos.
  const provider = (env.IMAGE_PROVIDER ?? 'pixabay').toLowerCase();
  const tries = provider === 'pixabay' ? [...queries.map((q) => `${BUSINESS}${q}`), ...queries] : queries;
  for (const q of tries) {
    try {
      const r = await pickImage(env, q, slug, siteSlug, used);
      if (r) return r;
    } catch (e: any) {
      errors?.push(`${slug} [${q}]: ${e.message}`);
      if (/subrequest/i.test(e.message)) break; // request budget spent; stop trying
    }
  }
  return null;
}

const BUSINESS = 'category:business ';

export async function pickImage(env: Env, query: string, slug: string, siteSlug: string, used: Set<string>): Promise<PickedImage | null> {
  const provider = (env.IMAGE_PROVIDER ?? 'pixabay').toLowerCase();
  if (provider === 'unsplash' && env.UNSPLASH_ACCESS_KEY) return unsplash(env, query, used);
  if (provider === 'pixabay' && env.PIXABAY_API_KEY) return pixabay(env, query, slug, siteSlug, used);
  return null;
}

async function pixabay(env: Env, query: string, slug: string, siteSlug: string, used: Set<string>): Promise<PickedImage | null> {
  const business = query.startsWith(BUSINESS);
  query = query.replace(BUSINESS, '');
  const u = new URL('https://pixabay.com/api/');
  u.search = new URLSearchParams({ key: env.PIXABAY_API_KEY!, q: query.slice(0, 100), image_type: 'photo', orientation: 'horizontal', safesearch: 'true', min_width: '1200', per_page: '30', ...(business ? { category: 'business' } : {}) }).toString();
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Pixabay ${res.status}`);
  const hits: any[] = ((await res.json()) as any).hits ?? [];
  const hit = bestHit(hits, query, (h: any) => used.has(`px-${h.id}`));
  if (!hit) return null;
  used.add(`px-${hit.id}`);
  const img = await fetch(hit.largeImageURL);
  if (!img.ok) throw new Error(`Pixabay image ${img.status}`);
  const bytes = new Uint8Array(await img.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const file = `${slug}.jpg`;
  const sha = await createBlob(env, btoa(bin));
  const alt = String(hit.tags ?? query).split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 4).join(', ');
  return {
    hero: { src: `/images/${file}`, alt: alt || query, credit: { name: hit.user, url: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`, source: 'Pixabay', sourceUrl: hit.pageURL } },
    blob: { path: `sites/${siteSlug}/public/images/${file}`, sha },
  };
}

async function unsplash(env: Env, query: string, used: Set<string>): Promise<PickedImage | null> {
  const headers = { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' };
  const res = await fetch(`https://api.unsplash.com/search/photos?${new URLSearchParams({ query, orientation: 'landscape', per_page: '20', content_filter: 'high' })}`, { headers });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const results: any[] = ((await res.json()) as any).results ?? [];
  const p = results.find((r) => !used.has(`us-${r.id}`) && photoScore(`${r.alt_description ?? ''} ${(r.tags ?? []).map((t: any) => t.title).join(' ')}`, query) >= 0);
  if (!p) return null;
  used.add(`us-${p.id}`);
  await fetch(p.links.download_location, { headers }).catch(() => {}); // required "download" tracking
  return {
    hero: {
      src: `${p.urls.raw}&w=1600&q=80&fm=jpg&fit=crop&ar=16:9`,
      alt: p.alt_description ?? query,
      credit: { name: p.user.name, url: `${p.user.links.html}?${UTM}`, source: 'Unsplash', sourceUrl: `https://unsplash.com/?${UTM}` },
    },
  };
}

