// Cloudflare Pages: one project per games portal, built from the games repo with SITE=<key>.
// Needs "Cloudflare Pages: Edit" on CF_API_TOKEN for the games account (GAMES_CF_ACCOUNT_ID).
import type { Env } from '../types';
import { repoName } from './repo';

const API = 'https://api.cloudflare.com/client/v4';
export const gamesAccount = (env: Env) => env.GAMES_CF_ACCOUNT_ID || env.CF_ACCOUNT_ID;
/** Same Env, pointed at the games account (zones, DNS and Pages live there). */
export const gamesCfEnv = (env: Env): Env => ({ ...env, CF_ACCOUNT_ID: gamesAccount(env) });

async function cf<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/accounts/${gamesAccount(env)}/pages/projects${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const msg = body.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
    const err: any = new Error(`Cloudflare Pages ${init.method ?? 'GET'} ${path || '/'} → ${res.status} ${msg}${res.status === 403 ? ' (give CF_API_TOKEN "Cloudflare Pages: Edit" on the games account)' : ''}`);
    err.status = res.status;
    throw err;
  }
  return body.result as T;
}

/** Pages project names: lowercase letters, digits and hyphens, at most 58 characters. */
export const projectName = (siteKey: string) => `games-${siteKey}`.slice(0, 58).replace(/-+$/, '');

export async function getProject(env: Env, name: string) {
  try { return await cf<any>(env, `/${name}`); } catch (e: any) { if (e.status === 404) return null; throw e; }
}

/**
 * Creates the project connected to the games repo. Only pushes that touch this site's folder or the shared
 * code/catalog rebuild it (build watch paths), and branches other than main never build.
 */
export async function ensureProject(env: Env, name: string, siteKey: string) {
  const existing = await getProject(env, name);
  if (existing) return existing;
  const vars = { SITE: { type: 'plain_text', value: siteKey }, NODE_VERSION: { type: 'plain_text', value: '20' } };
  return cf<any>(env, '', {
    method: 'POST',
    body: JSON.stringify({
      name,
      production_branch: env.GAMES_GITHUB_BRANCH || 'main',
      source: {
        type: 'github',
        config: {
          owner: env.GITHUB_OWNER, repo_name: repoName(env), production_branch: env.GAMES_GITHUB_BRANCH || 'main',
          deployments_enabled: true, production_deployments_enabled: true, pr_comments_enabled: false,
          preview_deployment_setting: 'none',
          path_includes: [`sites/${siteKey}/**`, 'catalog/**', 'src/**', 'functions/play/**', 'build.mjs', 'package.json'],
          path_excludes: [],
        },
      },
      build_config: { build_command: 'node build.mjs', destination_dir: 'dist', root_dir: '' },
      deployment_configs: { production: { env_vars: vars }, preview: { env_vars: vars } },
    }),
  });
}

/** Builds the latest commit of main now. */
export async function triggerDeployment(env: Env, name: string) {
  const form = new FormData();
  form.set('branch', env.GAMES_GITHUB_BRANCH || 'main');
  return cf<any>(env, `/${name}/deployments`, { method: 'POST', body: form });
}

export interface DeploymentInfo { id: string; status: 'queued' | 'building' | 'success' | 'failure' | 'canceled'; stage: string; commit: string | null; url: string; createdOn: string }

function info(d: any): DeploymentInfo {
  const st = d.latest_stage ?? {};
  const status = st.status === 'failure' ? 'failure' : st.status === 'canceled' ? 'canceled'
    : st.name === 'deploy' && st.status === 'success' ? 'success'
    : st.name === 'queued' || !st.name ? 'queued' : 'building';
  return { id: d.id, status, stage: `${st.name ?? '?'}:${st.status ?? '?'}`, commit: d.deployment_trigger?.metadata?.commit_hash ?? null, url: d.url, createdOn: d.created_on };
}

export async function deployments(env: Env, name: string, limit = 10): Promise<DeploymentInfo[]> {
  const list = await cf<any[]>(env, `/${name}/deployments?env=production&per_page=${limit}`);
  return (list ?? []).map(info);
}

export async function deployment(env: Env, name: string, id: string) {
  return info(await cf<any>(env, `/${name}/deployments/${id}`));
}

export async function addDomain(env: Env, name: string, domain: string) {
  try { return await cf<any>(env, `/${name}/domains`, { method: 'POST', body: JSON.stringify({ name: domain }) }); }
  catch (e: any) { if (/already|8000018/i.test(e.message)) return domainStatus(env, name, domain); throw e; }
}

export async function domainStatus(env: Env, name: string, domain: string) {
  const d = await cf<any>(env, `/${name}/domains/${domain}`);
  return { status: d.status as string, error: d.validation_data?.error_message ?? d.verification_data?.error_message ?? null };
}
