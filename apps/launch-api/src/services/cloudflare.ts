import type { Env } from '../types';

const API = 'https://api.cloudflare.com/client/v4';

async function cf<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const msg = body.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${path} → ${res.status} ${msg}`);
  }
  return body.result as T;
}

export interface Zone { id: string; name: string; status: string; name_servers: string[] }

export async function findZone(env: Env, domain: string): Promise<Zone | null> {
  const zones = await cf<Zone[]>(env, `/zones?name=${encodeURIComponent(domain)}&account.id=${env.CF_ACCOUNT_ID}`);
  return zones[0] ?? null;
}

export async function ensureZone(env: Env, domain: string): Promise<Zone> {
  return (await findZone(env, domain)) ?? cf<Zone>(env, '/zones', {
    method: 'POST',
    body: JSON.stringify({ name: domain, account: { id: env.CF_ACCOUNT_ID }, type: 'full' }),
  });
}

export async function zoneStatus(env: Env, zoneId: string): Promise<Zone> {
  return cf<Zone>(env, `/zones/${zoneId}`);
}

export async function requestActivationCheck(env: Env, zoneId: string) {
  try { await cf(env, `/zones/${zoneId}/activation_check`, { method: 'PUT' }); } catch { /* rate-limited; harmless */ }
}

export async function upsertDns(env: Env, zoneId: string, rec: { type: string; name: string; content: string; proxied?: boolean; ttl?: number }) {
  const existing = await cf<any[]>(env, `/zones/${zoneId}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`);
  const same = existing.find((r) => r.content === rec.content || (rec.type !== 'TXT'));
  const body = JSON.stringify({ ttl: 1, ...rec });
  if (same && rec.type !== 'TXT') return cf(env, `/zones/${zoneId}/dns_records/${same.id}`, { method: 'PUT', body });
  if (existing.some((r) => r.content === rec.content || r.content === `"${rec.content}"`)) return existing[0];
  return cf(env, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
}

/**
 * Removes the old website records (A, AAAA, CNAME) for the given hostnames so the new site can take over.
 * MX, TXT and other records are left alone, so email and verifications keep working.
 * Returns what was deleted (for the launch log).
 */
export async function clearWebRecords(env: Env, zoneId: string, hostnames: string[]) {
  const deleted: string[] = [];
  for (const name of hostnames) {
    for (const type of ['A', 'AAAA', 'CNAME']) {
      const recs = await cf<any[]>(env, `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
      for (const r of recs) {
        if (r.meta?.read_only) continue; // managed by another Worker/Pages custom domain; override flag handles it
        await cf(env, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
        deleted.push(`${type} ${name} → ${r.content}`);
      }
    }
  }
  return deleted;
}

/** Attach a hostname to a Worker. Cloudflare creates the DNS record and edge certificate. */
export async function attachWorkerDomain(env: Env, zoneId: string, hostname: string, service: string) {
  return cf(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({ environment: 'production', hostname, service, zone_id: zoneId, override_existing_dns_record: true, override_existing_origin: true }),
  });
}

export async function workerExists(env: Env, name: string) {
  try {
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${name}/settings`);
    return true;
  } catch {
    return false;
  }
}

/** www → apex permanent redirect via a Single Redirect rule. */
export async function wwwRedirect(env: Env, zoneId: string, domain: string) {
  await upsertDns(env, zoneId, { type: 'AAAA', name: `www.${domain}`, content: '100::', proxied: true });
  return cf(env, `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({
      rules: [{
        description: 'www to apex',
        expression: `(http.host eq "www.${domain}")`,
        action: 'redirect',
        action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("https://${domain}", http.request.uri.path)` } } },
      }],
    }),
  });
}
