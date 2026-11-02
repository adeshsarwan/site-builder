import type { Env } from '../types';
import * as gh from './github';
import { imageQueries, pickImageWithFallback } from './images';

/**
 * Adds a hero photo to every article of a site that has none, commits the photos + updated
 * frontmatter in one commit, and starts a deploy. Photos already used on the site are not reused.
 */
export async function backfillImages(env: Env, siteSlug: string, limit = 2, deploy = true) {
  if (limit === 0) {
    if (deploy) await gh.dispatchDeploy(env, siteSlug, `backfill-${Date.now()}`);
    return { checked: 0, missing: 0, added: 0, stillMissing: [], commit: null, errors: [], deployed: deploy };
  }
  const files = (await gh.listTree(env, `sites/${siteSlug}/content/articles`)).filter((f) => f.path.endsWith('.md'));
  const used = new Set<string>();
  const missing: { path: string; md: string; title: string; category: string; slug: string }[] = [];
  for (const f of files) {
    const md = await gh.readBlob(env, f.sha);
    const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    for (const m of fm.matchAll(/pixabay\.com\/[^"]*?-(\d+)\/?"/g)) used.add(`px-${m[1]}`);
    const hero = fm.match(/^heroImage:\s*(.*)$/m)?.[1]?.trim() ?? '';
    if (!hero || hero === '""' || hero === "''") {
      const get = (k: string) => { try { return JSON.parse(fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '""'); } catch { return ''; } };
      missing.push({ path: f.path, md, title: String(get('title')), category: String(get('categorySlug')), slug: f.path.split('/').pop()!.replace(/\.md$/, '') });
    }
  }
  const out: gh.TreeFile[] = [];
  const added: string[] = [];
  const still: string[] = [];
  const errors: string[] = [];
  for (const a of missing.slice(0, limit)) {
    const picked = await pickImageWithFallback(env, imageQueries(undefined, a.title, a.category), a.slug, siteSlug, used, errors);
    if (!picked) { still.push(a.slug); continue; }
    const q = (v: unknown) => JSON.stringify(v ?? '');
    const c = picked.hero.credit;
    const credit = c ? `\nheroCredit:\n  name: ${q(c.name)}\n  url: ${q(c.url)}\n  source: ${q(c.source)}\n  sourceUrl: ${q(c.sourceUrl)}` : '';
    let md = a.md.replace(/^heroImage:.*$/m, `heroImage: ${q(picked.hero.src)}`);
    md = /^heroAlt:.*$/m.test(md) ? md.replace(/^heroAlt:.*$/m, `heroAlt: ${q(picked.hero.alt)}${credit}`) : md.replace(/^(heroImage:.*)$/m, `$1\nheroAlt: ${q(picked.hero.alt)}${credit}`);
    md = md.replace(/^heroCredit:\n(  .*\n){4}(?=heroCredit:)/m, ''); // never leave two credit blocks
    out.push({ path: a.path, content: md });
    if (picked.blob) out.push(picked.blob);
    added.push(a.slug);
  }
  let commit: string | null = null;
  if (out.length) {
    commit = await gh.commitFiles(env, out, `Add missing article photos for ${siteSlug} [skip ci]`);
    if (deploy) await gh.dispatchDeploy(env, siteSlug, `backfill-${Date.now()}`);
  }
  return { checked: files.length, missing: missing.length - added.length, added: added.length, stillMissing: still, commit, errors, deployed: deploy && Boolean(commit) };
}
