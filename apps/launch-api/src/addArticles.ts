import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, LaunchInput } from './types';
import * as gh from './services/github';
import { planArticles, writeArticle, toMarkdown, topicFromMarkdown, classifyTitles, slugify, CATEGORIES, type ArticlePlan, type Topic, type HeroImage } from './services/content';
import { articlesDir, parseStory, serializeStory } from './services/stories';
import { pickTopics, recordUsage } from './services/library';

export interface StoryRequest { title: string; category?: string; angle?: string; slug?: string }

export interface AddArticlesParams {
  siteSlug: string;
  input: LaunchInput;          // name, domain, niche, country
  kind?: 'add' | 'rewrite';
  /** Base library topics (D1). `topics`: exact ids. Otherwise the ones this site hasn't used yet; `fromTopic` = old
   *  index-based slice; `legacySkip` = topics a site launched before usage tracking already used. `count` 0 = all. null = none. */
  library?: { topics?: string[]; fromTopic?: number; legacySkip?: number; count: number } | null;
  /** Old shape (kept for compatibility): same as library + extra. */
  fromTopic?: number;
  count?: number;
  extra?: number;              // brand-new topics Claude picks for the audience
  ideas?: string[];            // short briefs; Claude turns each into a fresh title + angle
  stories?: StoryRequest[];    // exact titles to write (kept as given); for kind=rewrite, slug is required
  instructions?: string;       // extra guidance for the writer (tone, must-cover points)
  draft?: boolean;             // write as drafts (hidden until PATCHed to draft:false)
  deploy?: boolean;            // default true
}

/**
 * Writes stories for a live site, one by one, and commits them in small batches:
 *   1. read-site   existing titles/slugs (so nothing overlaps) + the library topics asked for
 *   2. plan        library topics / ideas / extra → fresh titles; own titles → category + angle
 *   3. article-N   each story written on its own (3 retries); 4 run in parallel
 *   4. commit-N    every batch of 4 committed, so progress survives a later failure
 *   5. deploy      one deploy at the end; the deploy also adds a photo to every story without one
 * Progress per story is kept in D1 (tasks / task_items) for GET /v1/tasks/:id.
 */
export class AddArticlesWorkflow extends WorkflowEntrypoint<Env, AddArticlesParams> {
  async run(event: WorkflowEvent<AddArticlesParams>, step: WorkflowStep) {
    const env = this.env;
    const p = event.payload;
    const taskId = event.instanceId;
    const { siteSlug, input } = p;
    const kind = p.kind ?? 'add';
    const library = p.library !== undefined ? p.library : { fromTopic: p.fromTopic ?? 0, count: p.count ?? 0 };
    const base = articlesDir(siteSlug);
    const track = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run().catch(() => null);
    const setTask = (status: string, extra = '') => track(`UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${extra} WHERE id = ?`, status, taskId);
    const setItem = (idx: number, status: string, error: string | null = null) =>
      track("UPDATE task_items SET status = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id = ? AND idx = ?", status, error, taskId, idx);

    await step.do('start', async () => {
      await track('INSERT OR IGNORE INTO tasks (id, site_slug, kind) VALUES (?, ?, ?)', taskId, siteSlug, kind);
      await setTask('planning');
    });

    const ctx = await step.do('read-site', async () => {
      const existing = await gh.listTree(env, base);
      const titles: string[] = [];
      const keep: Record<string, { pubDate: string | null; hero: HeroImage | null; draft: boolean }> = {};
      const rewriteSlugs = new Set(kind === 'rewrite' ? (p.stories ?? []).map((s) => s.slug) : []);
      for (const f of existing) {
        const md = await gh.readBlob(env, f.sha);
        const t = topicFromMarkdown(md);
        if (t) titles.push(t.title);
        const slug = f.path.split('/').pop()!.replace(/\.md$/, '');
        if (rewriteSlugs.has(slug)) {
          const { fm } = parseStory(md);
          keep[slug] = {
            pubDate: fm.pubDate ? String(fm.pubDate).slice(0, 10) : null,
            hero: fm.heroImage ? { src: fm.heroImage, alt: fm.heroAlt ?? '', credit: fm.heroCredit } : null,
            draft: Boolean(fm.draft),
          };
        }
      }
      const topics: (Topic & { id: string })[] = library && kind === 'add'
        ? await pickTopics(env, siteSlug, { ids: library.topics, count: library.count, fromPosition: library.fromTopic, legacySkip: library.legacySkip })
        : [];
      return { titles, topics, keep, existingSlugs: existing.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')) };
    });

    const plans: ArticlePlan[] = await step.do('plan', { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
      const own = p.stories ?? [];
      const needs = own.filter((s) => !CATEGORIES.includes(s.category ?? '') || !s.angle);
      const guessed = await classifyTitles(env, input, needs.map((s) => s.title));
      const ownPlans: ArticlePlan[] = own.map((s) => {
        const g = needs.includes(s) ? guessed[needs.indexOf(s)] : null;
        return {
          title: s.title.trim(),
          slug: kind === 'rewrite' && s.slug ? s.slug : slugify(s.slug || s.title),
          categorySlug: CATEGORIES.includes(s.category ?? '') ? s.category! : g!.categorySlug,
          angle: s.angle || g!.angle,
        };
      });
      const ideaTopics: Topic[] = (p.ideas ?? []).map((idea) => ({ title: idea, summary: idea, categorySlug: '' }));
      const fresh = kind === 'add' && (ctx.topics.length || ideaTopics.length || p.extra)
        ? await planArticles(env, input, [...ctx.topics, ...ideaTopics], p.extra ?? 0, [...ctx.titles, ...ownPlans.map((x) => x.title)])
        : [];
      const all = [...ownPlans, ...fresh].map((x) => (p.instructions ? { ...x, angle: `${x.angle} Editor's notes: ${p.instructions}` } : x));
      if (kind === 'rewrite') return all;
      const taken = new Set(ctx.existingSlugs);
      return all.map((x) => { let s = x.slug, n = 2; while (taken.has(s)) s = `${x.slug}-${n++}`; taken.add(s); return { ...x, slug: s }; });
    });

    if (ctx.topics.length) await step.do('record-library-usage', () => recordUsage(env, siteSlug, ctx.topics.map((t) => t.id), taskId));

    await step.do('record-plan', async () => {
      const stmts = plans.map((pl, i) => env.DB.prepare('INSERT OR REPLACE INTO task_items (task_id, idx, title, slug, category) VALUES (?, ?, ?, ?, ?)').bind(taskId, i, pl.title, pl.slug, pl.categorySlug));
      if (stmts.length) await env.DB.batch(stmts).catch(() => null);
      await setTask('writing', `, total = ${plans.length}`);
    });

    const today = new Date(event.timestamp).toISOString().slice(0, 10);
    const BATCH = 4;
    let written = 0;
    const failed: string[] = [];
    for (let i = 0; i < plans.length; i += BATCH) {
      const results = await Promise.all(plans.slice(i, i + BATCH).map((plan, k) =>
        step.do(`article-${i + k}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '8 minutes' }, async () => {
          await setItem(i + k, 'writing');
          const kept = ctx.keep[plan.slug];
          const md = toMarkdown(input, await writeArticle(env, input, plan), kept?.pubDate ?? today, kept?.hero ?? null).content;
          const s = parseStory(md);
          if (kept) s.fm.updatedDate = today;
          if (p.draft ?? kept?.draft) s.fm.draft = true;
          await setItem(i + k, 'written');
          return { path: `${plan.slug}.md`, content: serializeStory(s) };
        }).catch(async (e: any) => {
          const msg = String(e?.message ?? e).slice(0, 200);
          failed.push(`${plan.title}: ${msg}`);
          await setItem(i + k, 'failed', msg);
          return null;
        })));
      const files = results.filter((f): f is { path: string; content: string } => Boolean(f));
      if (!files.length) continue;
      await step.do(`commit-${i}`, { retries: { limit: 3, delay: '20 seconds' } }, async () => {
        const verb = kind === 'rewrite' ? 'Rewrite' : 'Add';
        await gh.commitFiles(env, files.map((f) => ({ path: `${base}/${f.path}`, content: f.content })), `${verb} ${files.length} stories on ${siteSlug} (${i + files.length}/${plans.length}) [skip ci]`);
        for (let k = 0; k < BATCH; k++) if (results[k]) await setItem(i + k, 'published');
      });
      written += files.length;
      await step.do(`progress-${i}`, async () => { await track('UPDATE tasks SET written = ?, failed = ? WHERE id = ?', written, failed.length, taskId); });
    }

    const runKey = `stories-${taskId}`;
    const deploy = written > 0 && p.deploy !== false;
    if (deploy) {
      await step.do('deploy', async () => {
        await setTask('deploying', `, run_key = '${runKey.replace(/'/g, '')}'`);
        await gh.dispatchDeploy(env, siteSlug, runKey);
      });
    }
    await step.do('finish', async () => {
      await track("UPDATE tasks SET status = ?, written = ?, failed = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        written || !plans.length ? 'complete' : 'failed', written, failed.length, failed.length ? failed.join('\n').slice(0, 2000) : null, taskId);
    });
    return { site: siteSlug, kind, planned: plans.length, written, failed, stories: plans.map((x) => ({ title: x.title, slug: x.slug })), deploy: deploy ? { runKey, statusUrl: `/api/v1/deploys/${runKey}` } : null };
  }
}
