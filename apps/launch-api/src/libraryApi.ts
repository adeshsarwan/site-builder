// Base topic library. Mounted under /api/v1 (bearer auth from the parent router).
//
//   GET    /me                       which key you used: { role: "admin" | "superadmin" }
//   GET    /library                  list topics (q, category, enabled, site → usedOnSite), with usage counts
//   GET    /library/:topicId         one topic + the sites that used it
//   POST   /library                  superadmin: add headlines (category / summary filled in by Claude if left out)
//   POST   /library/suggest          superadmin: Claude proposes new headlines that don't overlap; save: true adds them
//   PATCH  /library/:topicId         superadmin: edit title, summary, category, enabled, position
//   DELETE /library/:topicId         superadmin: remove a topic (stories already written from it stay)
//
// Topics only: a site never gets a topic's wording — Claude plans a new title and angle for that site.
import { Hono } from 'hono';
import type { Env } from './types';
import { CATEGORIES, classifyTitles, claudeJson } from './services/content';
import { addTopics, getTopic, listTopics, usageMap } from './services/library';

export type Role = 'admin' | 'superadmin';
type AppEnv = { Bindings: Env; Variables: { role: Role } };
export const library = new Hono<AppEnv>();

const superOnly = (c: any) => c.get('role') === 'superadmin' ? null
  : c.json({ error: c.env.SUPERADMIN_KEY ? 'Superadmin key required for this call' : 'Superadmin is not set up: run `wrangler secret put SUPERADMIN_KEY`' }, 403);
const bool = (v?: string) => (v === undefined ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const badCategory = (c: any, cat: string) => c.json({ error: `Unknown category "${cat}". Use one of: ${CATEGORIES.join(', ')}` }, 400);

library.get('/me', (c) => c.json({ role: c.get('role'), superadminConfigured: Boolean(c.env.SUPERADMIN_KEY) }));

library.get('/library', async (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase();
  const category = c.req.query('category');
  const enabled = bool(c.req.query('enabled'));
  const site = c.req.query('site');
  const usage = await usageMap(c.env);
  const all = await listTopics(c.env);
  let items = all.map((t) => ({ ...t, usedBy: usage.get(t.id) ?? [] }));
  if (q) items = items.filter((t) => `${t.title} ${t.summary} ${t.id}`.toLowerCase().includes(q));
  if (category) items = items.filter((t) => t.category === category);
  if (enabled !== undefined) items = items.filter((t) => t.enabled === enabled);
  return c.json({
    total: all.length,
    enabled: all.filter((t) => t.enabled).length,
    byCategory: Object.fromEntries(CATEGORIES.map((k) => [k, all.filter((t) => t.category === k).length])),
    categories: CATEGORIES,
    matched: items.length,
    topics: items.map((t) => (site ? { ...t, usedOnSite: t.usedBy.includes(site) } : t)),
  });
});

library.get('/library/:topicId', async (c) => {
  const t = await getTopic(c.env, c.req.param('topicId'));
  if (!t) return c.json({ error: 'topic not found' }, 404);
  return c.json({ ...t, usedBy: (await usageMap(c.env)).get(t.id) ?? [] });
});

// { "topics": ["Headline", { "title", "summary", "category", "enabled" }] }
library.post('/library', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as any;
  const raw: any[] = Array.isArray(b.topics) ? b.topics : Array.isArray(b) ? b : b.title ? [b] : [];
  const items = raw.map((t) => (typeof t === 'string' ? { title: t } : t)).filter((t) => String(t?.title ?? '').trim())
    .map((t) => ({ title: String(t.title).trim().slice(0, 160), summary: String(t.summary ?? '').trim().slice(0, 300), category: t.category ? String(t.category) : '', enabled: t.enabled }));
  if (!items.length) return c.json({ error: 'Send { "topics": ["Headline", { "title", "summary", "category" }] }' }, 400);
  if (items.length > 100) return c.json({ error: 'At most 100 topics per call' }, 400);
  const bad = items.find((t) => t.category && !CATEGORIES.includes(t.category));
  if (bad) return badCategory(c, bad.category);
  // Fill in a category and a one-line summary where they were left out.
  const need = items.filter((t) => !t.category || !t.summary);
  if (need.length) {
    const g = await classifyTitles(c.env, { domain: 'base library', name: 'the base topic library', niche: 'job seekers' }, need.map((t) => t.title));
    need.forEach((t, i) => { t.category ||= g[i].categorySlug; t.summary ||= g[i].angle; });
  }
  const out = await addTopics(c.env, items);
  return c.json(out, out.added.length ? 201 : 200);
});

// { "count": 10, "category": "interview-prep", "theme": "healthcare jobs", "save": false }
library.post('/library/suggest', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const b = (await c.req.json().catch(() => ({}))) as any;
  const count = Math.max(1, Math.min(50, Number(b.count ?? 10)));
  if (b.category && !CATEGORIES.includes(b.category)) return badCategory(c, b.category);
  const existing = await listTopics(c.env);
  const r = await claudeJson<{ items: any[] }>(
    c.env,
    'You build a topic library for career-advice websites. Each topic is a search-driven headline that many different sites could each write their own article about.',
    `Propose ${count} new topics${b.category ? ` in the category ${b.category}` : ''}${b.theme ? ` about: ${String(b.theme).slice(0, 300)}` : ''}.
Each: title (a clear headline, ≤ 90 characters), summary (one sentence on what the reader needs), category (${CATEGORIES.join(', ')}).
Do not duplicate or closely overlap these existing topics:
${existing.map((t) => `- ${t.title}`).join('\n')}
Submit exactly ${count} items.`,
    { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['title', 'summary', 'category'],
      properties: { title: { type: 'string' }, summary: { type: 'string' }, category: { type: 'string', enum: CATEGORIES } } } } } },
    800 + count * 120,
    `suggest ${count} library topics`,
  );
  const suggestions = (r.items ?? []).slice(0, count).map((t) => ({ title: String(t.title).slice(0, 160), summary: String(t.summary ?? ''), category: CATEGORIES.includes(t.category) ? t.category : CATEGORIES[0] }));
  if (!b.save) return c.json({ saved: false, suggestions, note: 'Nothing saved. POST the ones you want to /v1/library, or call again with "save": true.' });
  return c.json({ saved: true, ...(await addTopics(c.env, suggestions)) }, 201);
});

library.patch('/library/:topicId', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const id = c.req.param('topicId');
  const t = await getTopic(c.env, id);
  if (!t) return c.json({ error: 'topic not found' }, 404);
  const b = (await c.req.json().catch(() => ({}))) as any;
  if (b.category !== undefined && !CATEGORIES.includes(b.category)) return badCategory(c, b.category);
  if (b.title !== undefined && !String(b.title).trim()) return c.json({ error: 'title cannot be empty' }, 400);
  const next = {
    title: b.title !== undefined ? String(b.title).trim().slice(0, 160) : t.title,
    summary: b.summary !== undefined ? String(b.summary).trim().slice(0, 300) : t.summary,
    category: b.category ?? t.category,
    enabled: b.enabled !== undefined ? Boolean(b.enabled) : t.enabled,
    position: b.position !== undefined && Number.isFinite(Number(b.position)) ? Number(b.position) : t.position,
  };
  await c.env.DB.prepare("UPDATE library_topics SET title = ?, summary = ?, category = ?, enabled = ?, position = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(next.title, next.summary, next.category, next.enabled ? 1 : 0, next.position, id).run();
  return c.json({ ...(await getTopic(c.env, id)), changed: Object.keys(b).filter((k) => k in next) });
});

library.delete('/library/:topicId', async (c) => {
  const deny = superOnly(c); if (deny) return deny;
  const id = c.req.param('topicId');
  if (!(await getTopic(c.env, id))) return c.json({ error: 'topic not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM library_topics WHERE id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM library_usage WHERE topic_id = ?').bind(id),
  ]);
  return c.json({ deleted: id, note: 'Stories already written from this topic are not changed. To hide it without deleting, PATCH { "enabled": false }.' });
});
