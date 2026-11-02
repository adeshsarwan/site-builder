// Funnel endpoints for the frontend. Mounted under /api/v1 (bearer auth from the parent router).
//
// A funnel = a few questions + an opt-in rewarded video. Two ways to use one:
//   pages: on-page gate — on these URLs the questions show the moment the visitor lands, then the
//          rewarded video, then the page itself ("/exact", "/prefix/*", "*", "!/exclude").
//   gate:  server pages (e.g. /jobs) redirect to /start/<id>, which shows matching jobs after the video.
//
//   GET    /sites/:id/funnels                     list (in priority order: the first match wins)
//   GET    /sites/:id/funnels/match?url=…         which funnel a URL gets, and why
//   GET    /sites/:id/funnels/:fid
//   PUT    /sites/:id/funnels/:fid                create or replace
//   PATCH  /sites/:id/funnels/:fid                change some fields (also `position` to reorder)
//   PATCH  /sites/:id/funnels/:fid/pages          { add: [urls], remove: [urls] }
//   DELETE /sites/:id/funnels/:fid
import { Hono } from 'hono';
import type { Env } from './types';
import { resolveSite, saveConfig } from './manage';
import { loadStories } from './services/stories';

export const funnels = new Hono<{ Bindings: Env }>();
const notFound = (c: any, what = 'site') => c.json({ error: `${what} not found` }, 404);
const slug = (s: string) => String(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const keyOf = (s: string) => slug(s).replace(/-/g, '_').slice(0, 30);

// Must match apps/web/src/lib/funnels.ts
const NEVER = [/^\/(about|contact|privacy|terms|404)$/, /^\/start(\/|$)/, /^\/api\//, /^\/(ads|robots)\.txt$/, /^\/sitemap/, /^\/logos\//];
const norm = (p: string) => { const x = p.replace(/\.html$/, '').replace(/\/index$/, '/'); return (x.length > 1 ? x.replace(/\/+$/, '') : x) || '/'; };
function pageMatches(pattern: string, path: string) {
  const pat = norm(pattern.trim()), p = norm(path);
  if (pat === '*') return true;
  if (pat.endsWith('/*')) { const base = pat.slice(0, -2) || '/'; return base === '/' ? true : p === base || p.startsWith(base + '/'); }
  return p === pat;
}
const SITE_PAGES = ['/', '/article', '/find-jobs', '/jobs', '/companies'];

/** "https://site.com/foo/?x=1" → "/foo"; keeps "*", "/prefix/*" and "!" excludes. */
function toPattern(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const neg = s.startsWith('!');
  if (neg) s = s.slice(1).trim();
  if (/^https?:\/\//i.test(s)) { try { const u = new URL(s); s = u.pathname; } catch { return null; } }
  s = s.split('?')[0].split('#')[0];
  if (s !== '*' && !s.startsWith('/')) s = '/' + s;
  s = s === '*' || s.endsWith('/*') ? s : norm(s);
  return (neg ? '!' : '') + s;
}

interface Problem { error?: string; warnings: string[] }

/** Builds a clean funnel from frontend input (merged over `prev` for PATCH). */
function buildFunnel(id: string, input: any, prev: any | null, p: Problem) {
  const b = { ...(prev ?? {}), ...input };
  if (prev?.rewarded && input.rewarded) b.rewarded = { ...prev.rewarded, ...input.rewarded };
  const f: any = { id };
  f.title = String(b.title ?? '').trim().slice(0, 120);
  if (!f.title) { p.error = 'title is required'; return null; }
  if (b.intro) f.intro = String(b.intro).slice(0, 300);

  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (steps.length < 1 || steps.length > 6) { p.error = 'steps: give 1–6 questions'; return null; }
  const keys = new Set<string>();
  f.steps = [];
  for (const [i, s] of steps.entries()) {
    const question = String(s?.question ?? '').trim();
    if (!question) { p.error = `steps[${i}].question is required`; return null; }
    let key = keyOf(s.key || question) || `q${i + 1}`;
    while (keys.has(key)) key += `_${i + 1}`;
    keys.add(key);
    const opts = (Array.isArray(s.options) ? s.options : []).map((o: any) => (typeof o === 'string' ? { label: o } : o)).filter((o: any) => String(o?.label ?? '').trim());
    if (opts.length < 2 || opts.length > 12) { p.error = `steps[${i}]: give 2–12 options`; return null; }
    const values = new Set<string>();
    const options = opts.map((o: any, k: number) => {
      let value = slug(o.value ?? o.label) || `o${k + 1}`;
      while (values.has(value)) value += `-${k + 1}`;
      values.add(value);
      return { value, label: String(o.label).trim().slice(0, 80) };
    });
    f.steps.push({ key, question: question.slice(0, 160), ...(s.help ? { help: String(s.help).slice(0, 200) } : {}), options });
  }

  const pages = (Array.isArray(b.pages) ? b.pages : []).map(toPattern).filter(Boolean) as string[];
  f.pages = [...new Set(pages)];
  f.gate = (Array.isArray(b.gate) ? b.gate : []).map(toPattern).filter((x: string | null) => x && !x.startsWith('!') && !x.includes('*')) as string[];
  if (!f.pages.length && !f.gate.length) p.warnings.push('No pages yet: add URLs with pages (on-page gate) or gate (server pages such as /jobs). It will not show anywhere until then.');
  if (b.query && typeof b.query === 'object' && Object.keys(b.query).length) f.query = Object.fromEntries(Object.entries(b.query).map(([k, v]) => [String(k), String(v)]));
  f.frequency = ['once', 'session', 'always'].includes(b.frequency) ? b.frequency : 'once';
  f.rememberDays = Math.max(1, Math.min(365, Number(b.rememberDays ?? 30) || 30));
  f.enabled = b.enabled !== false;
  const r = b.rewarded ?? {};
  f.rewarded = {
    enabled: r.enabled !== false,
    ...(r.title ? { title: String(r.title).slice(0, 100) } : {}),
    ...(r.cta ? { cta: String(r.cta).slice(0, 80) } : {}),
    ...(r.skip ? { skip: String(r.skip).slice(0, 80) } : {}),
    allowSkip: r.allowSkip !== false,
  };
  if (b.interstitialAfterStep !== undefined && b.interstitialAfterStep !== null) f.interstitialAfterStep = Number(b.interstitialAfterStep);
  return f;
}

/** Warnings about URLs: never-gated pages, stories that don't exist, overlaps with earlier funnels. */
async function urlWarnings(env: Env, site: any, list: any[], f: any, p: Problem) {
  if (!site.config.ads?.enabled && f.rewarded?.enabled) p.warnings.push('Ads are not enabled on this site yet: visitors get the questions, then the page, with no video until stage 2.');
  if (f.rewarded?.enabled && !f.rewarded.allowSkip) p.warnings.push('allowSkip=false: visitors must choose the video. If no ad fills, the page is still shown.');
  let slugs: Set<string> | null = null;
  for (const pat of f.pages.filter((x: string) => !x.startsWith('!'))) {
    if (NEVER.some((r) => r.test(pat))) { p.warnings.push(`${pat} is never gated (trust pages, /start and machine files are always open).`); continue; }
    if (pat.includes('*') || SITE_PAGES.includes(pat) || pat.startsWith('/category/') || pat.startsWith('/companies/')) continue;
    if (/^\/[a-z0-9-]+$/.test(pat)) {
      slugs ??= new Set((await loadStories(env, site.slug)).map((s) => s.slug));
      if (!slugs.has(pat.slice(1))) p.warnings.push(`${pat}: no story with that URL on ${site.domain} (it will be gated if the page appears later).`);
    }
  }
  const mine = list.findIndex((x) => x.id === f.id);
  for (const [i, other] of list.entries()) {
    if (other.id === f.id || other.enabled === false || !other.pages?.length) continue;
    for (const pat of f.pages.filter((x: string) => !x.startsWith('!'))) {
      const probe = pat.endsWith('/*') ? pat.slice(0, -2) || '/' : pat;
      const otherInc = other.pages.filter((o: string) => !o.startsWith('!'));
      if (pat === '*' ? otherInc.length > 0 : otherInc.some((o: string) => pageMatches(o, probe) || (o.endsWith('/*') && pageMatches(pat, o.slice(0, -2))))) {
        p.warnings.push(i < mine || mine === -1 ? `${pat} is also covered by funnel "${other.id}", which comes first and wins.` : `${pat} overlaps funnel "${other.id}"; this funnel comes first and wins.`);
      }
    }
  }
}

function matchFor(list: any[], path: string) {
  const p = norm(path);
  if (NEVER.some((r) => r.test(p))) return { funnel: null, reason: 'never gated (trust page, /start or machine file)' };
  for (const f of list) {
    if (f.enabled === false) continue;
    if (f.pages?.length) {
      const inc = f.pages.find((x: string) => !x.startsWith('!') && pageMatches(x, p));
      const exc = f.pages.find((x: string) => x.startsWith('!') && pageMatches(x.slice(1), p));
      if (inc && !exc) return { funnel: f.id, mode: 'page', pattern: inc, query: f.query ?? null };
    }
    const g = f.gate?.find((x: string) => p === x || p.startsWith(x + '/'));
    if (g) return { funnel: f.id, mode: 'redirect', pattern: g, startUrl: `/start/${f.id}?next=${encodeURIComponent(p)}` };
  }
  return { funnel: null, reason: 'no funnel covers this URL' };
}

const view = (site: any, f: any, i: number) => ({ ...f, position: i, previewUrl: f.pages?.find((x: string) => !x.startsWith('!') && !x.includes('*')) ? `https://${site.domain}${f.pages.find((x: string) => !x.startsWith('!') && !x.includes('*'))}?funnel=preview` : null, startUrl: `https://${site.domain}/start/${f.id}` });

// ---------- routes ----------
funnels.get('/sites/:id/funnels', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const list = site.config.funnels ?? [];
  return c.json({ site: site.slug, domain: site.domain, adsEnabled: Boolean(site.config.ads?.enabled), funnels: list.map((f: any, i: number) => view(site, f, i)) });
});

funnels.get('/sites/:id/funnels/match', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const path = toPattern(c.req.query('url') ?? c.req.query('path') ?? '/')!.replace(/^!/, '');
  return c.json({ path, ...matchFor(site.config.funnels ?? [], path) });
});

funnels.get('/sites/:id/funnels/:fid', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const list = site.config.funnels ?? [];
  const i = list.findIndex((f: any) => f.id === c.req.param('fid'));
  return i < 0 ? notFound(c, 'funnel') : c.json(view(site, list[i], i));
});

async function upsert(c: any, mode: 'put' | 'patch') {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const fid = slug(c.req.param('fid'));
  if (!/^[a-z0-9-]{2,40}$/.test(fid)) return c.json({ error: 'funnel id: 2–40 letters, numbers or dashes' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const cfg = structuredClone(site.config);
  cfg.funnels ??= [];
  const i = cfg.funnels.findIndex((f: any) => f.id === fid);
  if (mode === 'patch' && i < 0) return notFound(c, 'funnel');
  const p: Problem = { warnings: [] };
  const f = buildFunnel(fid, body, mode === 'patch' ? cfg.funnels[i] : null, p);
  if (!f) return c.json({ error: p.error }, 400);
  if (i >= 0) cfg.funnels[i] = f; else cfg.funnels.push(f);
  if (body.position !== undefined) {
    const from = cfg.funnels.findIndex((x: any) => x.id === fid);
    const [moved] = cfg.funnels.splice(from, 1);
    cfg.funnels.splice(Math.max(0, Math.min(cfg.funnels.length, Number(body.position))), 0, moved);
  }
  await urlWarnings(c.env, site, cfg.funnels, f, p);
  if (JSON.stringify(cfg) === JSON.stringify(site.config)) return c.json({ changed: false, funnel: view(site, f, cfg.funnels.indexOf(f)), warnings: p.warnings });
  const out = await saveConfig(c.env, site, cfg, `${i < 0 ? 'Add' : 'Update'} funnel ${fid} on ${site.domain}`, body.deploy !== false);
  return c.json({ changed: true, created: i < 0, funnel: view(site, f, cfg.funnels.findIndex((x: any) => x.id === fid)), warnings: p.warnings, ...out }, i < 0 ? 201 : 202);
}
funnels.put('/sites/:id/funnels/:fid', (c) => upsert(c, 'put'));
funnels.patch('/sites/:id/funnels/:fid', (c) => upsert(c, 'patch'));

funnels.patch('/sites/:id/funnels/:fid/pages', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const cfg = structuredClone(site.config);
  const i = (cfg.funnels ?? []).findIndex((f: any) => f.id === c.req.param('fid'));
  if (i < 0) return notFound(c, 'funnel');
  const body = (await c.req.json().catch(() => ({}))) as any;
  const arr = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).map(toPattern).filter(Boolean) as string[];
  const add = arr(body.add ?? body.url ?? body.urls), remove = new Set(arr(body.remove));
  const f = cfg.funnels[i];
  f.pages = [...new Set([...(f.pages ?? []).filter((x: string) => !remove.has(x)), ...add])];
  const p: Problem = { warnings: [] };
  await urlWarnings(c.env, site, cfg.funnels, f, p);
  if (JSON.stringify(cfg) === JSON.stringify(site.config)) return c.json({ changed: false, pages: f.pages, warnings: p.warnings });
  const out = await saveConfig(c.env, site, cfg, `Funnel ${f.id} pages on ${site.domain}: +${add.length} -${remove.size}`, body.deploy !== false);
  return c.json({ changed: true, funnel: f.id, pages: f.pages, warnings: p.warnings, ...out }, 202);
});

funnels.delete('/sites/:id/funnels/:fid', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const cfg = structuredClone(site.config);
  const before = (cfg.funnels ?? []).length;
  cfg.funnels = (cfg.funnels ?? []).filter((f: any) => f.id !== c.req.param('fid'));
  if (cfg.funnels.length === before) return notFound(c, 'funnel');
  const out = await saveConfig(c.env, site, cfg, `Delete funnel ${c.req.param('fid')} from ${site.domain}`, c.req.query('deploy') !== '0');
  return c.json({ deleted: c.req.param('fid'), ...out }, 202);
});
