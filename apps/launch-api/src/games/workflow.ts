// Launch of one H5 games portal, end to end. Same shape as the jobs launch (durable steps, retries, status
// in D1, webhooks), different steps: no content to write — the games, text and images come from the shared
// catalogue — and Cloudflare Pages instead of a Worker.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { getSiteRow, getStepRow, notify, setStep, updateSite } from '../db';
import { type Env, type LaunchParams, StepSkipped, StepWarning } from '../types';
import * as cf from '../services/cloudflare';
import * as google from '../services/google';
import * as repo from './repo';
import * as pages from './pages';
import * as ga4 from './analytics';
import { GAMES_STEPS, loadCatalog, newSiteJson, siteGames, sitePath, type GamesLaunchInput } from './sites';
export { GAMES_STEPS };

type Key = (typeof GAMES_STEPS)[number]['key'];

type Out = Record<string, any>;
const FINISHED = ['done', 'warning', 'skipped'];
const nsDelay = (i: number): WorkflowSleepDuration => (i < 6 ? '2 minutes' : i < 24 ? '10 minutes' : '30 minutes');

export class GamesLaunchWorkflow extends WorkflowEntrypoint<Env, LaunchParams> {
  async run(event: WorkflowEvent<LaunchParams>, step: WorkflowStep) {
    const env = this.env;
    const cfEnv = pages.gamesCfEnv(env); // zones/DNS in the games Cloudflare account
    const { siteId } = event.payload;
    const dry = env.DRY_RUN === 'true';

    const meta = await step.do('load', async () => {
      const row = await getSiteRow(env, siteId);
      if (!row) throw new Error(`site ${siteId} not found`);
      return { domain: row.domain as string, key: row.slug as string, input: JSON.parse(row.input_json) as GamesLaunchInput };
    });
    const { domain, key, input } = meta;
    const project = pages.projectName(key);
    let warnings = 0;

    const emit = async (k: Key, status: Parameters<typeof setStep>[3], detail?: string | null, output?: unknown) => {
      await setStep(env, siteId, k, status, detail, output);
      await notify(env, siteId);
    };
    const isDone = (k: Key) => step.do(`${k}:is-done`, async () => FINISHED.includes((await getStepRow(env, siteId, k))?.status));
    const once = async <T extends Out>(k: Key, fn: () => Promise<{ output: T; detail?: string }>, config: any = { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' }): Promise<T> => {
      const prev = await step.do(`${k}:prev`, async () => {
        const r = await getStepRow(env, siteId, k);
        return r && FINISHED.includes(r.status) ? { status: r.status as string, output: JSON.parse(r.output_json ?? '{}') } : null;
      });
      if (prev) { if (prev.status === 'warning') warnings++; return prev.output as T; }
      await step.do(`${k}:start`, () => emit(k, 'running'));
      const res = await step.do(k, config, async () => {
        try {
          const r = await fn();
          await emit(k, 'done', r.detail ?? null, r.output);
          return { status: 'done', output: r.output };
        } catch (e: any) {
          if (e instanceof StepWarning) { await emit(k, 'warning', e.message, {}); return { status: 'warning', output: {} }; }
          if (e instanceof StepSkipped) { await emit(k, 'skipped', e.message, {}); return { status: 'skipped', output: {} }; }
          throw e;
        }
      });
      if (res.status === 'warning') warnings++;
      return res.output as T;
    };
    const poll = async <T>(k: Key, name: string, max: number, sleep: (i: number) => any, check: () => Promise<T | null>): Promise<T> => {
      for (let i = 0; i < max; i++) {
        const r = await step.do(`${name}:check-${i}`, { retries: { limit: 2, delay: '10 seconds' }, timeout: '2 minutes' }, async () => (await check()) as any);
        if (r !== null && r !== undefined) return r as T;
        await step.sleep(`${name}:sleep-${i}`, sleep(i));
      }
      throw new Error(`${k}: timed out waiting`);
    };

    try {
      await step.do('mark-running', async () => { await updateSite(env, siteId, { status: 'running', error: null }); await notify(env, siteId); });

      // 1. Zone
      const zone = await once('zone', async () => {
        const z = dry ? { id: 'dry-zone', status: 'pending', name_servers: ['ada.ns.cloudflare.com', 'rob.ns.cloudflare.com'] } : await cf.ensureZone(cfEnv, domain);
        await updateSite(env, siteId, { zone_id: z.id, nameservers: JSON.stringify(z.name_servers) });
        return { output: { zoneId: z.id, nameservers: z.name_servers }, detail: z.status === 'active' ? 'Zone already active' : `Zone created — set nameservers to ${z.name_servers.join(', ')}` };
      });

      // 2. Nameservers
      if (!(await isDone('nameservers'))) {
        await step.do('nameservers:waiting', async () => {
          await updateSite(env, siteId, { status: 'waiting' });
          await emit('nameservers', 'waiting', `Point ${domain} to ${zone.nameservers.join(' and ')} at your registrar`);
        });
        await poll('nameservers', 'ns', 200, nsDelay, async () => {
          if (dry) return true;
          if ((await cf.zoneStatus(cfEnv, zone.zoneId)).status === 'active') return true;
          await cf.requestActivationCheck(cfEnv, zone.zoneId);
          return null;
        });
        await step.do('nameservers:done', async () => { await updateSite(env, siteId, { status: 'running' }); await emit('nameservers', 'done', 'Domain is active on Cloudflare', {}); });
      }

      // 3. GA4: find or create the property + web stream, then custom dimensions/metrics, key events, retention
      const ga = await once<{ measurementId?: string; property?: string }>('analytics', async () => {
        if (dry) return { output: { measurementId: 'G-DRYRUN000' }, detail: 'G-DRYRUN000' };
        if (!ga4.gaConfigured(env)) {
          if (input.ga4MeasurementId) return { output: { measurementId: input.ga4MeasurementId }, detail: `Using existing stream ${input.ga4MeasurementId} (not configured: GCP_SA_JSON missing)` };
          throw new StepSkipped('GA4_ACCOUNT_ID / GCP_SA_JSON not configured');
        }
        const token = await ga4.gaToken(env);
        let ref: { property: string; measurementId: string } | null;
        let how: string;
        if (input.ga4MeasurementId) {
          ref = await ga4.findGa4(token, env.GA4_ACCOUNT_ID!, { measurementId: input.ga4MeasurementId, domain, names: [input.name ?? '', domain] });
          if (!ref) return { output: { measurementId: input.ga4MeasurementId }, detail: `Using ${input.ga4MeasurementId}; not in GA account ${env.GA4_ACCOUNT_ID}, so dimensions and key events were not set up` };
          how = 'existing stream';
        } else {
          const r = await ga4.ensureGa4(env, token, domain, input.name ?? domain);
          ref = r; how = r.created ? 'new property' : 'existing property';
        }
        // Setup problems are reported, not fatal: the Measurement ID is what the site needs; POST /games/sites/{id}/analytics/setup re-runs this.
        const setup = await ga4.configureGa4(token, ref.property).catch((e: any) => ({ error: String(e.message) }) as any);
        const summary = 'error' in setup ? `setup failed: ${setup.error}` : ga4.setupSummary(setup);
        return { output: { ...ref, setup }, detail: `${ref.measurementId} (${how}, ${ref.property}) · ${summary}` };
      });

      // 4. site.json
      const first = await once<{ commit: string | null; firstGame: string | null }>('repo', async () => {
        const catalog = await loadCatalog(env);
        const site = newSiteJson(key, input, catalog);
        site.analytics.ga4 = ga.measurementId ?? '';
        if (ga.property) site.analytics.ga4Property = ga.property;
        const firstGame = site.featured[0] ?? siteGames(site, catalog)[0]?.slug ?? null;
        if (dry) return { output: { commit: 'dry-commit', firstGame }, detail: `sites/${key}/site.json (dry run)` };
        const r = await repo.updateJson(env, [sitePath(key)], (cur) => ({ [sitePath(key)]: cur[sitePath(key)] ?? site }), `Add games site ${domain}`);
        return { output: { commit: r?.commit ?? null, firstGame }, detail: r ? `sites/${key}/site.json · ${r.commit.slice(0, 7)}` : 'site.json already there' };
      });

      // 5. Pages project
      await once('pages', async () => {
        if (dry) return { output: { project }, detail: `${project} (dry run)` };
        const p = await pages.ensureProject(env, project, key);
        return { output: { project, subdomain: p.subdomain }, detail: `${project} → ${p.subdomain ?? `${project}.pages.dev`}` };
      });

      // 6. Build & deploy
      if (!(await isDone('deploy'))) {
        const started = await step.do('deploy:trigger', { retries: { limit: 3, delay: '30 seconds' } }, async () => {
          await emit('deploy', 'running', 'Building on Cloudflare Pages');
          return dry ? { id: 'dry' } : { id: (await pages.triggerDeployment(env, project)).id as string };
        });
        const d = await poll('deploy', 'deploy', 40, () => '30 seconds', async () => {
          if (dry) return { status: 'success', url: `https://${project}.pages.dev` };
          const x = await pages.deployment(env, project, started.id);
          return ['success', 'failure', 'canceled'].includes(x.status) ? x : null;
        });
        await step.do('deploy:result', async () => {
          if (d.status !== 'success') { await emit('deploy', 'failed', `Pages build ${d.status}: see the ${project} project in Cloudflare`); throw new Error(`Pages build ${d.status}`); }
          await emit('deploy', 'done', d.url, d);
        });
      }

      // 7. Custom domain + SSL (www → apex)
      if (!(await isDone('custom_domain'))) {
        await step.do('domain:attach', { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } }, async () => {
          if (dry) return;
          // Whatever served the domain before goes: Worker custom domains/routes, then plain A/AAAA/CNAME records.
          const detached = await cf.detachWorkers(cfEnv, zone.zoneId, [domain, `www.${domain}`]);
          const removed = await cf.clearWebRecords(cfEnv, zone.zoneId, [domain, `www.${domain}`]);
          await pages.addDomain(env, project, domain);
          // Pages adds this record itself when the zone is in the same account; this keeps it right either way.
          const cname = await cf.upsertDns(cfEnv, zone.zoneId, { type: 'CNAME', name: domain, content: `${project}.pages.dev`, proxied: true }).then(() => null, (e: any) => String(e.message));
          await cf.wwwRedirect(cfEnv, zone.zoneId, domain);
          const notes = [
            detached.length ? `detached from Workers: ${detached.join('; ')} (re-attach in the dashboard to undo)` : '',
            removed.length ? `removed old DNS: ${removed.join('; ')}` : '',
            cname ? `CNAME not set: ${cname}` : '',
          ].filter(Boolean);
          await emit('custom_domain', 'running', `Attached ${domain} to ${project}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
        });
        await poll('custom_domain', 'domain', 40, () => '1 minute', async () => {
          if (dry) return true;
          const s = await pages.domainStatus(env, project, domain).catch(() => null);
          if (s?.status !== 'active') return null;
          const r = await fetch(`https://${domain}/robots.txt`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => null);
          return r?.status === 200 ? true : null;
        });
        await step.do('domain:done', () => emit('custom_domain', 'done', `https://${domain} is serving over HTTPS`, {}));
      }

      // 8. Search Console
      if (!(await isDone('search_console'))) {
        if (dry || !env.GCP_SA_JSON) {
          await step.do('sc:skip', () => emit('search_console', dry ? 'done' : 'skipped', dry ? 'dry run' : 'GCP_SA_JSON not configured', {}));
        } else {
          await step.do('sc:token', { retries: { limit: 3, delay: '20 seconds' } }, async () => {
            await emit('search_console', 'running', 'Adding DNS verification record');
            const token = await google.googleToken(env, google.SCOPES_SEARCH);
            await cf.upsertDns(cfEnv, zone.zoneId, { type: 'TXT', name: domain, content: await google.getDnsVerificationToken(token, domain) });
          });
          await step.sleep('sc:dns-propagate', '1 minute');
          const property = await step.do('sc:verify', { retries: { limit: 6, delay: '2 minutes', backoff: 'linear' }, timeout: '5 minutes' }, async () => {
            const token = await google.googleToken(env, google.SCOPES_SEARCH);
            await google.verifyDomain(token, domain, (env.OWNER_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
            const p = await google.addSearchConsoleProperty(token, domain);
            await google.submitSitemap(token, p, `https://${domain}/sitemap.xml`);
            return p;
          });
          await step.do('sc:done', () => emit('search_console', 'done', `${property} verified · sitemap submitted`, { property }));
        }
      }

      // 9. Ads: stage 2
      await once<{ priceOptimiser?: string }>('ads', async () => {
        if (dry) return { output: {}, detail: 'dry run' };
        if (input.priceOptimiserScript) return { output: { priceOptimiser: String(input.priceOptimiserScript) }, detail: `Price Optimiser script ${input.priceOptimiserScript}${input.adsTxt?.length ? ` · ads.txt ${input.adsTxt.length} line(s)` : ' · ads.txt empty: add it with PUT /v1/games/sites/{id}/ads.txt'}` };
        throw new StepSkipped('Test ads until stage 2: create the GAM units (or set them with PATCH /v1/games/sites/{id}/ads), then POST /v1/games/sites/{id}/ads/enable with the ads.txt lines');
      });

      // 10. Smoke test
      await once('smoke_test', async () => {
        if (dry) return { output: { checked: 0 }, detail: 'dry run' };
        const paths = ['/', '/robots.txt', '/sitemap.xml', '/search.json', ...(first.firstGame ? [`/game/${first.firstGame}/`, `/play/${first.firstGame}/`] : [])];
        const failures: string[] = [];
        for (const p of paths) {
          const r = await fetch(`https://${domain}${p}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
          if (!r || r.status !== 200) failures.push(`${p} → ${r?.status ?? 'unreachable'}`);
        }
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
