import type { Env } from '../types';

async function gh<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'site-builder-launch-api',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status} ${body.message ?? ''}`);
  return body as T;
}

export async function readFile(env: Env, path: string): Promise<string | null> {
  try {
    const f = await gh<any>(env, `/contents/${path}?ref=${env.GITHUB_BRANCH}`);
    return decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))));
  } catch (e: any) {
    if (String(e.message).includes('404')) return null;
    throw e;
  }
}

/** Blob entries (path + sha) under a directory, without downloading contents. */
export async function listTree(env: Env, dir: string): Promise<{ path: string; sha: string }[]> {
  const ref = await gh<any>(env, `/git/ref/heads/${env.GITHUB_BRANCH}`);
  const commit = await gh<any>(env, `/git/commits/${ref.object.sha}`);
  const tree = await gh<any>(env, `/git/trees/${commit.tree.sha}?recursive=1`);
  const prefix = dir.replace(/\/$/, '') + '/';
  return tree.tree.filter((t: any) => t.type === 'blob' && t.path.startsWith(prefix)).map((t: any) => ({ path: t.path, sha: t.sha }));
}

export async function createBlob(env: Env, base64: string): Promise<string> {
  const b = await gh<any>(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: base64, encoding: 'base64' }) });
  return b.sha;
}

export async function readBlob(env: Env, sha: string): Promise<string> {
  const b = await gh<any>(env, `/git/blobs/${sha}`);
  return decodeURIComponent(escape(atob(String(b.content).replace(/\n/g, ''))));
}

export type TreeFile = { path: string; content: string } | { path: string; sha: string | null }; // sha null = delete

/** One commit with many files (new content inline, copied files by existing blob sha). */
export async function commitFiles(env: Env, files: TreeFile[], message: string) {
  const ref = await gh<any>(env, `/git/ref/heads/${env.GITHUB_BRANCH}`);
  const parent = await gh<any>(env, `/git/commits/${ref.object.sha}`);
  const tree = await gh<any>(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', ...('sha' in f ? { sha: f.sha } : { content: f.content }) })),
    }),
  });
  const commit = await gh<any>(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [parent.sha] }) });
  await gh(env, `/git/refs/heads/${env.GITHUB_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return commit.sha as string;
}

export async function dispatchDeploy(env: Env, site: string, runKey: string) {
  await gh(env, '/actions/workflows/deploy.yml/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: env.GITHUB_BRANCH, inputs: { site, run_key: runKey } }),
  });
}

/** Finds the dispatched run by its run-name (which includes run_key). */
export async function findRun(env: Env, runKey: string) {
  const runs = await gh<any>(env, '/actions/workflows/deploy.yml/runs?event=workflow_dispatch&per_page=30');
  const run = runs.workflow_runs.find((r: any) => String(r.display_title ?? r.name).includes(runKey));
  return run ? { id: run.id as number, status: run.status as string, conclusion: run.conclusion as string | null, url: run.html_url as string } : null;
}
