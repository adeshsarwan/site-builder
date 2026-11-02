import type { Env } from '../types';
import type { HeroImage } from './content';
import { createBlob } from './github';

// Free stock photos for article heroes.
//  - Pixabay (default): the API forbids permanent hotlinking, so the image is downloaded and committed
//    to the site's repo folder (sites/<slug>/public/images/), then served from the site's own domain.
//  - Unsplash: the API guidelines require hotlinking images.unsplash.com URLs, crediting the photographer
//    and Unsplash with UTM links, and calling download_location when an image is used.
// Requests are made one article at a time (no bulk downloads), and results are cached per query in the workflow.

export interface PickedImage { hero: HeroImage; blob?: { path: string; sha: string } }

const UTM = 'utm_source=site_builder&utm_medium=referral';

export async function pickImage(env: Env, query: string, slug: string, siteSlug: string, used: Set<string>): Promise<PickedImage | null> {
  const provider = (env.IMAGE_PROVIDER ?? 'pixabay').toLowerCase();
  if (provider === 'unsplash' && env.UNSPLASH_ACCESS_KEY) return unsplash(env, query, used);
  if (provider === 'pixabay' && env.PIXABAY_API_KEY) return pixabay(env, query, slug, siteSlug, used);
  return null;
}

async function pixabay(env: Env, query: string, slug: string, siteSlug: string, used: Set<string>): Promise<PickedImage | null> {
  const u = new URL('https://pixabay.com/api/');
  u.search = new URLSearchParams({ key: env.PIXABAY_API_KEY!, q: query.slice(0, 100), image_type: 'photo', orientation: 'horizontal', safesearch: 'true', min_width: '1200', per_page: '20' }).toString();
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Pixabay ${res.status}`);
  const hits: any[] = ((await res.json()) as any).hits ?? [];
  const hit = hits.find((h) => !used.has(`px-${h.id}`));
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
  const p = results.find((r) => !used.has(`us-${r.id}`));
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
