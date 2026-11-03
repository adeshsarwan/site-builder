import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { createSite, events, getSiteRow, siteStatus, updateSite } from './db';
import { ensureZone } from './services/cloudflare';
import { backfillImages } from './services/backfill';
import { manage } from './manage';
import { openapi } from './openapi';
import { stories } from './storiesApi';
import { funnels } from './funnelsApi';
import { library, type Role } from './libraryApi';
import { unknownIds } from './services/library';
import { slugFromDomain, type Env, type LaunchInput } from './types';

export { LaunchSiteWorkflow } from './workflow';
export { AddArticlesWorkflow } from './addArticles';

type AppEnv = { Bindings: Env & { ALLOWED_ORIGINS?: string }; Variables: { role: Role } };
// Served at https://sitebuilder.thebesads.com — the API lives under /api (e.g. /api/v1/sites).
const app = new Hono<AppEnv>();
const api = new Hono<AppEnv>();

api.use('/v1/*', async (c, next) => {
  const origins = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({ origin: origins.length ? origins : '*', allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] })(c, next);
});

// Bearer auth (constant-time compare). EventSource can't send headers, so ?key= is accepted on the events stream.
// API_KEY → role "admin" (everything except editing the base library); SUPERADMIN_KEY → role "superadmin" (everything).
const sameKey = (key: string, secret?: string) => {
  if (!secret) return false;
  const a = new TextEncoder().encode(key), b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
api.use('/v1/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  const key = header ?? (c.req.path.endsWith('/events') ? c.req.query('key') : undefined) ?? '';
  const isSuper = sameKey(key, c.env.SUPERADMIN_KEY);
  const isAdmin = sameKey(key, c.env.API_KEY);
  if (!isSuper && !isAdmin) return c.json({ error: 'unauthorized' }, 401);
  c.set('role', isSuper ? 'superadmin' : 'admin');
  return next();
});

api.get('/health', (c) => c.json({ ok: true }));

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

api.post('/v1/sites', async (c) => {
  const input = (await c.req.json().catch(() => null)) as LaunchInput | null;
  const domain = input?.domain?.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!input || !domain || !DOMAIN_RE.test(domain)) return c.json({ error: 'A valid "domain" is required, e.g. "jobsthe.world"' }, 400);
  if (input.generateArticles !== undefined && (input.generateArticles < 0 || input.generateArticles > 40)) return c.json({ error: 'generateArticles must be 0–40' }, 400);
  if (input.libraryTopics !== undefined) {
    if (!Array.isArray(input.libraryTopics) || input.libraryTopics.some((t) => typeof t !== 'string')) return c.json({ error: 'libraryTopics must be a list of topic ids (GET /v1/library)' }, 400);
    const unknown = await unknownIds(c.env, input.libraryTopics);
    if (unknown.length) return c.json({ error: `Unknown library topic ids: ${unknown.slice(0, 10).join(', ')}` }, 400);
  }
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

// Add fresh articles to a live site from more library topics (and/or new topics), then redeploy.
api.post('/v1/sites/:id/articles', async (c) => {
  const p = c.req.param('id').toLowerCase();
  const row = p.startsWith('site_')
    ? await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(p).first<any>()
    : await c.env.DB.prepare('SELECT * FROM sites WHERE domain = ?').bind(p).first<any>();
  if (!row) return c.json({ error: 'not found — launch the site first' }, 404);
  const launched = JSON.parse(row.input_json) as LaunchInput;
  const body = (await c.req.json().catch(() => ({}))) as { fromTopic?: number; count?: number; extra?: number };
  const fromTopic = Math.max(0, Number(body.fromTopic ?? launched.libraryLimit ?? 0));
  const count = Math.max(0, Math.min(80, Number(body.count ?? 0)));
  const extra = Math.max(0, Math.min(40, Number(body.extra ?? 0)));
  const instance = await c.env.CONTENT.create({
    id: `articles-${row.slug}-${Date.now()}`,
    params: { siteSlug: row.slug, input: { ...launched, name: launched.name ?? row.name, domain: row.domain }, fromTopic, count, extra },
  });
  return c.json({ taskId: instance.id, site: row.slug, fromTopic, count: count || 'all remaining', extra, statusUrl: `/api/v1/tasks/${instance.id}` }, 202);
});

api.get('/v1/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<any>().catch(() => null);
  const items = task ? (await c.env.DB.prepare('SELECT idx, title, slug, category, status, error, updated_at FROM task_items WHERE task_id = ? ORDER BY idx').bind(id).all()).results : [];
  let workflow: any = null;
  try { workflow = await (await c.env.CONTENT.get(id)).status(); } catch { /* not found */ }
  if (!task && !workflow) return c.json({ error: 'not found' }, 404);
  const done = items.filter((i: any) => ['written', 'published', 'failed'].includes(i.status)).length;
  return c.json({
    taskId: id,
    site: task?.site_slug ?? null,
    kind: task?.kind ?? 'add',
    status: workflow?.status === 'errored' ? 'failed' : task?.status ?? workflow?.status,
    progress: items.length ? Math.round((done / items.length) * 100) : 0,
    total: task?.total ?? items.length, written: task?.written ?? 0, failed: task?.failed ?? 0,
    deploy: task?.run_key ? { runKey: task.run_key, statusUrl: `/api/v1/deploys/${task.run_key}` } : null,
    stories: items,
    error: task?.error ?? workflow?.error ?? null,
    workflow: workflow ? { status: workflow.status, output: workflow.output ?? null } : null,
  });
});

// Add photos to articles that have none, then redeploy the site.
api.post('/v1/sites/:id/images', async (c) => {
  const p = c.req.param('id').toLowerCase();
  const row = p.startsWith('site_')
    ? await c.env.DB.prepare('SELECT slug FROM sites WHERE id = ?').bind(p).first<any>()
    : await c.env.DB.prepare('SELECT slug FROM sites WHERE domain = ?').bind(p).first<any>();
  const slug = row?.slug ?? slugFromDomain(p);
  try {
    const limit = Math.max(0, Math.min(5, Number(c.req.query('limit') ?? 2)));
    const deploy = c.req.query('deploy') !== '0';
    return c.json({ site: slug, ...(await backfillImages(c.env, slug, limit, deploy)) });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
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

api.route('/v1', manage);
api.route('/v1', stories);
api.route('/v1', funnels);
api.route('/v1', library);
api.get('/openapi.json', (c) => c.json(openapi));
app.route('/api', api);
app.get('/', (c) => c.json({ service: 'site-builder launch API', docs: 'https://github.com/adeshsarwan/site-builder/blob/main/docs/API.md', openapi: '/api/openapi.json', api: '/api/v1/sites' }));

export default app;
