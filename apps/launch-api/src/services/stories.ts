// Reading and editing a site's stories (Markdown + YAML frontmatter in sites/<slug>/content/articles).
import { parse, stringify } from 'yaml';
import type { Env } from '../types';
import * as gh from './github';

export const articlesDir = (slug: string) => `sites/${slug}/content/articles`;

export interface Story { fm: Record<string, any>; body: string }

export function parseStory(md: string): Story {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  let fm: any = {};
  try { fm = parse(m[1]) ?? {}; } catch { fm = {}; }
  return { fm, body: m[2].replace(/^\n/, '') };
}

/** Same shape the generator writes: double-quoted strings, one key per line. */
export function serializeStory(s: Story): string {
  const fm = stringify(s.fm, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n${s.body.trim()}\n`;
}

/** Light listing record for a story. */
export function summary(slug: string, s: Story) {
  const f = s.fm;
  return {
    slug,
    title: f.title ?? '',
    description: f.description ?? '',
    category: f.categorySlug ?? f.category ?? '',
    pubDate: f.pubDate ? String(f.pubDate).slice(0, 10) : null,
    updatedDate: f.updatedDate ? String(f.updatedDate).slice(0, 10) : null,
    draft: Boolean(f.draft),
    origin: f.origin ?? 'original',
    readTime: f.readTime ?? null,
    wordCount: f.wordCount ?? s.body.split(/\s+/).filter(Boolean).length,
    heroImage: f.heroImage || null,
    hasImage: Boolean(f.heroImage),
    seoTitle: f.seo?.title ?? null,
  };
}

/** All stories of a site in one GitHub GraphQL call (falls back to one call per file). */
export async function loadStories(env: Env, slug: string): Promise<{ slug: string; story: Story; sha: string }[]> {
  const dir = articlesDir(slug);
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'site-builder-launch-api' },
      body: JSON.stringify({
        query: 'query($o:String!,$r:String!,$e:String!){repository(owner:$o,name:$r){object(expression:$e){... on Tree{entries{name oid object{... on Blob{text}}}}}}}',
        variables: { o: env.GITHUB_OWNER, r: env.GITHUB_REPO, e: `${env.GITHUB_BRANCH}:${dir}` },
      }),
    });
    const body: any = await res.json();
    const entries = body?.data?.repository?.object?.entries;
    if (res.ok && Array.isArray(entries)) {
      return entries
        .filter((e: any) => e.name.endsWith('.md') && typeof e.object?.text === 'string')
        .map((e: any) => ({ slug: e.name.replace(/\.md$/, ''), story: parseStory(e.object.text), sha: e.oid }));
    }
    if (body?.data?.repository && body.data.repository.object === null) return [];
  } catch { /* fall through */ }
  const files = (await gh.listTree(env, dir)).filter((f) => f.path.endsWith('.md'));
  const out = [];
  for (const f of files) out.push({ slug: f.path.split('/').pop()!.replace(/\.md$/, ''), story: parseStory(await gh.readBlob(env, f.sha)), sha: f.sha });
  return out;
}

export async function loadStory(env: Env, siteSlug: string, slug: string): Promise<Story | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const raw = await gh.readFile(env, `${articlesDir(siteSlug)}/${slug}.md`);
  return raw === null ? null : parseStory(raw);
}

/** Pixabay photo id from a credit URL (so a re-photo never picks the same picture). */
export const pixabayId = (url?: string) => url?.match(/-(\d+)\/?$/)?.[1] ?? null;
