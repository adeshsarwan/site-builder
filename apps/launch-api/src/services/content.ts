import type { Env, LaunchInput } from '../types';

// Every launched site gets its own original articles written by the Claude API.
// The starting library is used only as a TOPIC LIST (title + one-line summary). Source article
// text is never sent, so each site's articles are written fresh — new structure, wording and
// examples — rather than paraphrased copies, and nothing references another site.

export interface ArticlePlan { title: string; slug: string; categorySlug: string; angle: string }
export interface Topic { title: string; summary: string; categorySlug: string }

export const CATEGORIES = ['job-search-strategy', 'resume-cover-letters', 'interview-prep', 'salary-negotiation', 'workplace-success', 'career-change-growth'];

async function claude(env: Env, system: string, user: string, maxTokens: number, purpose = 'request'): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status} (${purpose}): ${body.error?.message ?? ''}`);
  const text = (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('');
  if (body.stop_reason === 'max_tokens') throw new Error(`Claude reply cut off at ${maxTokens} tokens (${purpose}, model ${body.model})`);
  if (!text.trim()) throw new Error(`Claude returned no text (${purpose}, stop_reason ${body.stop_reason})`);
  return text;
}

/** Structured output via a forced tool call: the API returns schema-shaped, already-parsed JSON. */
async function claudeJson<T>(env: Env, system: string, user: string, schema: Record<string, unknown>, maxTokens: number, purpose: string): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system,
      tools: [{ name: 'submit', description: 'Submit the result.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'submit' },
      messages: [{ role: 'user', content: user }],
    }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Claude API ${res.status} (${purpose}): ${body.error?.message ?? ''}`);
  if (body.stop_reason === 'max_tokens') throw new Error(`Claude reply cut off at ${maxTokens} tokens (${purpose})`);
  const call = (body.content ?? []).find((c: any) => c.type === 'tool_use');
  if (!call?.input) throw new Error(`Claude returned no structured result (${purpose}, stop_reason ${body.stop_reason})`);
  return call.input as T;
}

/** Extracts the first complete JSON value from a model reply (string-aware bracket matching). */
export function extractJson<T>(text: string): T {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const start = t.search(/[\[{]/);
  if (start < 0) throw new Error('No JSON in model reply');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('Incomplete JSON in model reply (output may have been cut off)');
}
const json = extractJson;

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
  // Plan in groups of 10 so each reply stays well inside the output limit; each group sees what is already planned.
  const CHUNK = 10;
  const groups: { topics: Topic[]; extra: number }[] = [];
  for (let i = 0; i < topics.length; i += CHUNK) groups.push({ topics: topics.slice(i, i + CHUNK), extra: 0 });
  for (let e = extra; e > 0; e -= CHUNK) groups.push({ topics: [], extra: Math.min(CHUNK, e) });
  const plans: ArticlePlan[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const avoid = [...existingTitles, ...plans.map((p) => p.title)];
    const n = g.topics.length + g.extra;
    const out = await claudeJson<{ items: any[] }>(
      env,
      'You plan editorial calendars for career-advice websites. Every title you write is new and specific to the site\'s audience.',
      `Site: ${input.name} (${input.domain}). Audience/niche: ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}.
${g.topics.length ? `For each of these ${g.topics.length} subject areas, propose ONE new article for this audience. Use a different title and angle — never reuse the wording below:\n${g.topics.map((t, i) => `${i + 1}. [${t.categorySlug}] ${t.title} — ${t.summary}`).join('\n')}\n` : ''}${g.extra ? `Propose ${g.extra} article ideas on other search-driven topics for this audience.\n` : ''}${avoid.length ? `Do not duplicate or closely overlap these existing titles:\n${avoid.slice(-150).map((t) => `- ${t}`).join('\n')}\n` : ''}
Category slugs: ${CATEGORIES.join(', ')}.
Submit exactly ${n} items. angle = one sentence on the reader's specific problem.`,
      { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['title', 'categorySlug', 'angle'],
        properties: { title: { type: 'string' }, categorySlug: { type: 'string', enum: CATEGORIES }, angle: { type: 'string' } } } } } },
      1500 + n * 400,
      `plan ${n} articles`,
    );
    for (const p of (out.items ?? []).slice(0, n)) {
      const plan = { title: String(p.title), slug: slugify(p.title), categorySlug: CATEGORIES.includes(p.categorySlug) ? p.categorySlug : CATEGORIES[0], angle: String(p.angle ?? '') };
      if (plan.slug && !seen.has(plan.slug)) { seen.add(plan.slug); plans.push(plan); }
    }
  }
  return plans;
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
  const a = await claudeJson<any>(
    env,
    `You are a careful career-advice editor writing for ${input.name} (${input.domain}). Write practical, specific, original guidance in your own words.
Rules: never mention or link to other career-advice websites. No invented statistics, studies, quotes or people. Only cite figures from official sources (e.g. U.S. Bureau of Labor Statistics, CareerOneStop, government sites) when you are confident they are accurate, and name the source; otherwise give advice without numbers.
The body is Markdown with ## and ### headings, short paragraphs, lists, and one table where it genuinely helps. 1,200–1,800 words.`,
    `Write "${plan.title}" for ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}. Reader problem: ${plan.angle}
Submit: description (1–2 sentence dek), seoTitle (≤60 chars, includes the main keyword), metaDescription (140–155 chars, specific benefit), keywords (primary + 3–5 secondary), readTime (minutes), body (Markdown, no H1), faq (3 items, answers 40–80 words), sources (official URLs actually referenced, may be empty), imageQuery (2–4 word stock-photo search for a relevant people-at-work hero photo).`,
    { type: 'object', required: ['description', 'seoTitle', 'metaDescription', 'keywords', 'readTime', 'body', 'faq', 'sources', 'imageQuery'],
      properties: {
        description: { type: 'string' }, seoTitle: { type: 'string' }, metaDescription: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } }, readTime: { type: 'number' }, body: { type: 'string' },
        faq: { type: 'array', items: { type: 'object', required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
        sources: { type: 'array', items: { type: 'string' } }, imageQuery: { type: 'string' },
      } },
    16000,
    `write "${plan.title.slice(0, 50)}"`,
  );
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
