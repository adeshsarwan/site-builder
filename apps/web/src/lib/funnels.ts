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
