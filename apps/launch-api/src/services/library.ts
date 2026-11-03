// Base topic library (D1: library_topics, library_usage). Only headlines, one-line summaries and
// categories are kept — every site writes its own fresh story from a topic, so no text is shared.
import type { Env } from '../types';
import { slugify, type Topic } from './content';

export interface LibraryTopic { id: string; title: string; summary: string; category: string; enabled: boolean; position: number; created_at?: string; updated_at?: string }

const row = (r: any): LibraryTopic => ({ id: r.id, title: r.title, summary: r.summary ?? '', category: r.category, enabled: Boolean(r.enabled), position: Number(r.position), created_at: r.created_at, updated_at: r.updated_at });
export const asTopic = (t: LibraryTopic): Topic & { id: string } => ({ id: t.id, title: t.title, summary: t.summary, categorySlug: t.category });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function listTopics(env: Env, opts: { enabledOnly?: boolean } = {}): Promise<LibraryTopic[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM library_topics ${opts.enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY position, created_at`).all();
  return results.map(row);
}

export async function getTopic(env: Env, id: string) {
  const r = await env.DB.prepare('SELECT * FROM library_topics WHERE id = ?').bind(id).first<any>();
  return r ? row(r) : null;
}

/** topic id → sites that have written from it. */
export async function usageMap(env: Env): Promise<Map<string, string[]>> {
  const { results } = await env.DB.prepare('SELECT topic_id, site_slug FROM library_usage ORDER BY used_at').all<any>();
  const m = new Map<string, string[]>();
  for (const r of results) m.set(r.topic_id, [...(m.get(r.topic_id) ?? []), r.site_slug]);
  return m;
}

export async function usedBySite(env: Env, siteSlug: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare('SELECT topic_id FROM library_usage WHERE site_slug = ?').bind(siteSlug).all<any>();
  return new Set(results.map((r) => r.topic_id));
}

export async function recordUsage(env: Env, siteSlug: string, topicIds: string[], taskId?: string) {
  if (!topicIds.length) return;
  await env.DB.batch(topicIds.map((id) => env.DB.prepare('INSERT OR IGNORE INTO library_usage (topic_id, site_slug, task_id) VALUES (?, ?, ?)').bind(id, siteSlug, taskId ?? null)));
}

/** Ids in `ids` that are not in the library. */
export async function unknownIds(env: Env, ids: string[]) {
  const known = new Set((await listTopics(env)).map((t) => t.id));
  return ids.filter((id) => !known.has(id));
}

/**
 * Which library topics a site should write from:
 *  - `ids`: exactly these, in this order (disabled ones too — you asked for them);
 *  - `fromPosition`: the old index-based slice (enabled topics in order, starting at that index);
 *  - otherwise: enabled topics this site hasn't used yet, in library order. A site launched before usage
 *    was tracked has no usage rows, so its first `legacySkip` topics (its launch's libraryLimit) count as used.
 * `count` caps the result (0/undefined = all).
 */
export async function pickTopics(env: Env, siteSlug: string, o: { ids?: string[]; count?: number; fromPosition?: number; legacySkip?: number }) {
  const all = await listTopics(env);
  let out: LibraryTopic[];
  if (o.ids?.length) {
    const byId = new Map(all.map((t) => [t.id, t]));
    out = o.ids.map((id) => byId.get(id)).filter((t): t is LibraryTopic => Boolean(t));
  } else {
    const enabled = all.filter((t) => t.enabled);
    if (o.fromPosition !== undefined) out = enabled.slice(o.fromPosition);
    else {
      const used = await usedBySite(env, siteSlug);
      out = used.size ? enabled.filter((t) => !used.has(t.id)) : enabled.slice(o.legacySkip ?? 0);
    }
  }
  return (o.count ? out.slice(0, o.count) : out).map(asTopic);
}

/** Adds topics, skipping ones whose id or headline already exists. */
export async function addTopics(env: Env, items: { title: string; summary: string; category: string; enabled?: boolean }[]) {
  const all = await listTopics(env);
  const ids = new Set(all.map((t) => t.id));
  const titles = new Map(all.map((t) => [norm(t.title), t.id]));
  let pos = all.reduce((m, t) => Math.max(m, t.position), -1);
  const added: LibraryTopic[] = [];
  const skipped: { title: string; reason: string; existingId?: string }[] = [];
  for (const it of items) {
    const dup = titles.get(norm(it.title));
    if (dup) { skipped.push({ title: it.title, reason: 'same headline already in the library', existingId: dup }); continue; }
    const base = slugify(it.title) || `topic-${Date.now().toString(36)}`;
    let id = base, n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    ids.add(id);
    titles.set(norm(it.title), id);
    const t: LibraryTopic = { id, title: it.title, summary: it.summary, category: it.category, enabled: it.enabled !== false, position: ++pos };
    added.push(t);
  }
  if (added.length) await env.DB.batch(added.map((t) => env.DB.prepare('INSERT INTO library_topics (id, title, summary, category, enabled, position) VALUES (?, ?, ?, ?, ?, ?)').bind(t.id, t.title, t.summary, t.category, t.enabled ? 1 : 0, t.position)));
  return { added, skipped };
}
