// GA4 for H5 games portals: find or create the property + web stream, then configure it for the engagement
// events every portal sends (h5-games-site-builder src/app.js). Everything here is idempotent: running it again
// only adds what is missing, so a retried launch never makes a second property.
import type { Env } from '../types';
import * as google from '../services/google';

const ADM = 'https://analyticsadmin.googleapis.com/v1beta';

/** Event parameters reported as custom dimensions (event scope). Keep in sync with src/app.js in the builder repo. */
export const GA_DIMENSIONS: [param: string, description: string][] = [
  ['game', 'H5 game slug (game_start, game_time, game_exit, game_click)'],
  ['placement', 'Section of the page the click came from (similar_games, trending, search…)'],
  ['page_type', 'Type of page (home, game, list, app, category)'],
  ['app_name', 'Play Store game clicked (store_click)'],
  ['list', 'Best-of list (list_view, list_click)'],
  ['source', 'Which Play button started the game'],
  ['view', 'mobile or desktop layout'],
  ['ad_slot', 'Native ad slot id (ad_filled, ad_empty)'],
];
/** Numeric event parameters reported as custom metrics. */
export const GA_METRICS: [param: string, unit: 'STANDARD' | 'SECONDS', description: string][] = [
  ['seconds_played', 'SECONDS', 'Total and average play time per game (game_exit)'],
  ['list_position', 'STANDARD', 'Average list rank of Play Store clicks (store_click)'],
];
/** Events marked as key events (importable into Google Ads as conversions). */
export const GA_KEY_EVENTS = ['game_start', 'store_click'];

export const gaTimeZone = (env: Env) => env.GA4_TIME_ZONE || 'Asia/Singapore';
export const gaConfigured = (env: Env) => Boolean(env.GA4_ACCOUNT_ID && env.GCP_SA_JSON);
export const gaToken = (env: Env) => google.googleToken(env, google.SCOPES_GA);

async function listAll<T = any>(token: string, url: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let page = '';
  for (let i = 0; i < 20; i++) {
    const r = await google.g<any>(token, `${url}${url.includes('?') ? '&' : '?'}pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    out.push(...(r[key] ?? []));
    if (!(page = r.nextPageToken)) break;
  }
  return out;
}

const host = (u?: string) => { try { return new URL(u ?? '').hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
export const normProperty = (p: string) => (/^\d+$/.test(p) ? `properties/${p}` : p);

export interface Ga4Ref { property: string; measurementId: string }

/**
 * Finds the property in the account whose web stream has this Measurement ID, or (without one) whose web stream
 * points at this domain. Properties named like the site are checked first, so a lookup is usually a few calls.
 */
export async function findGa4(token: string, accountId: string, q: { measurementId?: string; domain?: string; names?: string[] }): Promise<Ga4Ref | null> {
  const props = await listAll<any>(token, `${ADM}/properties?filter=${encodeURIComponent(`parent:accounts/${accountId}`)}`, 'properties');
  const names = (q.names ?? []).filter(Boolean).map((n) => n.toLowerCase());
  const domain = (q.domain ?? '').replace(/^www\./, '').toLowerCase();
  const likely = (p: any) => names.includes(String(p.displayName).toLowerCase()) || (domain && String(p.displayName).toLowerCase().includes(domain));
  const ordered = [...props.filter(likely), ...props.filter((p) => !likely(p))];
  for (const p of ordered) {
    const streams = await listAll<any>(token, `${ADM}/${p.name}/dataStreams`, 'dataStreams');
    for (const s of streams) {
      const mid = s.webStreamData?.measurementId;
      if (!mid) continue;
      if (q.measurementId ? mid === q.measurementId : domain && host(s.webStreamData.defaultUri) === domain) return { property: p.name, measurementId: mid };
    }
  }
  return null;
}

/** Existing property for the domain, or a new one (property + web stream). */
export async function ensureGa4(env: Env, token: string, domain: string, name: string): Promise<Ga4Ref & { created: boolean }> {
  const found = await findGa4(token, env.GA4_ACCOUNT_ID!, { domain, names: [name, domain] });
  if (found) return { ...found, created: false };
  const r = await google.createGa4(token, env.GA4_ACCOUNT_ID!, name, domain, gaTimeZone(env));
  return { ...r, created: true };
}

export interface Ga4Setup {
  dimensions: { created: string[]; existing: string[] };
  metrics: { created: string[]; existing: string[] };
  keyEvents: { created: string[]; existing: string[] };
  retention: string;
  errors: string[];
}

/** Adds whatever is missing: custom dimensions/metrics, key events, 14-month retention. Never deletes anything. */
export async function configureGa4(token: string, propertyIn: string): Promise<Ga4Setup> {
  const property = normProperty(propertyIn);
  const out: Ga4Setup = { dimensions: { created: [], existing: [] }, metrics: { created: [], existing: [] }, keyEvents: { created: [], existing: [] }, retention: '', errors: [] };
  const post = (path: string, body: unknown) => google.g(token, `${ADM}/${property}/${path}`, { method: 'POST', body: JSON.stringify(body) });
  const tryDo = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); return true; } catch (e: any) { out.errors.push(`${label}: ${e.message}`); return false; } };

  const dims = new Set((await listAll<any>(token, `${ADM}/${property}/customDimensions`, 'customDimensions')).map((d) => d.parameterName));
  for (const [param, description] of GA_DIMENSIONS) {
    if (dims.has(param)) { out.dimensions.existing.push(param); continue; }
    if (await tryDo(`dimension ${param}`, () => post('customDimensions', { parameterName: param, displayName: param, description, scope: 'EVENT' }))) out.dimensions.created.push(param);
  }
  const mets = new Set((await listAll<any>(token, `${ADM}/${property}/customMetrics`, 'customMetrics')).map((m) => m.parameterName));
  for (const [param, unit, description] of GA_METRICS) {
    if (mets.has(param)) { out.metrics.existing.push(param); continue; }
    if (await tryDo(`metric ${param}`, () => post('customMetrics', { parameterName: param, displayName: param, description, scope: 'EVENT', measurementUnit: unit }))) out.metrics.created.push(param);
  }
  const keys = new Set((await listAll<any>(token, `${ADM}/${property}/keyEvents`, 'keyEvents')).map((k) => k.eventName));
  for (const ev of GA_KEY_EVENTS) {
    if (keys.has(ev)) { out.keyEvents.existing.push(ev); continue; }
    if (await tryDo(`key event ${ev}`, () => post('keyEvents', { eventName: ev, countingMethod: 'ONCE_PER_EVENT' }))) out.keyEvents.created.push(ev);
  }
  await tryDo('data retention', async () => {
    const r = await google.g<any>(token, `${ADM}/${property}/dataRetentionSettings?updateMask=event_data_retention,user_data_retention`, {
      method: 'PATCH', body: JSON.stringify({ eventDataRetention: 'FOURTEEN_MONTHS', userDataRetention: 'FOURTEEN_MONTHS' }),
    });
    out.retention = r.eventDataRetention ?? 'FOURTEEN_MONTHS';
  });
  return out;
}

export const setupSummary = (s: Ga4Setup) =>
  `${s.dimensions.created.length + s.dimensions.existing.length}/${GA_DIMENSIONS.length} dimensions, ${s.metrics.created.length + s.metrics.existing.length}/${GA_METRICS.length} metrics, ` +
  `${s.keyEvents.created.length + s.keyEvents.existing.length}/${GA_KEY_EVENTS.length} key events, retention ${s.retention ? '14 months' : 'not set'}` +
  (s.errors.length ? ` · ${s.errors.length} error(s): ${s.errors.join('; ')}` : '');
