import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, LaunchInput } from './types';
import * as gh from './services/github';
import { planArticles, writeArticle, toMarkdown, topicFromMarkdown, type ArticlePlan, type Topic } from './services/content';

export interface AddArticlesParams {
  siteSlug: string;
  input: LaunchInput;        // name, domain, niche, country
  fromTopic: number;         // index into sites/_library/articles (sorted)
  count: number;             // number of library topics to use (0 = all remaining)
  extra: number;             // brand-new topics beyond the library
}

// Adds fresh articles to a live site: library topics only (titles + summaries), written from scratch,
// planned against the site's existing titles so nothing overlaps. Photos are filled by the deploy.
export class AddArticlesWorkflow extends WorkflowEntrypoint<Env, AddArticlesParams> {
  async run(event: WorkflowEvent<AddArticlesParams>, step: WorkflowStep) {
    const env = this.env;
    const { siteSlug, input, fromTopic, count, extra } = event.payload;
    const base = `sites/${siteSlug}/content/articles`;

    const ctx = await step.do('read-site', async () => {
      const existing = await gh.listTree(env, base);
      const titles: string[] = [];
      for (const f of existing) { const t = topicFromMarkdown(await gh.readBlob(env, f.sha)); if (t) titles.push(t.title); }
      const lib = await gh.listTree(env, 'sites/_library/articles');
      const slice = lib.slice(fromTopic, count > 0 ? fromTopic + count : undefined);
      const topics: Topic[] = [];
      for (const f of slice) { const t = topicFromMarkdown(await gh.readBlob(env, f.sha)); if (t) topics.push(t); }
      return { titles, topics, existingSlugs: existing.map((f) => f.path.split('/').pop()!.replace(/\.md$/, '')) };
    });

    const plans: ArticlePlan[] = await step.do('plan', { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
      const p = await planArticles(env, input, ctx.topics, extra, ctx.titles);
      const taken = new Set(ctx.existingSlugs);
      return p.map((x) => { let s = x.slug, n = 2; while (taken.has(s)) s = `${x.slug}-${n++}`; taken.add(s); return { ...x, slug: s }; });
    });

    const today = new Date(event.timestamp).toISOString().slice(0, 10);
    const BATCH = 4;
    let written = 0;
    for (let i = 0; i < plans.length; i += BATCH) {
      // Each batch is written and committed on its own, so progress is kept even if a later batch fails.
      const files = await Promise.all(plans.slice(i, i + BATCH).map((plan, k) =>
        step.do(`article-${i + k}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '8 minutes' }, async () =>
          toMarkdown(input, await writeArticle(env, input, plan), today, null))));
      await step.do(`commit-${i}`, { retries: { limit: 3, delay: '20 seconds' } }, async () => {
        await gh.commitFiles(env, files.map((f) => ({ path: `${base}/${f.path}`, content: f.content })), `Add ${files.length} articles to ${siteSlug} (${i + files.length}/${plans.length}) [skip ci]`);
      });
      written += files.length;
    }

    await step.do('deploy', async () => { await gh.dispatchDeploy(env, siteSlug, `articles-${event.instanceId}`); });
    return { site: siteSlug, planned: plans.length, written, titles: plans.map((p) => p.title) };
  }
}
