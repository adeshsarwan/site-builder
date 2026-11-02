import type { Env, LaunchInput } from '../types';

// Every launched site gets its own original articles written by the Claude API.
// The starting library is used only as a TOPIC LIST (title + one-line summary). Source article
// text is never sent, so each site's articles are written fresh — new structure, wording and
// examples — rather than paraphrased copies, and nothing references another site.

export interface ArticlePlan { title: string; slug: string; categorySlug: string; angle: string }
export interface Topic { title: string; summary: string; categorySlug: string }

export const CATEGORIES = ['job-search-strategy', 'resume-cover-letters', 'interview-prep', 'salary-negotiation', 'workplace-success', 'career-change-growth'];

async function claude(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${body.error?.message ?? ''}`);
  return body.content.map((c: any) => c.text ?? '').join('');
}

const json = <T>(text: string): T => {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  return JSON.parse(m ? m[1] : text);
};

export const slugify = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70).replace(/-$/, '');

/** Parse only the topic fields from a library article's frontmatter. */
export function topicFromMarkdown(md: string): Topic | null {
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm) return null;
  const get = (k: string) => { const v = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''; try { return JSON.parse(v); } catch { return v; } };
  const title = String(get('title'));
  return title ? { title, summary: String(get('description')), categorySlug: String(get('categorySlug')) } : null;
}

/**
 * Turns topics (+ optional extra count) into a plan of NEW articles for this site:
 * a fresh title and angle for its niche and audience, so no two sites share headlines.
 */
export async function planArticles(env: Env, input: LaunchInput, topics: Topic[], extra: number, existingTitles: string[] = []): Promise<ArticlePlan[]> {
  const text = await claude(
    env,
    'You plan editorial calendars for career-advice websites. Every title you write is new and specific to the site\'s audience. Reply with JSON only.',
    `Site: ${input.name} (${input.domain}). Audience/niche: ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}.
${topics.length ? `For each of these ${topics.length} subject areas, propose ONE new article for this audience. Use a different title and angle — never reuse the wording below:\n${topics.map((t, i) => `${i + 1}. [${t.categorySlug}] ${t.title} — ${t.summary}`).join('\n')}\n` : ''}
${extra > 0 ? `Then add ${extra} more article ideas on other search-driven topics not covered above.\n` : ''}${existingTitles.length ? `The site already has these articles — do not duplicate or closely overlap them:\n${existingTitles.slice(0, 120).map((t) => `- ${t}`).join('\n')}\n` : ''}
Category slugs: ${CATEGORIES.join(', ')}.
Return a JSON array of {"title","categorySlug","angle"} where angle is one sentence on the reader's specific problem. ${topics.length + extra} items.`,
    Math.min(16000, 400 + (topics.length + extra) * 120),
  );
  const seen = new Set<string>();
  return json<any[]>(text)
    .slice(0, topics.length + extra)
    .map((p) => ({ title: String(p.title), slug: slugify(p.title), categorySlug: CATEGORIES.includes(p.categorySlug) ? p.categorySlug : CATEGORIES[0], angle: String(p.angle ?? '') }))
    .filter((p) => p.slug && !seen.has(p.slug) && seen.add(p.slug));
}

export interface WrittenArticle {
  plan: ArticlePlan;
  description: string;
  metaDescription: string;
  seoTitle: string;
  readTime: number;
  body: string;
  faq: { q: string; a: string }[];
  sources: string[];
  imageQuery: string;
  keywords: string[];
}

export async function writeArticle(env: Env, input: LaunchInput, plan: ArticlePlan): Promise<WrittenArticle> {
  const text = await claude(
    env,
    `You are a careful career-advice editor writing for ${input.name} (${input.domain}). Write practical, specific, original guidance in your own words.
Rules: never mention or link to other career-advice websites. No invented statistics, studies, quotes or people. Only cite figures from official sources (e.g. U.S. Bureau of Labor Statistics, CareerOneStop, government sites) when you are confident they are accurate, and name the source; otherwise give advice without numbers.
Markdown with ## and ### headings, short paragraphs, lists, and one table where it genuinely helps. 1,200–1,800 words. Reply with JSON only.`,
    `Write "${plan.title}" for ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}. Reader problem: ${plan.angle}
Return JSON:
{"description":"1–2 sentence dek","seoTitle":"≤60 chars, includes the main keyword","metaDescription":"140–155 chars, specific benefit","keywords":["primary keyword","3–5 secondary"],"readTime":number,"body":"markdown body, no H1","faq":[{"q","a"}] (3 items, answers 40–80 words),"sources":["official source URLs actually referenced, or empty"],"imageQuery":"2–4 word stock-photo search for a relevant, people-at-work style hero photo"}`,
    8000,
  );
  const a = json<any>(text);
  return {
    plan,
    description: String(a.description ?? ''),
    metaDescription: String(a.metaDescription ?? a.description ?? '').slice(0, 160),
    seoTitle: String(a.seoTitle ?? plan.title).slice(0, 70),
    readTime: Number(a.readTime) || 0,
    body: String(a.body ?? '').trim(),
    faq: Array.isArray(a.faq) ? a.faq.filter((f: any) => f?.q && f?.a).slice(0, 5) : [],
    sources: Array.isArray(a.sources) ? a.sources.filter((s: any) => /^https:\/\//.test(s)).slice(0, 8) : [],
    imageQuery: String(a.imageQuery ?? plan.title).slice(0, 80),
    keywords: Array.isArray(a.keywords) ? a.keywords.map(String).slice(0, 6) : [],
  };
}

export interface HeroImage { src: string; alt: string; credit?: { name: string; url: string; source: string; sourceUrl: string } }

export function toMarkdown(input: LaunchInput, a: WrittenArticle, dateIso: string, img: HeroImage | null): { path: string; content: string } {
  const q = (v: unknown) => JSON.stringify(v ?? '');
  const words = a.body.split(/\s+/).length;
  const lines = [
    '---',
    `title: ${q(a.plan.title)}`,
    `description: ${q(a.description)}`,
    `slug: ${q(a.plan.slug)}`,
    `category: ${q(a.plan.categorySlug)}`,
    `categorySlug: ${q(a.plan.categorySlug)}`,
    `author: ${q(`${input.name} Editorial Team`)}`,
    `authorBio: ${q(`Guides from the ${input.name} editorial team, written to help job seekers take the next concrete step.`)}`,
    `pubDate: ${dateIso}`,
    `readTime: ${a.readTime || Math.max(3, Math.round(words / 230))}`,
    `wordCount: ${words}`,
    `origin: "generated"`,
    `heroImage: ${q(img?.src ?? '')}`,
    `heroAlt: ${q(img?.alt ?? '')}`,
    ...(img?.credit ? ['heroCredit:', `  name: ${q(img.credit.name)}`, `  url: ${q(img.credit.url)}`, `  source: ${q(img.credit.source)}`, `  sourceUrl: ${q(img.credit.sourceUrl)}`] : []),
    'seo:',
    `  title: ${q(a.seoTitle)}`,
    `  metaDescription: ${q(a.metaDescription)}`,
    `  keywords: ${q(a.keywords)}`,
    a.faq.length ? 'faq:' : 'faq: []',
    ...a.faq.map((f) => `  - q: ${q(f.q)}\n    a: ${q(f.a)}`),
    a.sources.length ? 'sources:' : 'sources: []',
    ...a.sources.map((s) => `  - ${q(s)}`),
    '---',
    '',
  ];
  return { path: `${a.plan.slug}.md`, content: lines.join('\n') + a.body + '\n' };
}
