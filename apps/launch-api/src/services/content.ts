import type { Env, LaunchInput } from '../types';

// Original articles written with the Claude API. Each article is one workflow step, so a failure
// retries only that article. Bylines use an honest "Editorial Team" author rather than invented people.

export interface ArticlePlan { title: string; slug: string; categorySlug: string; angle: string }

const CATEGORIES = ['job-search-strategy', 'resume-cover-letters', 'interview-prep', 'salary-negotiation', 'workplace-success', 'career-change-growth'];

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

const slugify = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

export async function planArticles(env: Env, input: LaunchInput, count: number, avoidTitles: string[]): Promise<ArticlePlan[]> {
  const text = await claude(
    env,
    'You plan editorial calendars for career-advice websites. Reply with JSON only.',
    `Site: ${input.name} (${input.domain}). Audience/niche: ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}.
Plan ${count} distinct, search-driven article ideas spread across these category slugs: ${CATEGORIES.join(', ')}.
Avoid overlapping with these existing titles:\n${avoidTitles.slice(0, 80).map((t) => `- ${t}`).join('\n')}
Return a JSON array of {"title","categorySlug","angle"} where angle is one sentence on the specific reader problem.`,
    3000,
  );
  return json<any[]>(text).slice(0, count).map((p) => ({ title: p.title, slug: slugify(p.title), categorySlug: CATEGORIES.includes(p.categorySlug) ? p.categorySlug : CATEGORIES[0], angle: p.angle }));
}

export async function writeArticle(env: Env, input: LaunchInput, plan: ArticlePlan, dateIso: string): Promise<{ path: string; content: string }> {
  const text = await claude(
    env,
    `You are a careful career-advice editor writing for ${input.name}. Write practical, specific, original guidance.
Rules: no invented statistics, studies, quotes or people. Only cite figures from well-known official sources (e.g. U.S. Bureau of Labor Statistics, CareerOneStop) when you are confident, naming the source; otherwise give advice without numbers.
Use Markdown with ## and ### headings, short paragraphs, lists and one comparison table where useful. 1,200–1,800 words. Reply with JSON only.`,
    `Write the article "${plan.title}" for ${input.niche ?? 'job seekers'} in ${input.country ?? 'US'}. Reader problem: ${plan.angle}
Return JSON: {"description": "1–2 sentence dek", "metaDescription": "≤155 chars", "seoTitle": "≤60 chars", "readTime": number, "body": "markdown body without the H1", "faq": [{"q","a"}] (3 items)}`,
    8000,
  );
  const a = json<any>(text);
  const words = String(a.body).split(/\s+/).length;
  const q = (v: unknown) => JSON.stringify(v ?? '');
  const fm = [
    '---',
    `title: ${q(plan.title)}`,
    `description: ${q(a.description)}`,
    `slug: ${q(plan.slug)}`,
    `category: ${q(plan.categorySlug)}`,
    `categorySlug: ${q(plan.categorySlug)}`,
    `author: ${q(`${input.name} Editorial Team`)}`,
    `authorBio: ${q(`Guides from the ${input.name} editorial team, written to help job seekers take the next concrete step.`)}`,
    `pubDate: ${dateIso}`,
    `readTime: ${Number(a.readTime) || Math.max(3, Math.round(words / 230))}`,
    `wordCount: ${words}`,
    `origin: "generated"`,
    'seo:',
    `  title: ${q(a.seoTitle || plan.title)}`,
    `  metaDescription: ${q(a.metaDescription || a.description)}`,
    'faq:',
    ...(Array.isArray(a.faq) && a.faq.length ? a.faq.map((f: any) => `  - q: ${q(f.q)}\n    a: ${q(f.a)}`) : ['  []']),
    '---',
    '',
  ].join('\n').replace(/faq:\n  \[\]/, 'faq: []');
  return { path: `${plan.slug}.md`, content: fm + String(a.body).trim() + '\n' };
}
