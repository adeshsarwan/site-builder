import { STEPS, type Env, type LaunchInput, type SiteStatus, type StepKey, type StepStatus } from './types';

const now = () => new Date().toISOString();

export async function createSite(env: Env, id: string, slug: string, input: LaunchInput) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sites (id, domain, slug, name, status, input_json) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id, input.domain, slug, input.name ?? input.domain, 'queued', JSON.stringify(input),
    ),
    ...STEPS.map((s, i) => env.DB.prepare('INSERT INTO steps (site_id, key, position, label) VALUES (?, ?, ?, ?)').bind(id, s.key, i, s.label)),
    env.DB.prepare('INSERT INTO events (site_id, status, message) VALUES (?, ?, ?)').bind(id, 'queued', 'Launch requested'),
  ]);
}

export async function getSiteRow(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
}

export async function getStepRow(env: Env, id: string, key: StepKey) {
  return env.DB.prepare('SELECT * FROM steps WHERE site_id = ? AND key = ?').bind(id, key).first<any>();
}

export async function siteStatus(env: Env, id: string) {
  const site = await getSiteRow(env, id);
  if (!site) return null;
  const { results: steps } = await env.DB.prepare('SELECT * FROM steps WHERE site_id = ? ORDER BY position').bind(id).all<any>();
  const finished = steps.filter((s) => ['done', 'warning', 'skipped'].includes(s.status)).length;
  return {
    siteId: site.id,
    domain: site.domain,
    slug: site.slug,
    name: site.name,
    status: site.status as SiteStatus,
    progress: Math.round((finished / steps.length) * 100),
    currentStep: site.current_step,
    nameservers: site.nameservers ? JSON.parse(site.nameservers) : null,
    liveUrl: site.live_url,
    error: site.error,
    attempt: site.attempt,
    createdAt: site.created_at,
    updatedAt: site.updated_at,
    steps: steps.map((s) => ({
      key: s.key, label: s.label, status: s.status as StepStatus, detail: s.detail, startedAt: s.started_at, finishedAt: s.finished_at,
    })),
  };
}

export async function updateSite(env: Env, id: string, patch: Partial<{ status: SiteStatus; current_step: string | null; zone_id: string; nameservers: string; live_url: string; error: string | null; attempt: number; progress: number }>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await env.DB.prepare(`UPDATE sites SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...keys.map((k) => (patch as any)[k]), now(), id)
    .run();
}

export async function setStep(env: Env, id: string, key: StepKey, status: StepStatus, detail?: string | null, output?: unknown) {
  const ts = now();
  const sets = ['status = ?', 'detail = ?'];
  const vals: unknown[] = [status, detail ?? null];
  if (status === 'running') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(ts); }
  if (['done', 'warning', 'skipped', 'failed'].includes(status)) { sets.push('finished_at = ?'); vals.push(ts); }
  if (output !== undefined) { sets.push('output_json = ?'); vals.push(JSON.stringify(output)); }
  await env.DB.batch([
    env.DB.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE site_id = ? AND key = ?`).bind(...vals, id, key),
    env.DB.prepare('INSERT INTO events (site_id, step, status, message) VALUES (?, ?, ?, ?)').bind(id, key, status, detail ?? null),
    env.DB.prepare('UPDATE sites SET current_step = ?, updated_at = ? WHERE id = ?').bind(key, ts, id),
  ]);
}

export async function events(env: Env, id: string, afterId = 0) {
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE site_id = ? AND id > ? ORDER BY id LIMIT 200').bind(id, afterId).all<any>();
  return results;
}

/** Best-effort signed webhook with the full status document. */
export async function notify(env: Env, id: string) {
  const site = await getSiteRow(env, id);
  const url = site ? (JSON.parse(site.input_json) as LaunchInput).webhookUrl : undefined;
  if (!url) return;
  const body = JSON.stringify({ type: 'site.status', data: await siteStatus(env, id) });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.WEBHOOK_SECRET) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    headers['X-Launch-Signature'] = 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
  } catch {
    /* webhook failures never block a launch */
  }
}
