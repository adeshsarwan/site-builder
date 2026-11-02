import { site, type Funnel } from './site';

export const funnelCookie = (id: string) => `fn_${id.replace(/[^a-z0-9_-]/gi, '')}`;

export function funnelForPath(pathname: string): Funnel | undefined {
  return site.funnels.find((f) => f.gate.some((g) => pathname === g || pathname.startsWith(g.endsWith('/') ? g : g + '/')));
}

export const getFunnel = (id: string) => site.funnels.find((f) => f.id === id);

/** Answers are stored as base64url JSON in a cookie the server can read. */
export function encodeAnswers(a: Record<string, string>) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(a)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeAnswers(v?: string): Record<string, string> | null {
  if (!v) return null;
  try {
    const b = v.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch {
    return null;
  }
}

/** Only keep answers that are valid options of the funnel. */
export function sanitizeAnswers(f: Funnel, input: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const s of f.steps) {
    const v = String(input[s.key] ?? '');
    if (s.options.some((o) => o.value === v)) out[s.key] = v;
  }
  return out;
}

export const safeNext = (next: string | null | undefined, fallback = '/') =>
  next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;

// ---------- on-page gates ----------
/** Pages that are never gated (trust pages, the funnels themselves, machine files). */
const NEVER = [/^\/(about|contact|privacy|terms|404)$/, /^\/start(\/|$)/, /^\/api\//, /^\/(ads|robots)\.txt$/, /^\/sitemap/, /^\/logos\//];
const norm = (p: string) => { const x = p.replace(/\.html$/, '').replace(/\/index$/, '/'); return (x.length > 1 ? x.replace(/\/+$/, '') : x) || '/'; };

export function pageMatches(pattern: string, path: string) {
  const pat = norm(pattern.trim());
  const p = norm(path);
  if (pat === '*') return true;
  if (pat.endsWith('/*')) { const base = pat.slice(0, -2) || '/'; return base === '/' ? true : p === base || p.startsWith(base + '/'); }
  return p === pat;
}

/** The first enabled funnel whose `pages` include this path (and don't exclude it). */
export function gateFunnelFor(path: string): Funnel | undefined {
  if (NEVER.some((r) => r.test(norm(path)))) return undefined;
  return site.funnels.find((f) => {
    if (f.enabled === false || !f.pages?.length || !f.steps?.length) return false;
    const inc = f.pages.filter((x) => !x.startsWith('!'));
    const exc = f.pages.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
    return inc.some((x) => pageMatches(x, path)) && !exc.some((x) => pageMatches(x, path));
  });
}
