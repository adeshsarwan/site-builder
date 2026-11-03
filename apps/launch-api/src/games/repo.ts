// GitHub access to the games portal builder repo (adeshsarwan/h5-games-site-builder by default).
//   catalog/games.json        shared metadata of every game (the same on every site)
//   sites/<key>/site.json     one portal: name, theme, which games, ad units, ads.txt
// Every push to main rebuilds the Pages projects whose watch paths match (a site's own folder, or the
// shared catalog/code for all sites), so writing a file here is how a change goes live.
import type { Env } from '../types';

const dec = (b64: string) => decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));

export const repoName = (env: Env) => env.GAMES_GITHUB_REPO || 'h5-games-site-builder';
const branch = (env: Env) => env.GAMES_GITHUB_BRANCH || 'main';

async function gh<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${repoName(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GAMES_GITHUB_TOKEN || env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'site-builder-launch-api',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(`GitHub (${repoName(env)}) ${init.method ?? 'GET'} ${path} → ${res.status} ${body.message ?? ''}`);
    err.status = res.status;
    throw err;
  }
  return body as T;
}

async function head(env: Env) {
  const ref = await gh<any>(env, `/git/ref/heads/${branch(env)}`);
  const commit = await gh<any>(env, `/git/commits/${ref.object.sha}`);
  return { sha: ref.object.sha as string, tree: commit.tree.sha as string };
}

async function fileAt(env: Env, tree: string, path: string): Promise<string | null> {
  // Walk the tree one level at a time (no recursive listing of the whole repo).
  let sha = tree;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const t = await gh<any>(env, `/git/trees/${sha}`);
    const entry = t.tree.find((e: any) => e.path === parts[i]);
    if (!entry) return null;
    sha = entry.sha;
  }
  return dec((await gh<any>(env, `/git/blobs/${sha}`)).content);
}

export async function readFile(env: Env, path: string) {
  return fileAt(env, (await head(env)).tree, path);
}

export async function readJson<T = any>(env: Env, path: string): Promise<T | null> {
  const raw = await readFile(env, path);
  return raw === null ? null : (JSON.parse(raw) as T);
}

/** Names of the folders directly under `dir`. */
export async function listDirs(env: Env, dir: string): Promise<string[]> {
  const h = await head(env);
  let sha = h.tree;
  for (const part of dir.split('/').filter(Boolean)) {
    const t = await gh<any>(env, `/git/trees/${sha}`);
    const e = t.tree.find((x: any) => x.path === part);
    if (!e) return [];
    sha = e.sha;
  }
  return (await gh<any>(env, `/git/trees/${sha}`)).tree.filter((e: any) => e.type === 'tree').map((e: any) => e.path);
}

/**
 * Read-modify-write of JSON files in one commit. `mutate` gets the current contents (null if missing) and
 * returns the new contents, or undefined to leave a file unchanged. If main moved meanwhile, it starts over
 * from the new head (up to 4 tries), so two edits at the same moment never overwrite each other.
 * Returns null when nothing changed.
 */
export async function updateJson(env: Env, paths: string[], mutate: (current: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>, message: string) {
  for (let attempt = 1; ; attempt++) {
    const h = await head(env);
    const current: Record<string, any> = {};
    for (const p of paths) { const raw = await fileAt(env, h.tree, p); current[p] = raw === null ? null : JSON.parse(raw); }
    const next = await mutate(structuredClone(current));
    const changed = Object.entries(next).filter(([p, v]) => v !== undefined && JSON.stringify(v) !== JSON.stringify(current[p]));
    if (!changed.length) return null;
    // Same formatting as the repo's own scripts: catalog uses 1-space indent, site files 2.
    const files = changed.map(([p, v]) => ({ path: p, mode: '100644', type: 'blob', content: JSON.stringify(v, null, p.startsWith('catalog/') ? 1 : 2) + '\n' }));
    const tree = await gh<any>(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: h.tree, tree: files }) });
    const commit = await gh<any>(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [h.sha] }) });
    try {
      await gh(env, `/git/refs/heads/${branch(env)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
      return { commit: commit.sha as string, files: changed.map(([p]) => p) };
    } catch (e: any) {
      if (e.status !== 422 || attempt >= 4) throw e; // 422 = not a fast-forward: someone else committed first
    }
  }
}

