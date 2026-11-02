import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { createSite, events, getSiteRow, siteStatus, updateSite } from './db';
import { ensureZone } from './services/cloudflare';
import { slugFromDomain, type Env, type LaunchInput } from './types';

export { LaunchSiteWorkflow } from './workflow';

type AppEnv = { Bindings: Env & { ALLOWED_ORIGINS?: string } };
// Served at https://sitebuilder.thebesads.com — the API lives under /api (e.g. /api/v1/sites).
const app = new Hono<AppEnv>();
const api = new Hono<AppEnv>();

api.use('/v1/*', async (c, next) => {
  const origins = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({ origin: origins.length ? origins : '*', allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'], allowMethods: ['GET', 'POST', 'OPTIONS'] })(c, next);
});

// Bearer auth (constant-time compare). EventSource can't send headers, so ?key= is accepted on the events stream.
api.use('/v1/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  const key = header ?? (c.req.path.endsWith('/events') ? c.req.query('key') : undefined) ?? '';
  const a = new TextEncoder().encode(key), b = new TextEncoder().encode(c.env.API_KEY ?? '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (!c.env.API_KEY || diff !== 0) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

api.get('/health', (c) => c.json({ ok: true }));

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

api.post('/v1/sites', async (c) => {
  const input = (await c.req.json().catch(() => null)) as LaunchInput | null;
  const domain = input?.domain?.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!input || !domain || !DOMAIN_RE.test(domain)) return c.json({ error: 'A valid "domain" is required, e.g. "jobsthe.world"' }, 400);
  if (input.generateArticles !== undefined && (input.generateArticles < 0 || input.generateArticles > 40)) return c.json({ error: 'generateArticles must be 0–40' }, 400);
  input.domain = domain;
  input.name ??= domain;

  const existing = await c.env.DB.prepare('SELECT id FROM sites WHERE domain = ?').bind(domain).first<any>();
  if (existing) return c.json({ error: 'This domain already has a launch', ...(await siteStatus(c.env, existing.id)) }, 409);

  const siteId = `site_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const slug = slugFromDomain(domain);
  await createSite(c.env, siteId, slug, input);

  // Create the zone right away so the response can include the nameservers to set at the registrar.
  if (c.env.DRY_RUN !== 'true') {
    try {
      const z = await ensureZone(c.env, domain);
      await updateSite(c.env, siteId, { zone_id: z.id, nameservers: JSON.stringify(z.name_servers) });
    } catch (e: any) {
      await c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(siteId).run();
      return c.json({ error: `Could not add ${domain} to Cloudflare: ${e.message}` }, 502);
    }
  }

  await c.env.LAUNCH.create({ id: `${siteId}-1`, params: { siteId, attempt: 1 } });
  const status = await siteStatus(c.env, siteId);
  return c.json({ ...status, statusUrl: `/api/v1/sites/${siteId}`, eventsUrl: `/api/v1/sites/${siteId}/events` }, 202);
});

api.get('/v1/sites', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, domain, name, status, current_step, live_url, created_at, updated_at FROM sites ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ sites: results });
});

const resolveId = async (env: Env, idOrDomain: string) =>
  idOrDomain.startsWith('site_') ? idOrDomain : (await env.DB.prepare('SELECT id FROM sites WHERE domain = ?').bind(idOrDomain.toLowerCase()).first<any>())?.id;

api.get('/v1/sites/:id', async (c) => {
  const id = await resolveId(c.env, c.req.param('id'));
  const s = id && (await siteStatus(c.env, id));
  return s ? c.json(s) : c.json({ error: 'not found' }, 404);
});

// Live progress as Server-Sent Events: `event: step` for each change, `event: status` with the full document.
api.get('/v1/sites/:id/events', async (c) => {
  const id = await resolveId(c.env, c.req.param('id'));
  if (!id || !(await getSiteRow(c.env, id))) return c.json({ error: 'not found' }, 404);
  let last = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0;
  return streamSSE(c, async (stream) => {
    const started = Date.now();
    await stream.writeSSE({ event: 'status', data: JSON.stringify(await siteStatus(c.env, id)) });
    while (Date.now() - started < 10 * 60_000 && !stream.aborted) {
      const evs = await events(c.env, id, last);
      for (const e of evs) {
        last = e.id;
        await stream.writeSSE({ id: String(e.id), event: 'step', data: JSON.stringify({ step: e.step, status: e.status, message: e.message, ts: e.ts }) });
      }
      if (evs.length) {
        const s = await siteStatus(c.env, id);
        await stream.writeSSE({ event: 'status', data: JSON.stringify(s) });
        if (s && ['live', 'live_with_warnings', 'failed'].includes(s.status)) break;
      }
      await stream.sleep(2000);
    }
  });
});

// Resume a failed launch: finished steps are skipped, the failed step runs again.
api.post('/v1/sites/:id/retry', async (c) => {
  const id = await resolveId(c.env, c.req.param('id'));
  const site = id && (await getSiteRow(c.env, id));
  if (!site) return c.json({ error: 'not found' }, 404);
  if (site.status !== 'failed') return c.json({ error: `Only failed launches can be retried (status: ${site.status})` }, 409);
  const attempt = site.attempt + 1;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE steps SET status = 'pending', detail = NULL WHERE site_id = ? AND status IN ('failed','running','waiting')").bind(id),
    c.env.DB.prepare("UPDATE sites SET status = 'queued', error = NULL, attempt = ? WHERE id = ?").bind(attempt, id),
  ]);
  await c.env.LAUNCH.create({ id: `${id}-${attempt}`, params: { siteId: id, attempt } });
  return c.json(await siteStatus(c.env, id), 202);
});

app.route('/api', api);
app.get('/', (c) => c.json({ service: 'site-builder launch API', docs: 'https://github.com/adeshsarwan/site-builder#launch-api', api: '/api/v1/sites' }));

export default app;
