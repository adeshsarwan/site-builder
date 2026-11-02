// Company enrichment after each pull: stores the employer logo (from the job feed) in Postgres and
// writes a short, original company summary with Claude from our own job data.
import { companiesToEnrich, saveCompany } from './store.mjs';

const MAX_LOGO = 300_000;

async function fetchLogo(url) {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'jobs-api/1.0 (+logo cache)' } });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= MAX_LOGO ? { bytes: buf, type } : null;
  } catch { return null; }
}

async function writeSummary(c) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const facts = {
    name: c.name, website: c.website ?? null, openRoles: c.jobs, remoteRoles: c.remote_jobs,
    countries: c.countries, sampleTitles: c.titles, sampleLocations: c.locations, categories: c.categories,
  };
  const res = await fetch(`${process.env.ANTHROPIC_BASE || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: process.env.ENRICH_MODEL || 'claude-haiku-5-5',
      max_tokens: 600,
      system: 'You write short, neutral employer summaries for a job-search site. Write original text in your own words. Use only (a) the hiring data provided and (b) widely known, stable facts about the company (what it does, its industry) that you are confident are accurate. If you are not confident who the company is, describe only its hiring activity from the data. Never invent pay, benefits, culture, ratings, awards, employee counts, or quotes. No superlatives or marketing language. Reply with JSON only.',
      messages: [{ role: 'user', content: `Hiring data:\n${JSON.stringify(facts)}\n\nReturn {"industry": "2–4 word industry label or null", "summary": "2 short paragraphs, 70–120 words total: what the company does (only if confident), then what it is currently hiring for, where, and how much is remote"}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const text = ((await res.json()).content ?? []).map((x) => x.text ?? '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : text);
  return { industry: j.industry ? String(j.industry).slice(0, 60) : null, summary: String(j.summary ?? '').trim().slice(0, 1200) || null };
}

export async function enrichCompanies(limit = Number(process.env.ENRICH_PER_RUN ?? 15)) {
  const list = await companiesToEnrich(limit);
  const report = [];
  for (const c of list) {
    const logo = await fetchLogo(c.logo_url);
    let text = null, error;
    try { text = await writeSummary(c); } catch (e) { error = e.message; }
    await saveCompany({
      slug: c.slug, name: c.name, website: c.website, industry: text?.industry, description: text?.summary,
      logo: logo?.bytes, logoType: logo?.type, logoSource: logo ? c.logo_url : null,
    });
    report.push({ company: c.name, logo: Boolean(logo), summary: Boolean(text?.summary), ...(error ? { error } : {}) });
  }
  return report;
}
