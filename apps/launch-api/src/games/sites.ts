// Games portal helpers shared by the API and the launch workflow.
import type { Env } from '../types';
import { slugFromDomain } from '../types';
import * as repo from './repo';
import { projectName } from './pages';

/** Launch steps of a games portal (stored per site in D1 like the jobs steps). */
export const GAMES_STEPS = [
  { key: 'zone', label: 'Domain on Cloudflare' },
  { key: 'nameservers', label: 'Waiting for nameservers' },
  { key: 'analytics', label: 'Create GA4 property' },
  { key: 'repo', label: 'Write site.json to GitHub' },
  { key: 'pages', label: 'Create Cloudflare Pages project' },
  { key: 'deploy', label: 'Build & deploy' },
  { key: 'custom_domain', label: 'Attach domain + SSL' },
  { key: 'search_console', label: 'Verify Search Console + sitemap' },
  { key: 'ads', label: 'Ads (test ads until stage 2)' },
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
  name?: string;
  tagline?: string;
  description?: string;
  language?: string;
  theme?: Record<string, string>;
  /** Shortcut for theme.accent. */
  primaryColor?: string;
  logo?: { text?: string; mark?: string };
  /** "all" (default) or a list of game slugs. */
  games?: 'all' | string[];
  exclude?: string[];
  featured?: string[];
  /** Categories shown on this site, in order (default: every category its games use). */
  categories?: string[];
  contactEmail?: string;
  adsTxt?: string[];
  networkCode?: string;
  /** Use an existing GA4 web stream instead of creating a property. */
  ga4MeasurementId?: string;
  webhookUrl?: string;
}

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
  return {
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
      mode: 'test',
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
    analytics: { ga4: input.ga4MeasurementId ?? '' },
  };
}

/** Games a site shows, the same way build.mjs picks them. */
export function siteGames(site: any, catalog: Game[]) {
  let list = site.games === 'all' || !Array.isArray(site.games) ? catalog : catalog.filter((g) => site.games.includes(g.slug));
  return list.filter((g) => g.title && !g.disabled && !(site.exclude ?? []).includes(g.slug));
}

/** The ad units a game gets on a site, the same way functions/play resolves them. */
export function unitsFor(site: any, slug: string) {
  const a = site.ads ?? {};
  if (a.mode === 'test' || !site.domain) return { source: 'test', units: { rewarded: '/22639388115/rewarded_web_example', interstitial: '/6355419/Travel/Europe/France/Paris', native: '/6355419/Travel/Europe/France/Paris' } };
  const own = a.games?.[slug];
  if (own?.rewarded && own?.interstitial && own?.native) return { source: 'site', units: own };
  const game = slug.replace(/-/g, '_');
  const make = (kind: string) => String(a.gameUnitPattern ?? '').replace('{network}', a.networkCode).replace('{domain}', site.domain).replace('{game}', game).replace('{kind}', kind);
  return { source: 'pattern (unless an R2 ads.json exists)', units: { rewarded: make('rewarded'), interstitial: make('interstitial'), native: make('native') } };
}

export function siteUnit(site: any, slot: string) {
  const a = site.ads ?? {};
  if (a.mode === 'test' || !site.domain) return '/6355419/Travel/Europe/France/Paris';
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
