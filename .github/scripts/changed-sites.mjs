// Decides which sites to deploy. Dispatch → the requested site (or all).
// Push → sites whose folder changed; any change to the shared app or pipeline redeploys every site.
import { execSync } from 'node:child_process';
import { readdirSync, existsSync, appendFileSync } from 'node:fs';

const all = readdirSync('sites', { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(`sites/${d.name}/site.config.json`))
  .map((d) => d.name);

let sites = [];
if (process.env.EVENT === 'workflow_dispatch') {
  const s = (process.env.INPUT_SITE || '').trim();
  sites = s === 'all' ? all : all.includes(s) ? [s] : [];
  if (!sites.length) { console.error(`Unknown site "${s}". Known: ${all.join(', ')}`); process.exit(1); }
} else {
  const before = process.env.BEFORE;
  const range = before && !/^0+$/.test(before) ? `${before}..HEAD` : 'HEAD~1..HEAD';
  let changed = [];
  try { changed = execSync(`git diff --name-only ${range}`).toString().split('\n').filter(Boolean); } catch { changed = ['apps/web/']; }
  const shared = changed.some((f) => f.startsWith('apps/web/') || f.startsWith('shared/') || f.startsWith('.github/'));
  sites = shared ? all : [...new Set(changed.map((f) => f.match(/^sites\/([^/_][^/]*)\//)?.[1]).filter((s) => s && all.includes(s)))];
}

console.log('Deploying:', sites.join(', ') || '(nothing)');
appendFileSync(process.env.GITHUB_OUTPUT, `sites=${JSON.stringify(sites)}\n`);
