import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSiteRow, getStepRow, notify, setStep, updateSite } from './db';
import { type Env, type LaunchInput, type LaunchParams, type StepKey, StepSkipped, StepWarning } from './types';
import * as cf from './services/cloudflare';
import * as gh from './services/github';
import * as google from './services/google';
import { planArticles, writeArticle, toMarkdown, topicFromMarkdown, type ArticlePlan, type Topic } from './services/content';
import { pickImage } from './services/images';

type Out = Record<string, any>;
const FINISHED = ['done', 'warning', 'skipped'];
const delay = (i: number): WorkflowSleepDuration => (i < 6 ? '2 minutes' : i < 24 ? '10 minutes' : '30 minutes');

export class LaunchSiteWorkflow extends WorkflowEntrypoint<Env, LaunchParams> {
  async run(event: WorkflowEvent<LaunchParams>, step: WorkflowStep) {
    const env = this.env;
    const { siteId } = event.payload;
    const dry = env.DRY_RUN === 'true';

    const meta = await step.do('load', async () => {
      const row = await getSiteRow(env, siteId);
      if (!row) throw new Error(`site ${siteId} not found`);
      return { domain: row.domain as string, slug: row.slug as string, input: JSON.parse(row.input_json) as LaunchInput };
    });
    const { domain, slug, input } = meta;
    const worker = `site-${slug}`;
    let warnings = 0;

    const emit = async (key: StepKey, status: Parameters<typeof setStep>[3], detail?: string | null, output?: unknown) => {
      await setStep(env, siteId, key, status, detail, output);
      await notify(env, siteId);
    };

    /** Runs a single-shot step once: skips if already finished (e.g. on retry), records status + output. */
    const once = async <T extends Out>(key: StepKey, fn: () => Promise<{ output: T; detail?: string }>, config: any = { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' }): Promise<T> => {
      const prev = await step.do(`${key}:prev`, async () => {
        const r = await getStepRow(env, siteId, key);
        return r && FINISHED.includes(r.status) ? { status: r.status as string, output: JSON.parse(r.output_json ?? '{}') } : null;
      });
      if (prev) { if (prev.status === 'warning') warnings++; return prev.output as T; }
      await step.do(`${key}:start`, () => emit(key, 'running'));
      const res = await step.do(key, config, async () => {
        try {
          const r = await fn();
          await emit(key, 'done', r.detail ?? null, r.output);
          return { status: 'done', output: r.output };
        } catch (e: any) {
          if (e instanceof StepWarning) { await emit(key, 'warning', e.message, {}); return { status: 'warning', output: {} }; }
          if (e instanceof StepSkipped) { await emit(key, 'skipped', e.message, {}); return { status: 'skipped', output: {} }; }
          throw e;
        }
      });
      if (res.status === 'warning') warnings++;
      return res.output as T;
    };

    /** Polls `check` with durable sleeps until it returns a value (not null) or gives up. */
    const poll = async <T>(key: StepKey, name: string, max: number, sleep: (i: number) => any, check: () => Promise<T | null>): Promise<T> => {
      for (let i = 0; i < max; i++) {
        const r = await step.do(`${name}:check-${i}`, { retries: { limit: 2, delay: '10 seconds' }, timeout: '2 minutes' }, async () => (await check()) as any);
        if (r !== null && r !== undefined) return r as T;
        await step.sleep(`${name}:sleep-${i}`, sleep(i));
      }
      throw new Error(`${key}: timed out waiting`);
    };

    const isDone = (key: StepKey) => step.do(`${key}:is-done`, async () => FINISHED.includes((await getStepRow(env, siteId, key))?.status));

    try {
      await step.do('mark-running', async () => { await updateSite(env, siteId, { status: 'running', error: null }); await notify(env, siteId); });

      // 1. Zone ----------------------------------------------------------------
      const zone = await once('zone', async () => {
        const z = dry ? { id: 'dry-zone', status: 'pending', name_servers: ['ada.ns.cloudflare.com', 'rob.ns.cloudflare.com'] } : await cf.ensureZone(env, domain);
        await updateSite(env, siteId, { zone_id: z.id, nameservers: JSON.stringify(z.name_servers) });
        return { output: { zoneId: z.id, nameservers: z.name_servers, status: z.status }, detail: z.status === 'active' ? 'Zone already active' : `Zone created — set nameservers to ${z.name_servers.join(', ')}` };
      });

      // 2. Nameservers -----------------------------------------------------------
      if (!(await isDone('nameservers'))) {
        await step.do('nameservers:waiting', async () => {
          await updateSite(env, siteId, { status: 'waiting' });
          await emit('nameservers', 'waiting', `Point ${domain} to ${zone.nameservers.join(' and ')} at your registrar`);
        });
        await poll('nameservers', 'ns', 200, delay, async () => {
          if (dry) return true;
          const z = await cf.zoneStatus(env, zone.zoneId);
          if (z.status === 'active') return true;
          await cf.requestActivationCheck(env, zone.zoneId);
          return null;
        });
        await step.do('nameservers:done', async () => {
          await updateSite(env, siteId, { status: 'running' });
          await emit('nameservers', 'done', 'Domain is active on Cloudflare', {});
        });
      }

      // 3. GA4 -------------------------------------------------------------------
      const ga = await once('analytics', async () => {
        if (dry) return { output: { measurementId: 'G-DRYRUN000' }, detail: 'G-DRYRUN000' };
        if (!env.GA4_ACCOUNT_ID || !env.GCP_SA_JSON) throw new StepSkipped('GA4_ACCOUNT_ID / GCP_SA_JSON not configured');
        const token = await google.googleToken(env, google.SCOPES_GA);
        const r = await google.createGa4(token, env.GA4_ACCOUNT_ID, input.name ?? domain, domain);
        return { output: r, detail: r.measurementId };
      });

      // 4. Content: new articles + photos, written fresh for this site ---------------
      const content = await (async () => {
        if (await isDone('content')) return step.do('content:stored', async () => JSON.parse((await getStepRow(env, siteId, 'content'))?.output_json ?? '{}'));
        await step.do('content:start', () => emit('content', 'running', 'Planning topics'));
        const useLib = input.useLibraryTopics !== false;
        const topics: Topic[] = useLib && !dry
          ? await step.do('content:topics', async () => {
              const files = await gh.listTree(env, 'sites/_library/articles');
              const limit = input.libraryLimit ?? files.length;
              const out: Topic[] = [];
              for (const f of files.slice(0, limit)) { const t = topicFromMarkdown(await gh.readBlob(env, f.sha)); if (t) out.push(t); }
              return out;
            })
          : [];
        const extra = Math.max(0, Math.min(40, input.generateArticles ?? 0));
        const total = (dry ? Math.min(input.libraryLimit ?? 3, 3) : topics.length) + extra;
        if (total === 0) throw new Error('No articles requested (useLibraryTopics=false and generateArticles=0)');
        const plans: ArticlePlan[] = dry
          ? Array.from({ length: total }, (_, i) => ({ title: `Dry run article ${i + 1}`, slug: `dry-run-article-${i + 1}`, categorySlug: 'interview-prep', angle: 'test' }))
          : await step.do('content:plan', { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, () => planArticles(env, input, topics, extra));
        const today = new Date(event.timestamp).toISOString().slice(0, 10);
        const imgEnv = input.imageProvider ? { ...env, IMAGE_PROVIDER: input.imageProvider } : env;
        const generated: { path: string; content: string }[] = [];
        const images: { path: string; sha: string }[] = [];
        const used = new Set<string>();
        const BATCH = 4; // a few articles in parallel; each is its own retryable step
        for (let i = 0; i < plans.length; i += BATCH) {
          await step.do(`content:progress-${i}`, () => emit('content', 'running', `Writing articles ${i + 1}–${Math.min(i + BATCH, plans.length)} of ${plans.length}`));
          const batch = await Promise.all(plans.slice(i, i + BATCH).map((plan, k) =>
            step.do(`content:article-${i + k}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '8 minutes' }, async () => {
              if (dry) return { md: toMarkdown(input, { plan, description: 'Dry run', metaDescription: 'Dry run', seoTitle: plan.title, readTime: 3, body: '## Section\n\nDry run body.', faq: [], sources: [], imageQuery: 'office', keywords: [] }, today, null), image: null };
              const art = await writeArticle(env, input, plan);
              let picked = null;
              try { picked = imgEnv.IMAGE_PROVIDER === 'none' ? null : await pickImage(imgEnv, art.imageQuery, plan.slug, slug, used); } catch { picked = null; }
              return { md: toMarkdown(input, art, today, picked?.hero ?? null), image: picked?.blob ?? null };
            }),
          ));
          for (const b of batch) { generated.push(b.md); if (b.image) images.push(b.image); }
        }
        const out = { generated, images };
        await step.do('content:done', () => emit('content', 'done', `${generated.length} new articles · ${images.length} photos`, out));
        return out;
      })();

      // 5. Repo ------------------------------------------------------------------
      await once<{ commit: string | null }>('repo', async () => {
        if (dry) return { output: { commit: 'dry-commit' }, detail: 'dry-commit' };
        const base = `sites/${slug}`;
        const files: gh.TreeFile[] = [];
        const existing = await gh.readFile(env, `${base}/site.config.json`);
        if (!existing) {
          const tpl = await gh.readFile(env, 'sites/_template/site.config.json');
          if (!tpl) throw new Error('sites/_template/site.config.json missing in repo');
          const vars: Record<string, string> = {
            slug, domain, name: input.name ?? domain, tagline: input.tagline ?? 'Find work that fits your life',
            description: input.description ?? `Job search guides, interview prep and current openings from ${input.name ?? domain}.`,
            country: input.country ?? 'US', primary: input.primaryColor ?? '#1d4ed8',
          };
          const cfg = JSON.parse(tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '').replace(/"/g, '\\"')));
          cfg.analytics.ga4MeasurementId = ga.measurementId ?? '';
          cfg.ads.adsTxt = input.adsTxt ?? [];
          if (input.jobsDefaultQuery) cfg.jobs.defaultQuery = input.jobsDefaultQuery;
          files.push({ path: `${base}/site.config.json`, content: JSON.stringify(cfg, null, 2) + '\n' });
        }
        for (const img of content.images ?? []) files.push({ path: img.path, sha: img.sha });
        for (const f of content.generated ?? []) files.push({ path: `${base}/content/articles/${f.path}`, content: f.content });
        if (!files.length) return { output: { commit: null }, detail: 'Nothing new to commit' };
        // [skip ci] stops the push trigger; the launch dispatches its own deploy run below.
        const commit = await gh.commitFiles(env, files, `Launch ${domain} [skip ci]`);
        return { output: { commit }, detail: `${files.length} files · ${commit.slice(0, 7)}` };
      });

      // 6. Deploy ----------------------------------------------------------------
      if (!(await isDone('deploy'))) {
        const runKey = `${slug}-${siteId}-${event.payload.attempt}`;
        await step.do('deploy:dispatch', async () => {
          await emit('deploy', 'running', 'Starting GitHub Actions deploy');
          if (!dry) await gh.dispatchDeploy(env, slug, runKey);
        });
        const run = await poll('deploy', 'deploy', 60, () => '30 seconds', async () => {
          if (dry) return { conclusion: 'success', url: 'https://github.com/dry/run' };
          const r = await gh.findRun(env, runKey);
          if (!r || r.status !== 'completed') return null;
          return { conclusion: r.conclusion, url: r.url };
        });
        await step.do('deploy:result', async () => {
          if (run.conclusion !== 'success') { await emit('deploy', 'failed', `Deploy ${run.conclusion}: ${run.url}`); throw new Error(`Deploy failed — ${run.url}`); }
          await emit('deploy', 'done', run.url, run);
        });
      }

      // 7. Custom domain + SSL ----------------------------------------------------
      if (!(await isDone('custom_domain'))) {
        await step.do('domain:attach', { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } }, async () => {
          await emit('custom_domain', 'running', `Attaching ${domain} to ${worker}`);
          if (dry) return;
          await cf.attachWorkerDomain(env, zone.zoneId, domain, worker);
          await cf.wwwRedirect(env, zone.zoneId, domain);
        });
        await poll('custom_domain', 'domain', 30, () => '1 minute', async () => {
          if (dry) return true;
          try {
            const r = await fetch(`https://${domain}/robots.txt`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
            return r.status === 200 ? true : null;
          } catch { return null; }
        });
        await step.do('domain:done', () => emit('custom_domain', 'done', `https://${domain} is serving over HTTPS`, {}));
      }

      // 8. Search Console ---------------------------------------------------------
      if (!(await isDone('search_console'))) {
        if (dry || !env.GCP_SA_JSON) {
          await step.do('sc:skip', () => emit('search_console', dry ? 'done' : 'skipped', dry ? 'sc-domain (dry run)' : 'GCP_SA_JSON not configured', {}));
        } else {
          await step.do('sc:token', { retries: { limit: 3, delay: '20 seconds' } }, async () => {
            await emit('search_console', 'running', 'Adding DNS verification record');
            const token = await google.googleToken(env, google.SCOPES_SEARCH);
            const txt = await google.getDnsVerificationToken(token, domain);
            await cf.upsertDns(env, zone.zoneId, { type: 'TXT', name: domain, content: txt });
          });
          await step.sleep('sc:dns-propagate', '1 minute');
          const property = await step.do('sc:verify', { retries: { limit: 6, delay: '2 minutes', backoff: 'linear' }, timeout: '5 minutes' }, async () => {
            const token = await google.googleToken(env, google.SCOPES_SEARCH);
            const owners = (env.OWNER_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
            await google.verifyDomain(token, domain, owners);
            const p = await google.addSearchConsoleProperty(token, domain);
            await google.submitSitemap(token, p, `https://${domain}/sitemap.xml`);
            return p;
          });
          await step.do('sc:done', () => emit('search_console', 'done', `${property} verified · sitemap submitted`, { property }));
        }
      }

      // 9. Ads ---------------------------------------------------------------------
      await once('ads', async () => {
        if (dry) return { output: { revision: 0 }, detail: 'dry run' };
        const runtime = env.PO_RUNTIME_URL ?? 'https://serve.thebesads.com/runtime/config';
        const res = await fetch(`${runtime}?site=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
        const body: any = res?.ok ? await res.json().catch(() => null) : null;
        if (!body || body.siteKey !== domain) {
          throw new StepWarning(`No published Price Optimiser configuration for "${domain}" yet. Publish one; the site already loads the SDK with data-po-site="${domain}".`);
        }
        return { output: { revision: body.configurationRevision }, detail: `Price Optimiser config revision ${body.configurationRevision}` };
      });

      // 10. Smoke test --------------------------------------------------------------
      await once('smoke_test', async () => {
        if (dry) return { output: { checked: 0 }, detail: 'dry run' };
        const paths = ['/', '/sitemap.xml', '/robots.txt', '/ads.txt', '/article', '/start/job-match'];
        const failures: string[] = [];
        let home = '';
        for (const p of paths) {
          const r = await fetch(`https://${domain}${p}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
          if (!r || r.status !== 200) failures.push(`${p} → ${r?.status ?? 'unreachable'}`);
          else if (p === '/') home = await r.text();
        }
        if (home && !home.includes(`data-po-site="${domain}"`)) failures.push('homepage missing Price Optimiser SDK tag');
        if (failures.length) throw new Error(`Smoke test failed: ${failures.join(', ')}`);
        return { output: { checked: paths.length }, detail: `${paths.length} URLs OK` };
      }, { retries: { limit: 4, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' });

      await step.do('finish', async () => {
        await updateSite(env, siteId, { status: warnings ? 'live_with_warnings' : 'live', live_url: `https://${domain}`, current_step: null });
        await notify(env, siteId);
      });
    } catch (e: any) {
      await step.do('fail', async () => {
        const site = await getSiteRow(env, siteId);
        if (site?.current_step) await setStep(env, siteId, site.current_step, 'failed', String(e?.message ?? e).slice(0, 500));
        await updateSite(env, siteId, { status: 'failed', error: String(e?.message ?? e).slice(0, 1000) });
        await notify(env, siteId);
      });
      throw e;
    }
  }
}
