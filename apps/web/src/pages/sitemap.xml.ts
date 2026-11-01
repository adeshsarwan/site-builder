import type { APIRoute } from 'astro';
import { allArticles } from '@/lib/articles';
import { articleCanonical } from '@/lib/seo';
import { site, abs } from '@/lib/site';

export const GET: APIRoute = async () => {
  const arts = await allArticles();
  const urls: { loc: string; lastmod?: string }[] = [
    { loc: abs('/') },
    { loc: abs('/article') },
    ...site.categories
      .filter((c) => arts.some((a) => a.data.categorySlug === c.slug))
      .map((c) => ({ loc: abs(`/category/${c.slug}`) })),
    // Only self-canonical, indexable articles belong in the sitemap.
    ...arts
      .filter((a) => !a.data.seo?.noindex && articleCanonical(a) === abs(`/${a.id}`))
      .map((a) => ({ loc: abs(`/${a.id}`), lastmod: (a.data.updatedDate ?? a.data.pubDate)?.toISOString().slice(0, 10) })),
    ...(site.jobs.enabled ? [{ loc: abs('/jobs') }] : []),
    { loc: abs('/about') },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
