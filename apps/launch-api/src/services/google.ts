import type { Env } from '../types';

// Service-account OAuth (JWT bearer grant) using WebCrypto — no Node SDK needed in Workers.
const b64url = (data: ArrayBuffer | string) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function googleToken(env: Env, scopes: string[]): Promise<string> {
  if (!env.GCP_SA_JSON) throw new Error('GCP_SA_JSON secret is not set');
  const sa = JSON.parse(env.GCP_SA_JSON);
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: scopes.join(' '), aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Google token: ${body.error_description ?? body.error}`);
  return body.access_token;
}

async function g<T = any>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Google ${init.method ?? 'GET'} ${new URL(url).pathname} → ${res.status} ${body.error?.message ?? ''}`);
  return body as T;
}

const SV = 'https://www.googleapis.com/siteVerification/v1';
const SC = 'https://www.googleapis.com/webmasters/v3';
export const SCOPES_SEARCH = ['https://www.googleapis.com/auth/siteverification', 'https://www.googleapis.com/auth/webmasters'];
export const SCOPES_GA = ['https://www.googleapis.com/auth/analytics.edit'];

export async function getDnsVerificationToken(token: string, domain: string): Promise<string> {
  const r = await g<any>(token, `${SV}/token`, { method: 'POST', body: JSON.stringify({ site: { type: 'INET_DOMAIN', identifier: domain }, verificationMethod: 'DNS_TXT' }) });
  return r.token;
}

export async function verifyDomain(token: string, domain: string, extraOwners: string[]) {
  const res = await g<any>(token, `${SV}/webResource?verificationMethod=DNS_TXT`, {
    method: 'POST',
    body: JSON.stringify({ site: { type: 'INET_DOMAIN', identifier: domain } }),
  });
  if (extraOwners.length) {
    const owners = [...new Set([...(res.owners ?? []), ...extraOwners])];
    await g(token, `${SV}/webResource/${encodeURIComponent(res.id)}`, { method: 'PUT', body: JSON.stringify({ ...res, owners }) });
  }
  return res.id as string;
}

export async function addSearchConsoleProperty(token: string, domain: string) {
  const property = `sc-domain:${domain}`;
  await g(token, `${SC}/sites/${encodeURIComponent(property)}`, { method: 'PUT' });
  return property;
}

export async function submitSitemap(token: string, property: string, sitemapUrl: string) {
  await g(token, `${SC}/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`, { method: 'PUT' });
}

export async function createGa4(token: string, accountId: string, name: string, domain: string, timeZone = 'America/New_York') {
  const prop = await g<any>(token, 'https://analyticsadmin.googleapis.com/v1beta/properties', {
    method: 'POST',
    body: JSON.stringify({ parent: `accounts/${accountId}`, displayName: name, timeZone, currencyCode: 'USD' }),
  });
  const stream = await g<any>(token, `https://analyticsadmin.googleapis.com/v1beta/${prop.name}/dataStreams`, {
    method: 'POST',
    body: JSON.stringify({ type: 'WEB_DATA_STREAM', displayName: domain, webStreamData: { defaultUri: `https://${domain}` } }),
  });
  return { property: prop.name as string, measurementId: stream.webStreamData.measurementId as string };
}
