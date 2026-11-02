#!/usr/bin/env node
// Gives every article of $SITE a hero photo before the build.
// Runs in GitHub Actions (Pixabay rate-limits Cloudflare Workers' shared egress IPs).
// Pixabay rules: images are downloaded and served from our own domain (no hotlinking), with credit.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { siteDir } from './site-config.mjs';

const KEY = process.env.PIXABAY_API_KEY;
const SITE = process.env.SITE;
if (!KEY) { console.log('fill-images: PIXABAY_API_KEY not set — skipping'); process.exit(0); }

const dir = path.join(siteDir(SITE), 'content', 'articles');
const imgDir = path.join(siteDir(SITE), 'public', 'images');
const CATEGORY_QUERY = {
  'interview-prep': 'job interview', 'resume-cover-letters': 'resume writing desk', 'job-search-strategy': 'job search laptop',
  'salary-negotiation': 'business meeting handshake', 'workplace-success': 'office teamwork', 'career-change-growth': 'career planning notebook',
};
const STOP = new Set('a an and the to of for in on with without from your you how what when why is are do does it its this that vs into at by as be can should'.split(' '));
const q = (v) => JSON.stringify(v ?? '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const field = (fm, k) => { const v = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''; try { return JSON.parse(v); } catch { return v; } };

const searchCache = new Map();
async function search(term) {
  if (searchCache.has(term)) return searchCache.get(term);
  const u = new URL('https://pixabay.com/api/');
  u.search = new URLSearchParams({ key: KEY, q: term.slice(0, 100), image_type: 'photo', orientation: 'horizontal', safesearch: 'true', min_width: '1200', per_page: '30' });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(u);
    if (res.status === 429) {
      const wait = Number(res.headers.get('x-ratelimit-reset') ?? 60) + 2;
      console.log(`  Pixabay asked us to slow down — waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Pixabay ${res.status}`);
    const hits = (await res.json()).hits ?? [];
    searchCache.set(term, hits);
    await sleep(700); // stay well under 100 requests/minute
    return hits;
  }
  throw new Error('Pixabay rate limit did not clear');
}

const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
const used = new Set();
const todo = [];
for (const f of files) {
  const md = readFileSync(path.join(dir, f), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  for (const m of fm.matchAll(/pixabay\.com\/(?:photos|illustrations)\/\S*?-(\d+)\/?"?\s*$/gm)) used.add(m[1]);
  // Photos a story asked never to get again (POST /stories/:slug/photo): `avoidImage:` list of Pixabay ids.
  const avoid = [...(fm.match(/^avoidImage:\s*\n((?:\s+-.*\n?)+)/m)?.[1] ?? '').matchAll(/-\s*"?(\d+)"?/g)].map((m) => m[1]);
  avoid.forEach((id) => used.add(id));
  const hero = String(field(fm, 'heroImage') ?? '');
  if (!hero) todo.push({ f, md, title: String(field(fm, 'title')), category: String(field(fm, 'categorySlug')), query: String(field(fm, 'imageQuery') ?? ''), replace: avoid.length > 0 });
}
console.log(`fill-images: ${files.length} articles, ${todo.length} without a photo`);
mkdirSync(imgDir, { recursive: true });

let added = 0;
for (const a of todo) {
  const slug = a.f.replace(/\.md$/, '');
  const words = a.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const terms = [...new Set([a.query, words.slice(0, 3).join(' '), words.slice(0, 2).join(' '), CATEGORY_QUERY[a.category], 'people working laptop', 'office work'].filter(Boolean))];
  let hit = null;
  for (const t of terms) {
    try { hit = (await search(t)).find((h) => !used.has(String(h.id))); } catch (e) { console.log(`  ${slug} [${t}]: ${e.message}`); }
    if (hit) break;
  }
  if (!hit) { console.log(`  ${slug}: no photo found`); continue; }
  used.add(String(hit.id));
  const img = await fetch(hit.largeImageURL);
  if (!img.ok) { console.log(`  ${slug}: download failed ${img.status}`); continue; }
  // A replacement photo gets a new file name so browsers and the CDN don't keep showing the old one.
  const file = a.replace ? `${slug}-${hit.id}.jpg` : `${slug}.jpg`;
  writeFileSync(path.join(imgDir, file), Buffer.from(await img.arrayBuffer()));
  const alt = String(hit.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4).join(', ');
  const credit = `\nheroCredit:\n  name: ${q(hit.user)}\n  url: ${q(`https://pixabay.com/users/${hit.user}-${hit.user_id}/`)}\n  source: "Pixabay"\n  sourceUrl: ${q(hit.pageURL)}`;
  let md = /^heroImage:.*$/m.test(a.md) ? a.md.replace(/^heroImage:.*$/m, `heroImage: ${q(`/images/${file}`)}`) : a.md.replace(/^(title:.*)$/m, `$1\nheroImage: ${q(`/images/${file}`)}`);
  md = /^heroAlt:.*$/m.test(md) ? md.replace(/^heroAlt:.*$/m, `heroAlt: ${q(alt)}${credit}`) : md.replace(/^(heroImage:.*)$/m, `$1\nheroAlt: ${q(alt)}${credit}`);
  md = md.replace(/^imageQuery:.*\n/m, '');
  writeFileSync(path.join(dir, a.f), md);
  added++;
  console.log(`  ${slug}: ✓ ${hit.pageURL}`);
}
console.log(`fill-images: added ${added}, still missing ${todo.length - added}`);
if (process.env.GITHUB_STEP_SUMMARY && todo.length) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${SITE}: added ${added} photos (${todo.length - added} still missing)\n`, { flag: 'a' });
}
