// H5 games portals. Mounted under /api/v1 (bearer auth from the parent router).
//
// Shared catalogue — the same games, text and images on every site (writes need the SUPERADMIN_KEY):
//   GET    /games                           list (q, category, disabled)
//   GET    /games/categories                categories with game counts
//   POST   /games/categories/rename         { from, to } across every game
//   POST   /games                           { slug } add a game from R2 (<slug>/catalog/game.json)
//   PATCH  /games                           { games: { slug: {…fields} } } bulk edit, one commit
//   GET    /games/:slug                     one game + its media URLs
//   PATCH  /games/:slug                     edit title, tagline, description, how_to_play, categories, orientation, disabled…
//
// Portal sites — what differs per site: domain, name/theme, which games, ad units, ads.txt:
//   POST   /games/sites                     launch a portal (zone → nameservers → GA4 → site.json → Pages → domain → Search Console)
//   GET    /games/sites                     list
//   GET    /games/sites/:id                 launch status + analytics { measurementId, property, propertyId, keyEvents } (live progress: GET /sites/:id/events)
//   POST   /games/sites/:id/retry           resume a failed launch
//   GET    /games/sites/:id/config          site.json        PATCH → name, tagline, description, theme, logo, games, exclude, featured, categories, contactEmail, content
//   GET    /games/sites/:id/games           games on this site with their URLs and ad units
//   GET    /games/sites/:id/ads             ad mode, network, units per game and per page slot
//   PATCH  /games/sites/:id/ads             { networkCode, gameUnitPattern, siteUnitPattern, siteUnits, games: { slug: units | null } }
//   PUT    /games/sites/:id/ads/games/:slug { rewarded, interstitial, native }      DELETE → back to the pattern
//   POST   /games/sites/:id/ads/enable      { lines? } live ads (stage 2)          POST …/ads/disable → test ads
//   GET|PUT|PATCH /games/sites/:id/ads.txt
//   POST   /games/sites/:id/content/lists   new lists + reviews for this site (Claude)
//   POST   /games/sites/:id/deploy          rebuild now        GET /games/sites/:id/deployments?commit=
//   GET    /games/sites/:id/health          live checks
//   POST   /games/sites/:id/analytics/setup { measurementId?, property? } GA4: find/create property, add dimensions, metrics, key events, retention
import { Hono } from 'hono';
import type { Env } from '../types';
import type { Role } from '../libraryApi';
import { createSite, siteStatus, updateSite, getSiteRow } from '../db';
import { ensureZone } from '../services/cloudflare';
import { validateAdsTxt } from '../manage';
import * as repo from './repo';
import * as pages from './pages';
import * as ga4 from './analytics';
import { writeSiteEditorial } from './editorial';
import {
  AD_KINDS, CATALOG, GAMES_STEPS, SITE_SLOTS, UNIT_RE, cdn, categoriesOf, isSlug, loadCatalog, newSiteJson, pagesProjectOf, resolveGamesSite,
  siteGames, siteKeyFor, sitePath, siteUnit, unitsFor, poTag, applyPo, isPoTag, contentFrom, type Game, type GamesLaunchInput, type GamesSiteRef,
} from './sites';

type AppEnv = { Bindings: Env; Variables: { role: Role } };
export const games = new Hono<AppEnv>();

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const superOnly = (c: any) => c.get('role') === 'superadmin' ? null
  : c.json({ error: c.env.SUPERADMIN_KEY ? 'The game catalogue is shared by every site: changing it needs the superadmin key' : 'Superadmin is not set up: run `wrangler secret put SUPERADMIN_KEY`' }, 403);
const body = async (c: any) => (await c.req.json().catch(() => ({}))) as any;
const notFound = (c: any, what = 'games site') => c.json({ error: `${what} not found` }, 404);

// ======================================================================================
// Shared catalogue
// ======================================================================================

const media = (env: Env, slug: string) => {
  const b = `${cdn(env)}/${slug}/media`;
  return { icon512: `${b}/icon-512.webp`, icon192: `${b}/icon-192.webp`, thumb: `${b}/thumb-1x1.webp`, cover: `${b}/cover-16x9.webp` };
};

const TEXT_FIELDS = ['title', 'tagline', 'description', 'play_url', 'package'] as const;

/** Validates and applies one game's edit. Returns an error message, or null. */
function applyGamePatch(g: Game, p: any): string | null {
  for (const k of TEXT_FIELDS) if (p[k] !== undefined) {
    if (typeof p[k] !== 'string') return `${k} must be text`;
    if (k === 'title' && !p.title.trim()) return 'title cannot be empty';
    g[k] = k === 'description' ? p[k].trim() : p[k].trim().slice(0, 300);
  }
  if (p.how_to_play !== undefined) {
    const steps = Array.isArray(p.how_to_play) ? p.how_to_play.map(String) : String(p.how_to_play).split('\n');
    g.how_to_play = steps.map((s: string) => s.trim()).filter(Boolean).join('\n');
    g.how_to_play_source = 'edited';
  }
  if (p.categories !== undefined) {
    if (!Array.isArray(p.categories) || !p.categories.length || p.categories.some((x: any) => typeof x !== 'string' || !x.trim())) return 'categories must be a non-empty list of names, e.g. ["Puzzle", "Casual"]';
    g.categories = [...new Set<string>(p.categories.map((x: string) => x.trim().slice(0, 40)))];
  }
  if (p.orientation !== undefined) {
    if (!['portrait', 'landscape'].includes(p.orientation)) return 'orientation must be "portrait" or "landscape"';
    g.orientation = p.orientation;
  }
  if (p.disabled !== undefined) { if (p.disabled) g.disabled = true; else delete g.disabled; }
  return null;
}

const catalogCommit = (r: { commit: string } | null) => r
  ? { commit: r.commit, deploy: { note: 'Every games site rebuilds from this commit (1–3 minutes). Follow one with GET /v1/games/sites/{id}/deployments?commit=' + r.commit } }
  : { commit: null, note: 'Nothing changed' };

games.get('/games', async (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase();
  const category = c.req.query('category');
  const disabled = c.req.query('disabled');
  const all = await loadCatalog(c.env);
  let list = all;
  if (q) list = list.filter((g) => `${g.slug} ${g.title} ${g.tagline ?? ''}`.toLowerCase().includes(q));
  if (category) list = list.filter((g) => g.categories?.includes(category));
  if (disabled !== undefined) list = list.filter((g) => Boolean(g.disabled) === ['1', 'true', 'yes'].includes(disabled));
  return c.json({ total: all.length, matched: list.length, categories: categoriesOf(all), games: list.map((g) => ({ ...g, media: media(c.env, g.slug) })) });
});

games.get('/games/categories', async (c) => {
  const all = await loadCatalog(c.env);
  return c.json({ categories: categoriesOf(all).map((name) => ({ name, games: all.filter((g) => g.categories?.includes(name) && !g.disabled).length })) });
});

games.post('/games/categories/rename', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const b = await body(c);
  const from = String(b.from ?? '').trim(), to = String(b.to ?? '').trim();
  if (!from || !to) return c.json({ error: 'Send { "from": "Brain", "to": "Logic" }' }, 400);
  let n = 0;
  const r = await repo.updateJson(c.env, [CATALOG], (cur) => {
    const list: Game[] = cur[CATALOG] ?? [];
    for (const g of list) if (g.categories?.includes(from)) { g.categories = [...new Set(g.categories.map((x) => (x === from ? to : x)))]; n++; }
    return { [CATALOG]: list };
  }, `Rename category ${from} → ${to}`);
  return c.json({ renamed: n, from, to, note: n ? `Sites that list "${from}" in their categories should list "${to}" instead (PATCH /v1/games/sites/{id}/config).` : undefined, ...catalogCommit(r) }, r ? 202 : 200);
});

// Add a game whose build + media + catalog/game.json are already in R2.
games.post('/games', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const b = await body(c);
  const slug = String(b.slug ?? '');
  if (!isSlug(slug)) return c.json({ error: 'Send { "slug": "water-sort" } — the game folder name in R2' }, 400);
  const res = await fetch(`${cdn(c.env)}/${slug}/catalog/game.json`, { cf: { cacheTtl: 0 } } as any).catch(() => null);
  if (!res?.ok) return c.json({ error: `${cdn(c.env)}/${slug}/catalog/game.json not found (${res?.status ?? 'unreachable'}). Upload the build, media/ and catalog/game.json first.` }, 404);
  const g: Game = await res.json();
  delete (g as any).h5_url; delete (g as any).screens;
  g.slug = slug;
  const err = applyGamePatch(g, { categories: b.categories ?? g.categories ?? ['Casual'], ...(b.disabled ? { disabled: true } : {}) });
  if (err) return c.json({ error: err }, 400);
  let exists = false;
  const r = await repo.updateJson(c.env, [CATALOG], (cur) => {
    const list: Game[] = cur[CATALOG] ?? [];
    if (list.some((x) => x.slug === slug)) { exists = true; return { [CATALOG]: list }; }
    return { [CATALOG]: [...list, g] };
  }, `Add game ${slug}`);
  if (exists) return c.json({ error: `${slug} is already in the catalogue. Edit it with PATCH /v1/games/${slug}` }, 409);
  return c.json({ added: { ...g, media: media(c.env, slug) }, note: 'Sites with games: "all" get it on their next build (now).', ...catalogCommit(r) }, 201);
});

games.patch('/games', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const b = await body(c);
  const edits: Record<string, any> = b.games && typeof b.games === 'object' ? b.games : {};
  if (!Object.keys(edits).length) return c.json({ error: 'Send { "games": { "water-sort": { "tagline": "…" }, … } }' }, 400);
  let problem: { status: number; error: string } | null = null;
  const r = await repo.updateJson(c.env, [CATALOG], (cur) => {
    const list: Game[] = cur[CATALOG] ?? [];
    for (const [slug, p] of Object.entries(edits)) {
      const g = list.find((x) => x.slug === slug);
      if (!g) { problem = { status: 404, error: `game ${slug} not found` }; return {}; }
      const err = applyGamePatch(g, p);
      if (err) { problem = { status: 400, error: `${slug}: ${err}` }; return {}; }
    }
    return { [CATALOG]: list };
  }, `Edit ${Object.keys(edits).length} games: ${Object.keys(edits).slice(0, 5).join(', ')}`);
  if (problem) return c.json({ error: (problem as any).error }, (problem as any).status);
  return c.json({ edited: Object.keys(edits), ...catalogCommit(r) }, r ? 202 : 200);
});

// ======================================================================================
// Portal sites
// ======================================================================================

games.post('/games/sites', async (c) => {
  const input = (await body(c)) as GamesLaunchInput;
  const domain = String(input?.domain || input?.url || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(domain)) return c.json({ error: 'A valid "domain" is required, e.g. "playpop.com"' }, 400);
  input.domain = domain;
  input.name ||= domain;
  delete input.url;
  if (input.adsMode !== undefined && !['off', 'test'].includes(input.adsMode)) return c.json({ error: 'adsMode must be "off" (default) or "test"' }, 400);
  if (input.design !== undefined && !['vibrant', 'classic'].includes(input.design)) return c.json({ error: 'design must be "vibrant" (default) or "classic"' }, 400);
  if (input.priceOptimiserScript) {
    const po = poTag(input.priceOptimiserScript, domain);
    if ('error' in po) return c.json({ error: po.error }, 400);
    input.priceOptimiserScript = po.tag.match(/src="([^"]+)"/)![1];
  }
  if (input.adsTxt !== undefined) {
    const raw: unknown = input.adsTxt;
    const lines = typeof raw === 'string' ? raw.split('\n') : raw;
    if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) return c.json({ error: 'adsTxt must be the ads.txt text or a list of its lines' }, 400);
    const v = validateAdsTxt(lines);
    if (v.warnings.length) return c.json({ error: `adsTxt: ${v.warnings.join('; ')}` }, 400);
    input.adsTxt = v.lines;
  }
  if (input.content !== undefined && input.content !== false) {
    if (typeof input.content !== 'string' || !input.content.trim()) return c.json({ error: 'content must be the site key or domain to copy lists/reviews/blog from (e.g. "torunex-site"), or false for games only' }, 400);
    input.content = input.content.trim().toLowerCase();
    const r = await contentFrom(c.env, input.content, { name: input.name || domain, domain });
    if ('error' in r) return c.json({ error: r.error }, 400);
  }
  const catalog = await loadCatalog(c.env);
  const known = new Set(catalog.map((g) => g.slug));
  for (const k of ['games', 'exclude', 'featured'] as const) {
    const v = (input as any)[k];
    if (v === undefined || v === 'all') continue;
    if (!Array.isArray(v)) return c.json({ error: `${k} must be a list of game slugs${k === 'games' ? ' or "all"' : ''}` }, 400);
    const bad = v.filter((s: string) => !known.has(s));
    if (bad.length) return c.json({ error: `Unknown games in ${k}: ${bad.join(', ')}` }, 400);
  }
  const existing = await c.env.DB.prepare('SELECT id, kind FROM sites WHERE domain = ?').bind(domain).first<any>();
  if (existing) return c.json({ error: `This domain already has a ${existing.kind ?? 'jobs'} site`, siteId: existing.id }, 409);
  const key = siteKeyFor(domain);
  if (await repo.readFile(c.env, sitePath(key))) return c.json({ error: `sites/${key}/site.json already exists in ${repo.repoName(c.env)}` }, 409);

  const siteId = `site_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await createSite(c.env, siteId, key, input, GAMES_STEPS, 'games');
  if (c.env.DRY_RUN !== 'true') {
    try {
      const z = await ensureZone(pages.gamesCfEnv(c.env), domain);
      await updateSite(c.env, siteId, { zone_id: z.id, nameservers: JSON.stringify(z.name_servers) });
    } catch (e: any) {
      await c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(siteId).run();
      return c.json({ error: `Could not add ${domain} to Cloudflare: ${e.message}` }, 502);
    }
  }
  await c.env.GAMES_LAUNCH.create({ id: `${siteId}-1`, params: { siteId, attempt: 1 } });
  return c.json({ ...(await siteStatus(c.env, siteId)), siteKey: key, statusUrl: `/api/v1/games/sites/${siteId}`, eventsUrl: `/api/v1/sites/${siteId}/events` }, 202);
});

games.get('/games/sites', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, domain, slug AS siteKey, name, status, current_step, live_url, created_at, updated_at FROM sites WHERE kind = 'games' ORDER BY created_at DESC LIMIT 200").all();
  const launched = new Set(results.map((r: any) => r.siteKey));
  const other = (await repo.listDirs(c.env, 'sites')).filter((k) => !launched.has(k)); // made by hand (e.g. demo)
  return c.json({ sites: results, notLaunchedByApi: other });
});

games.get('/games/sites/:id', async (c) => {
  const ref = await resolveGamesSite(c.env, c.req.param('id'));
  if (!ref) return notFound(c);
  const status = ref.siteId ? await siteStatus(c.env, ref.siteId) : null;
  const a = ref.site.analytics ?? {};
  const analytics = { measurementId: a.ga4 || null, property: a.ga4Property || null, propertyId: a.ga4Property ? String(a.ga4Property).replace(/^properties\//, '') : null, keyEvents: ga4.GA_KEY_EVENTS };
  return c.json({ siteKey: ref.key, domain: ref.site.domain || null, pagesProject: pagesProjectOf(ref), adsMode: ref.site.ads?.mode, analytics, launch: status, eventsUrl: ref.siteId ? `/api/v1/sites/${ref.siteId}/events` : null });
});

games.post('/games/sites/:id/retry', async (c) => {
  const ref = await resolveGamesSite(c.env, c.req.param('id'));
  const site = ref?.siteId ? await getSiteRow(c.env, ref.siteId) : null;
  if (!site) return notFound(c, 'launch');
  const force = ['1', 'true'].includes(c.req.query('force') ?? '');
  if (site.status === 'live' || site.status === 'live_with_warnings') return c.json({ error: `The launch already finished (status: ${site.status})` }, 409);
  if (site.status !== 'failed' && !force) return c.json({ error: `Only failed launches can be retried (status: ${site.status}). To restart a stuck step, add ?force=1.` }, 409);
  // force: stop the running attempt; finished steps are kept, the current one starts over.
  if (site.status !== 'failed') { try { await (await c.env.GAMES_LAUNCH.get(`${site.id}-${site.attempt}`)).terminate(); } catch { /* already gone */ } }
  const attempt = site.attempt + 1;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE steps SET status = 'pending', detail = NULL WHERE site_id = ? AND status IN ('failed','running','waiting')").bind(site.id),
    c.env.DB.prepare("UPDATE sites SET status = 'queued', error = NULL, attempt = ? WHERE id = ?").bind(attempt, site.id),
  ]);
  await c.env.GAMES_LAUNCH.create({ id: `${site.id}-${attempt}`, params: { siteId: site.id, attempt } });
  return c.json(await siteStatus(c.env, site.id), 202);
});

// ---------- per-site changes ----------

/** Read-modify-write of one site.json; returns the API response for the change. */
async function changeSite(c: any, ref: GamesSiteRef, message: string, mutate: (s: any) => string | null | void, extraIn: Record<string, unknown> | (() => Record<string, unknown>) = {}) {
  let err: string | null = null;
  const r = await repo.updateJson(c.env, [ref.path], (cur) => {
    const s = cur[ref.path];
    if (!s) { err = 'site.json disappeared'; return {}; }
    err = mutate(s) ?? null;
    return err ? {} : { [ref.path]: s };
  }, `${message} (${ref.key})`);
  if (err) return c.json({ error: err }, 400);
  const extra = typeof extraIn === 'function' ? extraIn() : extraIn;
  if (!r) return c.json({ changed: false, ...extra });
  const site = await repo.readJson(c.env, ref.path);
  return c.json({ changed: true, ...extra, config: site, commit: r.commit,
    deploy: { pagesProject: pagesProjectOf(ref), statusUrl: `/api/v1/games/sites/${ref.key}/deployments?commit=${r.commit}`, note: 'Cloudflare Pages rebuilds this site from the commit (1–3 minutes).' } }, 202);
}

const withSite = (fn: (c: any, ref: GamesSiteRef) => Promise<Response>) => async (c: any) => {
  const ref = await resolveGamesSite(c.env, c.req.param('id'));
  return ref ? fn(c, ref) : notFound(c);
};

games.get('/games/sites/:id/config', withSite(async (c, ref) => c.json({ siteKey: ref.key, path: ref.path, config: ref.site })));

const CONFIG_FIELDS = ['name', 'tagline', 'description', 'language', 'theme', 'logo', 'games', 'exclude', 'featured', 'categories', 'contactEmail', 'assets'];

games.patch('/games/sites/:id/config', withSite(async (c, ref) => {
  const b = await body(c);
  const extra = ['design', 'priceOptimiserScript', 'content'];
  const unknown = Object.keys(b).filter((k) => !CONFIG_FIELDS.includes(k) && !extra.includes(k));
  if (b.design !== undefined && !['vibrant', 'classic'].includes(b.design)) return c.json({ error: 'design must be "vibrant" or "classic"' }, 400);
  let po: string | null | undefined;
  if (b.priceOptimiserScript !== undefined) {
    if (b.priceOptimiserScript === null || b.priceOptimiserScript === false) po = null;
    else {
      const r = poTag(b.priceOptimiserScript, String(ref.site.domain ?? '').replace(/^www\./, ''));
      if ('error' in r) return c.json({ error: r.error }, 400);
      po = r.tag;
    }
  }
  // content: a site key/domain to copy lists, reviews, mobile game pages and blog from; null/false removes them.
  let content: any;
  if (b.content !== undefined) {
    if (b.content === null || b.content === false) content = null;
    else if (typeof b.content === 'string' && b.content.trim()) {
      const name = String(b.name ?? ref.site.name ?? ref.key);
      const r = await contentFrom(c.env, b.content.trim().toLowerCase(), { name, domain: String(ref.site.domain ?? ref.key), contactEmail: String(b.contactEmail ?? ref.site.contactEmail ?? '') || undefined });
      if ('error' in r) return c.json({ error: r.error }, 400);
      content = r.content;
    } else return c.json({ error: 'content must be a site key or domain to copy from (e.g. "torunex-site"), or null to remove it' }, 400);
  }
  if (unknown.length) return c.json({ error: `Not editable here: ${unknown.join(', ')}. Editable: ${[...CONFIG_FIELDS, ...extra].join(', ')} (ads: /ads, ads.txt: /ads.txt, domain: launch a new site)` }, 400);
  const known = new Set((await loadCatalog(c.env)).map((g) => g.slug));
  return changeSite(c, ref, `Edit config: ${Object.keys(b).join(', ')}`, (s) => {
    for (const k of ['games', 'exclude', 'featured']) {
      if (b[k] === undefined || (k === 'games' && b[k] === 'all')) continue;
      if (!Array.isArray(b[k])) return `${k} must be a list of game slugs`;
      const bad = b[k].filter((x: string) => !known.has(x));
      if (bad.length) return `Unknown games in ${k}: ${bad.join(', ')}`;
    }
    if (b.assets !== undefined && !['proxy', 'cdn'].includes(b.assets)) return 'assets must be "proxy" or "cdn"';
    if (b.categories !== undefined && (!Array.isArray(b.categories) || b.categories.some((x: any) => typeof x !== 'string'))) return 'categories must be a list of category names';
    for (const k of CONFIG_FIELDS) if (b[k] !== undefined) s[k] = (k === 'theme' || k === 'logo') ? { ...(s[k] ?? {}), ...b[k] } : b[k];
    if (b.design !== undefined) s.design = b.design;
    if (po !== undefined) applyPo(s, po);
    if (content === null) delete s.content;
    else if (content !== undefined) s.content = content;
  });
}));

// New lists, reviews and How-we-review text for this site, written by Claude (1–3 minutes). Replaces the site's own
// editorial.json, or gives a site that shares another site's lists its own. Needs a content block (PATCH /config { content }).
games.post('/games/sites/:id/content/lists', withSite(async (c, ref) => {
  if (!ref.site.content) return c.json({ error: 'This site has no content block. Add one first: PATCH /config { "content": "torunex-site" }' }, 409);
  try {
    await pages.syncWatchPaths(c.env, pagesProjectOf(ref), ref.key).catch(() => false); // so the content commit rebuilds the site
    const r = await writeSiteEditorial(c.env, ref.key);
    return c.json({ ...r, deploy: { pagesProject: pagesProjectOf(ref), statusUrl: r.commit ? `/api/v1/games/sites/${ref.key}/deployments?commit=${r.commit}` : null, note: 'Cloudflare Pages rebuilds this site from the commit (1–3 minutes).' } }, r.commit ? 202 : 200);
  } catch (e: any) {
    return c.json({ error: e.message }, 502);
  }
}));

games.get('/games/sites/:id/games', withSite(async (c, ref) => {
  const list = siteGames(ref.site, await loadCatalog(c.env));
  const origin = ref.site.domain ? `https://${ref.site.domain}` : null;
  return c.json({
    siteKey: ref.key, total: list.length, featured: ref.site.featured ?? [],
    games: list.map((g) => ({ slug: g.slug, title: g.title, categories: g.categories, url: origin ? `${origin}/game/${g.slug}/` : null, playUrl: origin ? `${origin}/play/${g.slug}/` : null, ads: unitsFor(ref.site, g.slug), media: media(c.env, g.slug) })),
  });
}));

// ---------- ads ----------
const checkUnits = (u: any): string | null => {
  if (!u || typeof u !== 'object') return 'units must be { "rewarded": "/123/…", "interstitial": "/123/…", "native": "/123/…" }';
  for (const k of AD_KINDS) if (typeof u[k] !== 'string' || !UNIT_RE.test(u[k])) return `${k}: "${u[k] ?? ''}" is not an ad unit path like /23360556473/example.com_water_sort_${k}`;
  return null;
};

games.get('/games/sites/:id/ads', withSite(async (c, ref) => {
  const a = ref.site.ads ?? {};
  const list = siteGames(ref.site, await loadCatalog(c.env));
  return c.json({
    siteKey: ref.key, domain: ref.site.domain || null, mode: a.mode, networkCode: a.networkCode, gameUnitPattern: a.gameUnitPattern, siteUnitPattern: a.siteUnitPattern,
    priceOptimiser: (ref.site.headHtml ?? []).find(isPoTag)?.match(/src="([^"]+)"/)?.[1] ?? null,
    note: (ref.site.headHtml ?? []).some(isPoTag) ? 'Ads on the pages come from the Price Optimiser script (native slots gam-native-01 / gam-native-02, interstitial, rewarded).'
      : a.mode === 'off' ? 'No ads yet: add the Price Optimiser script with PATCH /config { "priceOptimiserScript": … } (ads.txt is already live).'
      : a.mode === 'test' || !ref.site.domain ? 'Test mode: every slot serves Google sample ads until POST …/ads/enable.' : undefined,
    pageSlots: Object.fromEntries(Object.keys(a.siteSlots ?? {}).map((s) => [s, { sizes: a.siteSlots[s], unit: siteUnit(ref.site, s), custom: Boolean(a.siteUnits?.[s]) }])),
    games: Object.fromEntries(list.map((g) => [g.slug, unitsFor(ref.site, g.slug)])),
    adsTxt: ref.site.adsTxt ?? [],
  });
}));

games.patch('/games/sites/:id/ads', withSite(async (c, ref) => {
  const b = await body(c);
  const known = new Set((await loadCatalog(c.env)).map((g) => g.slug));
  return changeSite(c, ref, 'Edit ad units', (s) => {
    s.ads ??= {};
    if (b.networkCode !== undefined) { if (!/^\d{3,}$/.test(String(b.networkCode))) return 'networkCode must be digits'; s.ads.networkCode = String(b.networkCode); }
    for (const k of ['gameUnitPattern', 'siteUnitPattern']) if (b[k] !== undefined) {
      if (typeof b[k] !== 'string' || !b[k].includes('{network}')) return `${k} must contain {network}, e.g. /{network}/{domain}_{game}_{kind}`;
      s.ads[k] = b[k];
    }
    if (b.siteUnits !== undefined) {
      s.ads.siteUnits ??= {};
      for (const [slot, unit] of Object.entries(b.siteUnits ?? {})) {
        if (!(SITE_SLOTS as readonly string[]).includes(slot) && !s.ads.siteSlots?.[slot]) return `Unknown page slot ${slot}. Slots: ${Object.keys(s.ads.siteSlots ?? {}).join(', ')}`;
        if (unit === null || unit === '') delete s.ads.siteUnits[slot];
        else if (typeof unit !== 'string' || !UNIT_RE.test(unit)) return `${slot}: "${unit}" is not an ad unit path`;
        else s.ads.siteUnits[slot] = unit;
      }
    }
    if (b.games !== undefined) {
      s.ads.games ??= {};
      for (const [slug, units] of Object.entries(b.games ?? {})) {
        if (!known.has(slug)) return `Unknown game ${slug}`;
        if (units === null) { delete s.ads.games[slug]; continue; }
        const e = checkUnits(units); if (e) return `${slug}: ${e}`;
        s.ads.games[slug] = Object.fromEntries(AD_KINDS.map((k) => [k, (units as any)[k]]));
      }
    }
  });
}));

games.put('/games/sites/:id/ads/games/:slug', withSite(async (c, ref) => {
  const slug = c.req.param('slug');
  if (!(await loadCatalog(c.env)).some((g) => g.slug === slug)) return notFound(c, 'game');
  const u = await body(c);
  const e = checkUnits(u); if (e) return c.json({ error: e }, 400);
  return changeSite(c, ref, `Ad units for ${slug}`, (s) => { s.ads ??= {}; s.ads.games ??= {}; s.ads.games[slug] = Object.fromEntries(AD_KINDS.map((k) => [k, u[k]])); });
}));

games.delete('/games/sites/:id/ads/games/:slug', withSite(async (c, ref) => {
  const slug = c.req.param('slug');
  return changeSite(c, ref, `Ad units for ${slug} back to the pattern`, (s) => { if (s.ads?.games) delete s.ads.games[slug]; });
}));

games.post('/games/sites/:id/ads/enable', withSite(async (c, ref) => {
  if (!ref.site.domain) return c.json({ error: 'The site has no domain yet; live ads need one.' }, 409);
  if ((ref.site.headHtml ?? []).some(isPoTag)) return c.json({ error: 'This site serves ads through the Price Optimiser script, so there is nothing to enable. Set ads.txt with PUT /v1/games/sites/{id}/ads.txt; remove the script with PATCH /config { "priceOptimiserScript": null }.' }, 409);
  // (sites without the script can still switch to GPT page slots here)
  const b = await body(c);
  const incoming: string[] = Array.isArray(b.lines) ? b.lines.map(String) : typeof b.text === 'string' ? b.text.split('\n') : [];
  const { lines, warnings } = validateAdsTxt(incoming);
  return changeSite(c, ref, 'Enable live ads', (s) => { s.ads.mode = 'live'; if (incoming.length) s.adsTxt = lines; }, {
    warnings: [...warnings, 'Add a consent banner (Google CMP) before serving real ads to visitors in the EEA/UK.'],
  });
}));

games.post('/games/sites/:id/ads/disable', withSite(async (c, ref) => changeSite(c, ref, 'Ads back to test mode', (s) => { s.ads.mode = 'test'; })));

games.get('/games/sites/:id/ads.txt', withSite(async (c, ref) => {
  const lines: string[] = ref.site.adsTxt ?? [];
  return c.req.header('Accept')?.includes('text/plain') ? c.text(lines.join('\n') + '\n') : c.json({ siteKey: ref.key, lines });
}));

games.put('/games/sites/:id/ads.txt', withSite(async (c, ref) => {
  const b = await body(c);
  const { lines, warnings } = validateAdsTxt(Array.isArray(b.lines) ? b.lines.map(String) : typeof b.text === 'string' ? b.text.split('\n') : []);
  return changeSite(c, ref, 'Update ads.txt', (s) => { s.adsTxt = lines; }, { lines, warnings });
}));

games.patch('/games/sites/:id/ads.txt', withSite(async (c, ref) => {
  const b = await body(c);
  const remove = new Set((Array.isArray(b.remove) ? b.remove : []).map((l: string) => String(l).trim().toLowerCase()));
  let out: { lines: string[]; warnings: string[] } = { lines: [], warnings: [] };
  return changeSite(c, ref, 'Update ads.txt', (s) => {
    const kept = (s.adsTxt ?? []).filter((l: string) => !remove.has(l.trim().toLowerCase()));
    out = validateAdsTxt([...kept, ...(Array.isArray(b.add) ? b.add.map(String) : [])]);
    s.adsTxt = out.lines;
  }, () => ({ lines: out.lines, warnings: out.warnings }));
}));

// ---------- deploys + health ----------
games.post('/games/sites/:id/deploy', withSite(async (c, ref) => {
  await pages.syncWatchPaths(c.env, pagesProjectOf(ref), ref.key).catch(() => false);
  const d = await pages.triggerDeployment(c.env, pagesProjectOf(ref));
  return c.json({ pagesProject: pagesProjectOf(ref), deploymentId: d.id, statusUrl: `/api/v1/games/sites/${ref.key}/deployments?id=${d.id}` }, 202);
}));

games.get('/games/sites/:id/deployments', withSite(async (c, ref) => {
  const project = pagesProjectOf(ref);
  const id = c.req.query('id'), commit = c.req.query('commit');
  if (id) return c.json(await pages.deployment(c.env, project, id));
  const list = await pages.deployments(c.env, project, 10);
  if (commit) {
    const d = list.find((x) => x.commit && (x.commit.startsWith(commit) || commit.startsWith(x.commit)));
    // A newer build already includes the commit if this one was superseded before it started.
    return c.json(d ?? { status: 'queued', commit, note: 'Cloudflare has not started a build for this commit yet (or a later build includes it).', latest: list[0] ?? null });
  }
  return c.json({ pagesProject: project, deployments: list });
}));

// GA4: same setup the launch does, for sites made before it existed (or to repair one). Idempotent.
// Uses, in order: body.property, body.measurementId, site.json analytics.ga4Property / ga4, else finds or creates
// a property for the domain. Writes the Measurement ID and property into site.json when they change.
games.post('/games/sites/:id/analytics/setup', withSite(async (c, ref) => {
  if (!ga4.gaConfigured(c.env)) return c.json({ error: 'GA4_ACCOUNT_ID / GCP_SA_JSON are not configured' }, 501);
  const b = await body(c);
  const domain = ref.site.domain || null;
  const mid: string | undefined = b.measurementId || ref.site.analytics?.ga4 || undefined;
  if (mid && !/^G-[A-Z0-9]+$/.test(mid)) return c.json({ error: 'measurementId must look like G-XXXXXXXXXX' }, 400);
  const token = await ga4.gaToken(c.env);
  let found: { property: string; measurementId: string } | null = null;
  let created = false;
  try {
    const prop: string | undefined = b.property || (!b.measurementId && ref.site.analytics?.ga4Property) || undefined;
    if (prop && mid) found = { property: ga4.normProperty(String(prop)), measurementId: mid };
    else if (mid) found = await ga4.findGa4(token, c.env.GA4_ACCOUNT_ID!, { measurementId: mid, domain: domain ?? undefined, names: [ref.site.name, domain ?? ''] });
    else if (domain) { const r = await ga4.ensureGa4(c.env, token, domain, ref.site.name || domain); found = r; created = r.created; }
    else return c.json({ error: 'The site has no domain yet; pass measurementId or property' }, 409);
  } catch (e: any) { return c.json({ error: `GA4 lookup failed: ${e.message}` }, 502); }
  if (!found) return c.json({ error: `${mid} is not a web stream in GA account ${c.env.GA4_ACCOUNT_ID}, or the service account has no access to it` }, 404);
  const setup = await ga4.configureGa4(token, found.property);
  const result = { measurementId: found.measurementId, property: found.property, createdProperty: created, setup, summary: ga4.setupSummary(setup) };
  if (ref.site.analytics?.ga4 === found.measurementId && ref.site.analytics?.ga4Property === found.property) return c.json({ changed: false, ...result });
  return changeSite(c, ref, `GA4 ${found.measurementId}`, (s) => { s.analytics = { ...(s.analytics ?? {}), ga4: found!.measurementId, ga4Property: found!.property }; }, result);
}));

games.get('/games/sites/:id/health', withSite(async (c, ref) => {
  const domain = ref.site.domain;
  if (!domain) return c.json({ error: 'No domain yet' }, 409);
  const list = siteGames(ref.site, await loadCatalog(c.env));
  const first = list.find((g) => (ref.site.featured ?? []).includes(g.slug)) ?? list[0];
  const paths = ['/', '/robots.txt', '/sitemap.xml', '/ads.txt', ...(first ? [`/game/${first.slug}/`, `/play/${first.slug}/`, `/play/${first.slug}/gam-config.js`] : [])];
  const checks: Record<string, number | string> = {};
  const texts: Record<string, string> = {};
  await Promise.all(paths.map(async (p) => {
    try {
      const r = await fetch(`https://${domain}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
      checks[p] = r.status;
      if (r.ok && (p === '/ads.txt' || p.endsWith('gam-config.js') || p === '/')) texts[p] = await r.text();
    } catch { checks[p] = 'unreachable'; }
  }));
  const configured: string[] = ref.site.adsTxt ?? [];
  const live = (texts['/ads.txt'] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const expect = first ? unitsFor(ref.site, first.slug).units.rewarded : null;
  const gam = first ? texts[`/play/${first.slug}/gam-config.js`] ?? '' : '';
  return c.json({
    domain, ok: Object.entries(checks).every(([p, v]) => v === 200 || (p === '/ads.txt' && !configured.length)),
    checks,
    ads: {
      mode: ref.site.ads?.mode,
      adsTxtInSync: configured.length === live.length && configured.every((l) => live.includes(l)),
      checkedGame: first?.slug ?? null,
      gameUsesSiteUnits: first ? (gam ? gam.includes(String(expect)) : null) : null,
    },
    analytics: { ga4: ref.site.analytics?.ga4 || null, tagOnHomepage: Boolean(ref.site.analytics?.ga4 && (texts['/'] ?? '').includes(ref.site.analytics.ga4)) },
  });
}));

// One game from the catalogue (after /games/sites/* so "sites" is never read as a slug).
games.get('/games/:slug', async (c) => {
  const g = (await loadCatalog(c.env)).find((x) => x.slug === c.req.param('slug'));
  return g ? c.json({ ...g, media: media(c.env, g.slug) }) : notFound(c, 'game');
});

games.patch('/games/:slug', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const slug = c.req.param('slug');
  const p = await body(c);
  let problem: { status: number; error: string } | null = null;
  let updated: Game | null = null;
  const r = await repo.updateJson(c.env, [CATALOG], (cur) => {
    const list: Game[] = cur[CATALOG] ?? [];
    const g = list.find((x) => x.slug === slug);
    if (!g) { problem = { status: 404, error: 'game not found' }; return {}; }
    const err = applyGamePatch(g, p);
    if (err) { problem = { status: 400, error: err }; return {}; }
    updated = g;
    return { [CATALOG]: list };
  }, `Edit game ${slug}: ${Object.keys(p).join(', ')}`);
  if (problem) return c.json({ error: (problem as any).error }, (problem as any).status);
  return c.json({ game: updated, ...catalogCommit(r) }, r ? 202 : 200);
});
