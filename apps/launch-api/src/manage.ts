// Site management endpoints for the frontend: config, ads (enable/disable, ads.txt), deploys, health, jobs data.
// Mounted under /api/v1 (bearer auth applied by the parent router).
import { Hono } from 'hono';
import type { Env } from './types';
import * as gh from './services/github';

type Ctx = { Bindings: Env & { JOBS_API_BASE?: string; JOBS_API_KEY?: string } };
export const manage = new Hono<Ctx>();

const SDK_URL = 'https://serve.thebesads.com/sdk/publisher-sdk.js';
const RUNTIME_URL = 'https://serve.thebesads.com/runtime/config';

// ---------- helpers ----------
export interface SiteRef { slug: string; domain: string; path: string; config: any }

/** Finds a site by launch id, domain or folder slug, and loads its site.config.json from the repo. */
export async function resolveSite(env: Env, idOrDomain: string): Promise<SiteRef | null> {
  const key = idOrDomain.toLowerCase();
  let slug: string | undefined;
  if (key.startsWith('site_')) slug = (await env.DB.prepare('SELECT slug FROM sites WHERE id = ?').bind(key).first<any>())?.slug;
  slug ??= (await env.DB.prepare('SELECT slug FROM sites WHERE domain = ?').bind(key).first<any>())?.slug;
  const tryLoad = async (s: string) => {
    const raw = await gh.readFile(env, `sites/${s}/site.config.json`);
    return raw ? { slug: s, path: `sites/${s}/site.config.json`, config: JSON.parse(raw) } : null;
  };
  let found = slug ? await tryLoad(slug) : await tryLoad(key);
  if (!found) {
    // Sites not launched through the API (e.g. careertrailhead): match by domain across /sites.
    const files = (await gh.listTree(env, 'sites')).filter((f) => /^sites\/[^/_][^/]*\/site\.config\.json$/.test(f.path));
    for (const f of files) {
      const cfg = JSON.parse(await gh.readBlob(env, f.sha));
      if (cfg.domain === key || cfg.slug === key) { found = { slug: cfg.slug, path: f.path, config: cfg }; break; }
    }
  }
  return found ? { ...found, domain: found.config.domain } : null;
}

const notFound = (c: any) => c.json({ error: 'site not found' }, 404);

export async function saveConfig(env: Env, site: SiteRef, config: any, message: string, deploy = true) {
  const commit = await gh.commitFiles(env, [{ path: site.path, content: JSON.stringify(config, null, 2) + '\n' }], `${message} [skip ci]`);
  const runKey = `${site.slug}-${Date.now().toString(36)}`;
  if (deploy) await gh.dispatchDeploy(env, site.slug, runKey);
  return { commit, deploy: deploy ? { runKey, statusUrl: `/api/v1/deploys/${runKey}` } : null };
}

/** ads.txt lines: data records "domain, account, DIRECT|RESELLER[, cert]", variables (KEY=value) and # comments. */
export function validateAdsTxt(lines: string[]) {
  const clean: string[] = [];
  const warnings: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r/g, '').trim();
    if (!line) continue;
    if (line.startsWith('#') || /^(OWNERDOMAIN|MANAGERDOMAIN|CONTACT|SUBDOMAIN|INVENTORYPARTNERDOMAIN)=/i.test(line)) { clean.push(line); continue; }
    const parts = line.split('#')[0].split(',').map((p) => p.trim());
    if (parts.length < 3 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parts[0]) || !parts[1] || !/^(DIRECT|RESELLER)$/i.test(parts[2])) {
      warnings.push(`Unrecognised ads.txt line kept as-is: "${line}"`);
    }
    clean.push(line);
  }
  return { lines: [...new Set(clean)], warnings };
}

async function runtimeFor(domain: string) {
  try {
    const r = await fetch(`${RUNTIME_URL}?site=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(10_000) });
    const body: any = r.ok ? await r.json() : null;
    return { reachable: r.ok, siteKey: body?.siteKey ?? null, configurationRevision: body?.configurationRevision ?? null, serving: body?.siteKey === domain };
  } catch {
    return { reachable: false, siteKey: null, configurationRevision: null, serving: false };
  }
}

const linesFrom = (body: any): string[] =>
  Array.isArray(body?.lines) ? body.lines.map(String) : typeof body?.text === 'string' ? body.text.split('\n') : [];

// ---------- config ----------
manage.get('/sites/:id/config', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  return site ? c.json({ slug: site.slug, domain: site.domain, config: site.config }) : notFound(c);
});

// Safe, frontend-editable fields only.
manage.patch('/sites/:id/config', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const body: any = await c.req.json().catch(() => ({}));
  const cfg = structuredClone(site.config);
  for (const k of ['name', 'tagline', 'description'] as const) if (typeof body[k] === 'string' && body[k].trim()) cfg[k] = body[k].trim();
  if (body.theme && typeof body.theme === 'object') cfg.theme = { ...cfg.theme, ...Object.fromEntries(Object.entries(body.theme).filter(([k, v]) => ['primary', 'accent', 'logoText'].includes(k) && typeof v === 'string')) };
  if (body.legal?.contactEmail) cfg.legal = { ...cfg.legal, contactEmail: String(body.legal.contactEmail) };
  if (body.jobs?.landing && typeof body.jobs.landing === 'object') cfg.jobs = { ...cfg.jobs, landing: { ...cfg.jobs.landing, ...body.jobs.landing } };
  if (JSON.stringify(cfg) === JSON.stringify(site.config)) return c.json({ changed: false, config: cfg });
  return c.json({ changed: true, config: cfg, ...(await saveConfig(c.env, site, cfg, `Update config for ${site.domain}`)) }, 202);
});

// ---------- ads ----------
manage.get('/sites/:id/ads', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const a = site.config.ads ?? {};
  return c.json({ domain: site.domain, enabled: Boolean(a.enabled), poSite: a.poSite ?? null, sdkUrl: a.sdkUrl ?? null, runtimeUrl: a.runtimeUrl ?? null, adsTxt: a.adsTxt ?? [], runtime: await runtimeFor(site.domain) });
});

/** Stage 2: turn ads on (optionally with ads.txt). Refuses unless the runtime serves this site key, unless requireRuntime=false. */
manage.post('/sites/:id/ads/enable', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const body: any = await c.req.json().catch(() => ({}));
  const runtime = await runtimeFor(site.domain);
  if (body.requireRuntime !== false && !runtime.serving) {
    return c.json({ error: `The Price Optimiser runtime is not serving siteKey "${site.domain}" yet. Publish the configuration, or pass requireRuntime=false.`, runtime }, 409);
  }
  const cfg = structuredClone(site.config);
  // A site on a dedicated Price Optimiser bundle keeps its own sdkUrl.
  cfg.ads = cfg.ads?.sdkMode === 'bundle'
    ? { ...cfg.ads, enabled: true, poSite: site.domain }
    : { ...cfg.ads, enabled: true, poSite: site.domain, sdkUrl: SDK_URL, runtimeUrl: RUNTIME_URL };
  const incoming = linesFrom(body);
  const { lines, warnings } = validateAdsTxt(incoming);
  if (incoming.length) cfg.ads.adsTxt = lines;
  return c.json({ enabled: true, adsTxt: cfg.ads.adsTxt ?? [], warnings, runtime, ...(await saveConfig(c.env, site, cfg, `Enable ads for ${site.domain}`)) }, 202);
});

manage.post('/sites/:id/ads/disable', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const cfg = structuredClone(site.config);
  cfg.ads = { ...cfg.ads, enabled: false };
  return c.json({ enabled: false, ...(await saveConfig(c.env, site, cfg, `Disable ads for ${site.domain}`)) }, 202);
});

manage.get('/sites/:id/ads.txt', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const lines: string[] = site.config.ads?.adsTxt ?? [];
  return c.req.header('Accept')?.includes('text/plain') ? c.text(lines.join('\n') + '\n') : c.json({ domain: site.domain, lines });
});

/** Replace ads.txt entirely: { "lines": [...] } or { "text": "line1\nline2" }. */
manage.put('/sites/:id/ads.txt', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const body: any = await c.req.json().catch(() => ({}));
  const { lines, warnings } = validateAdsTxt(linesFrom(body));
  const cfg = structuredClone(site.config);
  cfg.ads = { ...cfg.ads, adsTxt: lines };
  if (JSON.stringify(lines) === JSON.stringify(site.config.ads?.adsTxt ?? [])) return c.json({ changed: false, lines, warnings });
  return c.json({ changed: true, lines, warnings, ...(await saveConfig(c.env, site, cfg, `Update ads.txt for ${site.domain}`)) }, 202);
});

/** Add and/or remove lines: { "add": [...], "remove": [...] } (remove matches exact lines, case-insensitive). */
manage.patch('/sites/:id/ads.txt', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const body: any = await c.req.json().catch(() => ({}));
  const remove = new Set((Array.isArray(body.remove) ? body.remove : []).map((l: string) => String(l).trim().toLowerCase()));
  const current: string[] = (site.config.ads?.adsTxt ?? []).filter((l: string) => !remove.has(l.trim().toLowerCase()));
  const { lines, warnings } = validateAdsTxt([...current, ...(Array.isArray(body.add) ? body.add.map(String) : [])]);
  if (JSON.stringify(lines) === JSON.stringify(site.config.ads?.adsTxt ?? [])) return c.json({ changed: false, lines, warnings });
  const cfg = structuredClone(site.config);
  cfg.ads = { ...cfg.ads, adsTxt: lines };
  return c.json({ changed: true, lines, warnings, ...(await saveConfig(c.env, site, cfg, `Update ads.txt for ${site.domain}`)) }, 202);
});

// ---------- deploys ----------
manage.post('/sites/:id/deploy', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const runKey = `${site.slug}-${Date.now().toString(36)}`;
  await gh.dispatchDeploy(c.env, site.slug, runKey);
  return c.json({ site: site.slug, deploy: { runKey, statusUrl: `/api/v1/deploys/${runKey}` } }, 202);
});

manage.get('/deploys/:runKey', async (c) => {
  const run = await gh.findRun(c.env, c.req.param('runKey'));
  if (!run) return c.json({ runKey: c.req.param('runKey'), status: 'queued', note: 'GitHub has not started the run yet' });
  return c.json({ runKey: c.req.param('runKey'), status: run.status, conclusion: run.conclusion, url: run.url });
});

// ---------- live health ----------
manage.get('/sites/:id/health', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const paths = ['/', '/ads.txt', '/robots.txt', '/sitemap.xml', '/find-jobs'];
  const checks: Record<string, number | string> = {};
  let home = '';
  let adsTxtLive = '';
  await Promise.all(paths.map(async (p) => {
    try {
      const r = await fetch(`https://${site.domain}${p}`, { signal: AbortSignal.timeout(12_000), redirect: 'manual' });
      checks[p] = r.status;
      if (p === '/') home = await r.text();
      if (p === '/ads.txt' && r.ok) adsTxtLive = await r.text();
    } catch { checks[p] = 'unreachable'; }
  }));
  const configured: string[] = site.config.ads?.adsTxt ?? [];
  const live = adsTxtLive.split('\n').map((l) => l.trim()).filter(Boolean);
  return c.json({
    domain: site.domain,
    ok: Object.values(checks).every((v) => v === 200),
    checks,
    ads: {
      enabled: Boolean(site.config.ads?.enabled),
      sdkTagOnHomepage: home.includes(`data-po-site="${site.domain}"`),
      adsTxtLines: live.length,
      adsTxtInSync: configured.length === live.length && configured.every((l) => live.includes(l)),
      runtime: await runtimeFor(site.domain),
    },
    analytics: { ga4MeasurementId: site.config.analytics?.ga4MeasurementId || null, tagOnHomepage: Boolean(site.config.analytics?.ga4MeasurementId && home.includes(site.config.analytics.ga4MeasurementId)) },
  });
});

// ---------- shared jobs data (proxied to the Cloud Run jobs API) ----------
async function jobsApi(c: any, path: string, init: RequestInit = {}) {
  const base = c.env.JOBS_API_BASE, key = c.env.JOBS_API_KEY;
  if (!base || !key) return c.json({ error: 'Set JOBS_API_BASE (var) and JOBS_API_KEY (secret) on the launch-api Worker' }, 501);
  const r = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, headers: { 'x-api-key': key, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(590_000) });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') ?? 'application/json' } });
}
manage.get('/jobs/health', (c) => jobsApi(c, '/health'));
manage.get('/jobs/usage', (c) => jobsApi(c, `/internal/usage${c.req.query('month') ? `?month=${c.req.query('month')}` : ''}`));
manage.get('/jobs/search', (c) => jobsApi(c, `/jobs?${new URLSearchParams(c.req.query())}`));
manage.get('/jobs/companies', (c) => jobsApi(c, `/companies?${new URLSearchParams(c.req.query())}`));
manage.get('/jobs/companies/:slug', (c) => jobsApi(c, `/companies/${encodeURIComponent(c.req.param('slug'))}`));
manage.post('/jobs/refresh', (c) => jobsApi(c, `/internal/refresh?${new URLSearchParams(c.req.query())}`, { method: 'POST' }));
manage.post('/jobs/enrich', (c) => jobsApi(c, `/internal/enrich?${new URLSearchParams(c.req.query())}`, { method: 'POST' }));

/** Commit files for a site (one commit) and, unless deploy=false, start a deploy the frontend can follow. */
export async function commitAndDeploy(env: Env, siteSlug: string, files: gh.TreeFile[], message: string, deploy = true) {
  const commit = await gh.commitFiles(env, files, `${message} [skip ci]`);
  const runKey = `${siteSlug}-${Date.now().toString(36)}`;
  if (deploy) await gh.dispatchDeploy(env, siteSlug, runKey);
  return { commit, deploy: deploy ? { runKey, statusUrl: `/api/v1/deploys/${runKey}` } : null };
}
