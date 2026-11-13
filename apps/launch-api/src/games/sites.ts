// Games portal helpers shared by the API and the launch workflow.
import type { Env } from '../types';
import { slugFromDomain } from '../types';
import * as repo from './repo';
import { projectName } from './pages';

/** Launch steps of a games portal (stored per site in D1 like the jobs steps). */
export const GAMES_STEPS = [
  { key: 'zone', label: 'Domain on Cloudflare' },
  { key: 'nameservers', label: 'Waiting for nameservers' },
  { key: 'analytics', label: 'GA4: property, dimensions, key events' },
  { key: 'repo', label: 'Write site.json to GitHub' },
  { key: 'lists', label: 'Write this site\'s own lists and reviews' },
  { key: 'pages', label: 'Create Cloudflare Pages project' },
  { key: 'deploy', label: 'Build & deploy' },
  { key: 'custom_domain', label: 'Attach domain + SSL' },
  { key: 'search_console', label: 'Verify Search Console + sitemap' },
  { key: 'ads', label: 'Ads (Price Optimiser script, or none yet)' },
  { key: 'smoke_test', label: 'Check site is live' },
] as const;

export const CATALOG = 'catalog/games.json';
export const sitePath = (key: string) => `sites/${key}/site.json`;
export const cdn = (env: Env) => (env.GAMES_CDN || 'https://games.gamewhame.com').replace(/\/$/, '');
export const AD_KINDS = ['rewarded', 'interstitial', 'native'] as const;
export const SITE_SLOTS = ['game_side', 'home_rect', 'game_below'] as const;
export const UNIT_RE = /^\/\d{3,}(\/[A-Za-z0-9._\-]+)+$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSlug = (s: unknown) => typeof s === 'string' && SLUG_RE.test(s);

export interface Game { slug: string; title: string; tagline?: string; description?: string; how_to_play?: string; categories: string[]; orientation?: string; play_url?: string; package?: string; disabled?: boolean; [k: string]: unknown }

export interface GamesLaunchInput {
  domain: string;
  /** Same as domain; a full URL is fine (https://www.example.com → example.com). */
  url?: string;
  /** Page design: "vibrant" (default) or "classic". */
  design?: 'vibrant' | 'classic';
  /**
   * Price Optimiser ad script: the <script> tag, its src URL, or true for https://serve.thebesads.com/sdk/<domain>.js.
   * With it, portal pages carry no GPT slots of their own: the script fills the two native slots (gam-native-01/02)
   * and serves interstitial/rewarded.
   */
  priceOptimiserScript?: string | boolean;
  /**
   * Anchor ad: a sticky bottom container with DIV ID "gam-anchor" on every page, filled by the Price Optimiser SDK
   * (Rules API slot "gam-anchor": 320x50 / 320x100 on mobile, 728x90 on desktop). Only rendered while the site has
   * the Price Optimiser script. Default false.
   */
  anchor?: boolean;
  /**
   * The two in-page native containers (gam-native-01/02). Default true when the Price Optimiser script is set; false
   * for an anchor-only site, so pages carry no empty native boxes.
   */
  nativeSlots?: boolean;
  /**
   * Ads before the Price Optimiser script is added: "off" (default: no ad divs, no GPT, ads.txt still published, so GAM
   * can verify the site) or "test" (Google sample ads in GPT slots, the old stage-2 flow).
   */
  adsMode?: 'off' | 'test';
  name?: string;
  tagline?: string;
  description?: string;
  language?: string;
  theme?: Record<string, string>;
  /** Shortcut for theme.accent. */
  primaryColor?: string;
  /**
   * motif: retro logo drawn by the builder (header/footer mark, favicon, app icons, /logo.png) — one of LOGO_MOTIFS.
   * Default: the motif fewest existing sites use, with its default tile colour. tile: any #rrggbb.
   */
  logo?: { text?: string; mark?: string; motif?: string; tile?: string };
  /** "all" (default) or a list of game slugs. */
  games?: 'all' | string[];
  exclude?: string[];
  featured?: string[];
  /** Categories shown on this site, in order (default: every category its games use). */
  categories?: string[];
  contactEmail?: string;
  /** ads.txt lines (or the whole file as one string). */
  adsTxt?: string[];
  networkCode?: string;
  /**
   * Lists, reviews, mobile game pages and blog (the "What should I download?" part of the home page).
   * A site key or domain to copy them from (default GAMES_CONTENT_FROM, i.e. torunex-site), or false for games only.
   */
  content?: string | false;
  /** With content: write this site's own lists, reviews and How-we-review page with Claude (default true). false shares the source's. */
  newLists?: boolean;
  /** Google Tag Manager container for the site (Clarity etc.). Default GAMES_GTM_ID (GTM-WV6SWT6V); false for none. */
  gtm?: string | false;
  /** Microsoft Clarity project ID (clarity.microsoft.com/projects/view/<id>); Clarity has no API to create projects. */
  clarity?: string;
  /** Use an existing GA4 web stream instead of creating a property. */
  ga4MeasurementId?: string;
  webhookUrl?: string;
}

const PO_HOST_RE = /serve\.thebesads\.com\/sdk\//;
/** true for the head entry that loads the Price Optimiser script. */
export const isPoTag = (h: unknown) => typeof h === 'string' && PO_HOST_RE.test(h);
// Rules API SDK. Without an explicit data-po-runtime-config-url this SDK falls back to its built-in default
// runtime, which is the legacy priceoptimiser1.thebesads.com/v1/runtime-config (404 for Rules API sites).
export const PO_SDK_URL = 'https://serve.thebesads.com/sdk/publisher-sdk.js';
export const PO_RUNTIME_URL = 'https://serve.thebesads.com/runtime/config';
const PO_LEGACY_RUNTIME_RE = /priceoptimiser1\.thebesads\.com|\/v1\/runtime-config/i;
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}=["']?([^"'\\s>]+)`, 'i'))?.[1] ?? '';

/** Normalises the Price Optimiser input to one <script defer> tag, or returns an error message. */
export function poTag(v: unknown, domain: string): { tag: string } | { error: string } {
  let src = '', given = '';
  if (v === true) src = `https://serve.thebesads.com/sdk/${domain}.js`;
  else if (typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim())) src = v.trim();
  else if (typeof v === 'string') { given = v; src = attr(v, 'src'); }
  if (!src) return { error: 'priceOptimiserScript must be the <script src="https://…"> tag, its https URL, or true' };
  if (!/^https:\/\/[a-z0-9.-]+\/[\w./%-]+(\?[\w=&.%-]*)?$/i.test(src)) return { error: `priceOptimiserScript: "${src}" is not a plain https script URL` };
  if (src !== PO_SDK_URL) return { tag: `<script defer src="${src}"></script>` }; // per-domain script, site baked in

  // Rules API SDK: always set the site and the runtime explicitly (never rely on SDK defaults).
  const site = attr(given, 'data-po-site') || domain;
  const runtime = attr(given, 'data-po-runtime-config-url') || PO_RUNTIME_URL;
  if (site !== domain) return { error: `priceOptimiserScript: data-po-site "${site}" does not match the site domain "${domain}"` };
  if (PO_LEGACY_RUNTIME_RE.test(runtime)) return { error: `priceOptimiserScript: "${runtime}" is the legacy Price Optimiser runtime; use ${PO_RUNTIME_URL}` };
  if (!/^https:\/\/[a-z0-9.-]+\/[\w./%-]*$/i.test(runtime)) return { error: `priceOptimiserScript: data-po-runtime-config-url "${runtime}" is not a plain https URL` };
  // data-auto-init="false" is dropped on purpose: games pages have no init script, so the SDK must auto-init.
  return { tag: `<script defer src="${src}" data-po-site="${site}" data-po-runtime-config-url="${runtime}"></script>` };
}
/** Applies (or with null removes) the Price Optimiser script on a site.json. Keeps exactly one SDK tag. */
export function applyPo(site: any, tag: string | null) {
  site.headHtml = [...(tag ? [tag] : []), ...(site.headHtml ?? []).filter((h: unknown) => !isPoTag(h))];
  if (!site.headHtml.length) delete site.headHtml;
  site.ads = site.ads ?? {};
  // An explicit nativeSlots: false (anchor-only site) survives adding, replacing or removing the script.
  if (tag) { site.ads.mode = 'off'; if (site.ads.nativeSlots !== false) site.ads.nativeSlots = true; }
  else if (site.ads.nativeSlots) delete site.ads.nativeSlots; // mode stays "off": no ads until a script is added again
}
/** Sets the Price Optimiser placements on a site.json: anchor (#gam-anchor) and the native containers. */
export function applyPlacements(site: any, p: { anchor?: boolean | null; nativeSlots?: boolean | null }) {
  site.ads = site.ads ?? {};
  if (p.anchor !== undefined) { if (p.anchor) site.ads.anchor = true; else delete site.ads.anchor; }
  if (p.nativeSlots !== undefined) {
    if (p.nativeSlots === false) site.ads.nativeSlots = false;
    else if ((site.headHtml ?? []).some(isPoTag)) site.ads.nativeSlots = true;
    else delete site.ads.nativeSlots;
  }
}
/** Validates the anchor / nativeSlots inputs (booleans; null allowed when patching). */
export function placementError(b: any, patch = false): string | null {
  for (const k of ['anchor', 'nativeSlots']) {
    const v = b?.[k];
    if (v === undefined || typeof v === 'boolean' || (patch && v === null)) continue;
    return `${k} must be true or false`;
  }
  return null;
}

/** Retro logo motifs (h5-games-site-builder src/logo.mjs) and their default tile colours. */
export const LOGO_TILES: Record<string, string> = { controller: '#B6F23A', cartridge: '#FFD23F', handheld: '#5CE1E6', cassette: '#FF8FB8', joystick: '#B79CFF', crt: '#FF9F45' };
export const LOGO_MOTIFS = Object.keys(LOGO_TILES);
const TILE_ALT = ['#FFD23F', '#5CE1E6', '#FF8FB8', '#B79CFF', '#FF9F45', '#B6F23A', '#7CE38B', '#FF7A7A'];
export function logoError(l: any): string | null {
  if (l === undefined) return null;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'logo must be an object like { "motif": "cassette", "tile": "#FF8FB8" }';
  if (l.motif !== undefined && l.motif !== null && !LOGO_MOTIFS.includes(l.motif)) return `logo.motif must be one of ${LOGO_MOTIFS.join(', ')}`;
  if (l.tile !== undefined && l.tile !== null && !/^#[0-9a-f]{6}$/i.test(String(l.tile))) return 'logo.tile must be a colour like #FF8FB8';
  return null;
}
/** Logo for a new site: the least-used motif across existing sites (ties: by site key), and a tile no site has with it. */
export async function pickLogo(env: Env, key: string, want?: { motif?: string; tile?: string }) {
  const used: { motif: string; tile: string }[] = [];
  for (const d of await repo.listDirs(env, 'sites').catch(() => [] as string[])) {
    const l = (await repo.readJson<any>(env, sitePath(d)).catch(() => null))?.logo;
    if (l?.motif) used.push({ motif: l.motif, tile: String(l.tile || LOGO_TILES[l.motif]).toUpperCase() });
  }
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const count = (m: string) => used.filter((u) => u.motif === m).length;
  const motif = want?.motif && LOGO_MOTIFS.includes(want.motif) ? want.motif
    : [...LOGO_MOTIFS].sort((a, b) => count(a) - count(b) || ((LOGO_MOTIFS.indexOf(a) + h) % 6) - ((LOGO_MOTIFS.indexOf(b) + h) % 6))[0];
  if (want?.tile) return { motif, tile: want.tile };
  const taken = new Set(used.filter((u) => u.motif === motif).map((u) => u.tile));
  const tile = [LOGO_TILES[motif], ...TILE_ALT].find((t) => !taken.has(t.toUpperCase())) ?? LOGO_TILES[motif];
  return { motif, tile };
}

/** Shared Tag Manager container of the games portals (Microsoft Clarity and other tags, one trigger per hostname). */
export const DEFAULT_GTM = 'GTM-WV6SWT6V';
export const GTM_RE = /^GTM-[A-Z0-9]+$/;
export const CLARITY_RE = /^[a-z0-9]{6,16}$/;

export const DEFAULT_THEME = { background: '#bfe3ff', backgroundAlt: '#d9efff', accent: '#ff3d77', accentText: '#ffffff', text: '#0b2a4a', tile: '#ffffff' };
const CATEGORY_ORDER = ['Puzzle', 'Casual', 'Word', 'Arcade', 'Brain', 'Cards', 'Casino', 'Sports', 'Action'];

export const siteKeyFor = (domain: string) => slugFromDomain(domain);

export async function loadCatalog(env: Env): Promise<Game[]> {
  return (await repo.readJson<Game[]>(env, CATALOG)) ?? [];
}

export function categoriesOf(games: Game[]) {
  const all = [...new Set(games.flatMap((g) => g.categories ?? []))];
  return all.sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}

/** The site.json a new portal starts with. */
export function newSiteJson(key: string, input: GamesLaunchInput, catalog: Game[]) {
  const name = input.name || input.domain;
  const live = catalog.filter((g) => !g.disabled);
  const chosen = input.games && input.games !== 'all' ? live.filter((g) => (input.games as string[]).includes(g.slug)) : live;
  const site: Record<string, any> = {
    key,
    name,
    domain: input.domain,
    pagesProject: projectName(key),
    tagline: input.tagline || 'Free online games. No downloads, no sign-up. Just tap and play.',
    description: input.description || `${name} has free online puzzle, word, arcade and casual games. Play instantly in your browser on mobile, tablet or desktop.`,
    language: input.language || 'en',
    theme: { ...DEFAULT_THEME, ...(input.theme ?? {}), ...(input.primaryColor ? { accent: input.primaryColor } : {}) },
    logo: { text: input.logo?.text || name, mark: input.logo?.mark || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || 'G' },
    games: input.games && input.games !== 'all' ? input.games : 'all',
    exclude: input.exclude ?? [],
    featured: input.featured ?? chosen.slice(0, 5).map((g) => g.slug),
    categories: input.categories ?? categoriesOf(chosen),
    ads: {
      mode: input.adsMode === 'test' ? 'test' : 'off',
      networkCode: input.networkCode || '23360556473',
      gameUnitPattern: '/{network}/{domain}_{game}_{kind}',
      siteUnitPattern: '/{network}/{domain}_{slot}',
      siteSlots: { game_side: [[300, 250], [300, 600], [160, 600]], home_rect: [[300, 250]], game_below: [[728, 90], [320, 100], [320, 50]] },
      games: {},
      siteUnits: {},
    },
    assets: 'proxy',
    adsTxt: input.adsTxt ?? [],
    contactEmail: input.contactEmail ?? '',
    analytics: { ga4: input.ga4MeasurementId ?? '', ...(input.gtm === false ? {} : { gtm: input.gtm || DEFAULT_GTM }), ...(input.clarity ? { clarity: input.clarity } : {}) } as { ga4: string; ga4Property?: string; gtm?: string; clarity?: string },
    design: input.design === 'classic' ? 'classic' : 'vibrant',
  };
  if (input.nativeSlots === false) site.ads.nativeSlots = false; // before applyPo, which keeps an explicit false
  const po = input.priceOptimiserScript ? poTag(input.priceOptimiserScript, input.domain) : null;
  if (po && 'tag' in po) applyPo(site, po.tag);
  applyPlacements(site, { anchor: input.anchor });
  return site;
}

/** Games a site shows, the same way build.mjs picks them. */
export function siteGames(site: any, catalog: Game[]) {
  let list = site.games === 'all' || !Array.isArray(site.games) ? catalog : catalog.filter((g) => site.games.includes(g.slug));
  return list.filter((g) => g.title && !g.disabled && !(site.exclude ?? []).includes(g.slug));
}

/** The ad units a game gets on a site, the same way functions/play resolves them. */
export function unitsFor(site: any, slug: string) {
  const a = site.ads ?? {};
  if (a.mode === 'test' || a.mode === 'off' || !site.domain) return { source: 'test', units: { rewarded: '/22639388115/rewarded_web_example', interstitial: '/6355419/Travel/Europe/France/Paris', native: '/6355419/Travel/Europe/France/Paris' } };
  const own = a.games?.[slug];
  if (own?.rewarded && own?.interstitial && own?.native) return { source: 'site', units: own };
  const game = slug.replace(/-/g, '_');
  const make = (kind: string) => String(a.gameUnitPattern ?? '').replace('{network}', a.networkCode).replace('{domain}', site.domain).replace('{game}', game).replace('{kind}', kind);
  return { source: 'pattern (unless an R2 ads.json exists)', units: { rewarded: make('rewarded'), interstitial: make('interstitial'), native: make('native') } };
}

export function siteUnit(site: any, slot: string) {
  const a = site.ads ?? {};
  if (a.mode === 'test' || a.mode === 'off' || !site.domain) return '/6355419/Travel/Europe/France/Paris';
  return a.siteUnits?.[slot] || String(a.siteUnitPattern ?? '').replace('{network}', a.networkCode).replace('{domain}', site.domain).replace('{slot}', slot);
}

export interface GamesSiteRef { key: string; path: string; site: any; siteId: string | null }

/** By launch id (site_…), domain or site key. Sites not launched through the API (e.g. "demo") resolve by key. */
export async function resolveGamesSite(env: Env, idOrDomain: string): Promise<GamesSiteRef | null> {
  const k = idOrDomain.toLowerCase();
  const row = k.startsWith('site_')
    ? await env.DB.prepare("SELECT id, slug FROM sites WHERE id = ? AND kind = 'games'").bind(k).first<any>()
    : await env.DB.prepare("SELECT id, slug FROM sites WHERE (domain = ? OR slug = ?) AND kind = 'games'").bind(k, k).first<any>();
  const key = row?.slug ?? k;
  if (!isSlug(key)) return null;
  const site = await repo.readJson(env, sitePath(key));
  if (!site) {
    // Match a hand-made site by its domain.
    for (const d of await repo.listDirs(env, 'sites')) {
      const s = await repo.readJson(env, sitePath(d)).catch(() => null);
      if (s?.domain === k) return { key: d, path: sitePath(d), site: s, siteId: row?.id ?? null };
    }
    return null;
  }
  return { key, path: sitePath(key), site, siteId: row?.id ?? null };
}

export const pagesProjectOf = (ref: GamesSiteRef) => ref.site.pagesProject || projectName(ref.key);

// ---------- content (lists, reviews, mobile game pages, blog) ----------

export const defaultContentFrom = (env: Env) => {
  const v = (env.GAMES_CONTENT_FROM ?? 'torunex-site').trim();
  return v && v !== 'none' ? v : null;
};

/**
 * The `content` block for a site that reuses another site's content folder. The source's replaceNames
 * (raw text → source brand) are rewritten to the target's name, domain and contact email.
 */
export function contentFor(src: any, target: { name: string; domain: string; contactEmail?: string }) {
  const c = src?.content;
  if (!c) return null;
  const srcName = String(src.name ?? '');
  const srcDomain = String(src.domain ?? '').replace(/^www\./, '');
  const dom = target.domain.replace(/^www\./, '');
  const swap = (v: string) => {
    let out = v;
    if (src.contactEmail && target.contactEmail) out = out.split(src.contactEmail).join(target.contactEmail);
    if (srcDomain) out = out.split(srcDomain).join(dom);
    if (srcName) out = out.split(srcName.toUpperCase()).join(target.name.toUpperCase()).split(srcName).join(target.name);
    return out;
  };
  const replaceNames = Object.fromEntries(Object.entries(c.replaceNames ?? {}).map(([k, v]) => [k, swap(String(v))]));
  return { dir: c.dir || src.key, replaceNames, ...(c.excludeApps ? { excludeApps: c.excludeApps } : {}) };
}

/** Looks up the source site and returns the content block for `target`, or an error message. */
export async function contentFrom(env: Env, from: string, target: { name: string; domain: string; contactEmail?: string }): Promise<{ content: any } | { error: string }> {
  const ref = await resolveGamesSite(env, from);
  if (!ref) return { error: `content: no games site "${from}"` };
  const content = contentFor({ ...ref.site, key: ref.key }, target);
  if (!content) return { error: `content: ${ref.key} has no content (lists, reviews, blog) to copy` };
  return { content };
}
