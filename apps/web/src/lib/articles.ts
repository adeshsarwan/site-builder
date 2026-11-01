import { getCollection, type CollectionEntry } from 'astro:content';
import { site } from './site';

export type Article = CollectionEntry<'articles'>;

export async function allArticles(): Promise<Article[]> {
  const items = await getCollection('articles', ({ data }) => !data.draft);
  return items.sort((a, b) => (b.data.pubDate?.getTime() ?? 0) - (a.data.pubDate?.getTime() ?? 0) || a.data.title.localeCompare(b.data.title));
}

export async function articlesInCategory(slug: string) {
  return (await allArticles()).filter((a) => a.data.categorySlug === slug);
}

/** Related = explicit `related` slugs first, then same-category fill. */
export async function relatedFor(article: Article, limit = 4) {
  const all = await allArticles();
  const byId = new Map(all.map((a) => [a.id, a]));
  const picked: Article[] = [];
  for (const s of article.data.related) {
    const a = byId.get(s);
    if (a && a.id !== article.id && !picked.includes(a)) picked.push(a);
  }
  for (const a of all) {
    if (picked.length >= limit) break;
    if (a.id !== article.id && a.data.categorySlug === article.data.categorySlug && !picked.includes(a)) picked.push(a);
  }
  return picked.slice(0, limit);
}

export const categoryName = (slug: string) => site.categories.find((c) => c.slug === slug)?.name ?? slug;
export const fmtDate = (d?: Date | null) =>
  d ? d.toLocaleDateString(site.locale || 'en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }) : '';
