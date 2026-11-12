// Per-site best-of lists, reviews and "How we review" text, written fresh by the Claude API for every games portal.
//
// Sites share a pool of mobile games (content/<dir>/apps.json + play.json: titles, live Google Play facts), but each site
// gets its own content/<siteKey>/editorial.json: different list topics and titles, its own picks, awards and wording,
// and its own reviews. The model is given the titles of every other site's lists so it picks new angles, and it may
// only pick games from the pool (anything else is dropped). Facts it is told: rating, installs, price, ads, IAP, age rating.
import type { Env } from '../types';
import { claudeJson } from '../services/content';
import * as repo from './repo';
import { sitePath } from './sites';

export const editorialPath = (key: string) => `content/${key}/editorial.json`;

export interface PoolGame { path: string; title: string; genre: string; score: number | null; installs: string; price: string; ads: boolean | null; iap: boolean | null; rating: string }

const pkgOf = (url = '') => (url.match(/[?&]id=([^&#]+)/) || [])[1] || '';
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/** The mobile games a site can pick from: the shared content folder's apps with their Google Play facts. */
export async function loadPool(env: Env, dir: string): Promise<PoolGame[]> {
  const [apps, play, extra] = await Promise.all([
    repo.readJson<any[]>(env, `content/${dir}/apps.json`),
    repo.readJson<Record<string, any>>(env, `content/${dir}/play.json`),
    repo.readJson<any[]>(env, `content/${dir}/extra-apps.json`),
  ]);
  const p = play ?? {};
  const out: PoolGame[] = [];
  const seen = new Set<string>();
  const add = (path: string, title: string, pkg: string, genre = '') => {
    const d = p[pkg];
    if (!d || !path || seen.has(path.toLowerCase())) return; // only games with live Play data (the build drops the rest)
    seen.add(path.toLowerCase());
    out.push({ path, title: d.title || title, genre: d.genre || genre.replace(/^Game /, ''), score: d.score ?? null, installs: d.installs || '', price: d.free === false ? d.price || 'paid' : 'free', ads: d.adSupported ?? null, iap: d.offersIAP ?? null, rating: d.contentRating || '' });
  };
  for (const a of apps ?? []) add(a.path, a.title, pkgOf(a.googlePlay), a.genre);
  for (const e of extra ?? []) { const d = p[e.pkg]; if (d) add(e.path || d.title.replace(/[™®:'’]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''), d.title, e.pkg); }
  return out;
}

/** List titles already used by other sites (so a new site takes different angles). */
async function usedTitles(env: Env, exceptKey: string): Promise<string[]> {
  const dirs = (await repo.listDirs(env, 'content')).filter((d) => d !== exceptKey && !d.startsWith('_'));
  const eds = await Promise.all(dirs.map((d) => repo.readJson<any>(env, editorialPath(d)).catch(() => null)));
  return [...new Set(eds.flatMap((e) => (e?.lists ?? []).map((l: any) => String(l.title))))];
}

const LIST_SCHEMA = {
  type: 'object',
  properties: {
    lists: {
      type: 'array', minItems: 10, maxItems: 14,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'e.g. "Best co-op games to play on the couch". Starts with "Best".' },
          intro: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
          picks: {
            type: 'array', minItems: 4, maxItems: 9,
            items: { type: 'object', properties: { path: { type: 'string' }, award: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'award', 'why'] },
          },
          howWeChose: { type: 'string' },
          filter: { type: 'string', enum: ['none', 'noAds', 'noIAP', 'noAdsNoIAP'] },
          kids: { type: 'boolean' },
        },
        required: ['title', 'intro', 'picks', 'howWeChose', 'filter', 'kids'],
      },
    },
    featured: { type: 'string', description: 'path of the Editor\'s pick shown at the top of the home page' },
    spotlight: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', properties: { listTitle: { type: 'string' }, path: { type: 'string' }, why: { type: 'string' } }, required: ['listTitle', 'path', 'why'] } },
    homeLists: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'string', description: 'list title' } },
    method: { type: 'array', minItems: 6, maxItems: 12, items: { type: 'string' }, description: '"How we review" page: paragraphs; a paragraph starting with "## " is a heading' },
  },
  required: ['lists', 'featured', 'spotlight', 'homeLists', 'method'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' }, score: { type: 'number', minimum: 3, maximum: 5 }, editorsChoice: { type: 'boolean' },
          verdict: { type: 'string' }, bestFor: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
          cons: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          body: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
        },
        required: ['path', 'score', 'editorsChoice', 'verdict', 'bestFor', 'pros', 'cons', 'body'],
      },
    },
  },
  required: ['reviews'],
};

const fact = (g: PoolGame) => `${g.path} | ${g.title} | ${g.genre} | ${g.score ?? '?'}★ | ${g.installs} | ${g.price} | ${g.ads === false ? 'no ads' : g.ads ? 'ads' : 'ads ?'} | ${g.iap === false ? 'no IAP' : g.iap ? 'IAP' : 'IAP ?'} | ${g.rating}`;

const SYSTEM = (name: string) => `You are the editor of ${name}, a website that recommends Android games from Google Play.
Write in plain, friendly, specific English for ordinary players. Each sentence must say something concrete about the game
(what you do in it, how it plays, what it costs, who it suits). No hype words ("ultimate", "epic", "must-have"),
no claims you cannot back with the facts given or with widely known facts about the game. Never mention other websites.`;

/** Writes a fresh editorial.json for one site. Throws if the model's answer is unusable. */
export async function generateEditorial(env: Env, site: { key: string; name: string }, pool: PoolGame[], avoid: string[], reviewCount = 12) {
  if (pool.length < 30) throw new Error(`only ${pool.length} games with Google Play data to pick from`);
  const byPath = new Map(pool.map((g) => [g.path.toLowerCase(), g]));
  const today = new Date().toISOString().slice(0, 10);

  const plan = await claudeJson<any>(env, SYSTEM(site.name), `Create the best-of lists for ${site.name}.

Games you may pick from (one per line: path | title | genre | Google Play rating | installs | price | ads | in-app purchases | age rating).
Use the path exactly as written. Do not pick anything that is not in this list.
${pool.map(fact).join('\n')}

Other sites already have lists with these titles. Do NOT reuse these titles or near-copies of them; choose different angles
(moods, situations, players, play styles, phones, budgets, genres, "games like X" for other games, etc.). It is fine to cover
a broad theme another site has only if your angle and title are clearly different:
${avoid.length ? avoid.map((t) => `- ${t}`).join('\n') : '- (none yet)'}

Rules:
- 10 to 14 lists, 4 to 9 picks each, every pick a good fit for that list. Vary which games you use across lists.
- Exactly one list may be for kids (kids: true): only games rated Everyone, no violence.
- filter: "noAds" only if every pick has "no ads"; "noIAP" only if every pick has "no IAP"; "noAdsNoIAP" if both; otherwise "none".
- award: 2-4 words, e.g. "Best for two players". why: one sentence. intro: 1-2 short paragraphs. howWeChose: 1-2 sentences.
- featured: one standout game. spotlight: 3 picks from 3 different lists (listTitle exactly as you wrote it), each with a short why (under 10 words).
- homeLists: titles of 6 of your lists to show on the home page.
- method: the "How we review" page for ${site.name} in your own words, with headings "## …": how games are scored out of 5 and what
  Editor's Choice means; that ratings, installs, prices and ads info come from Google Play and refresh daily; that the games are made
  by their developers, downloaded from Google Play, and ${site.name} is not affiliated with Google or the publishers; that publishers
  don't pay for placement; how often lists are revisited.`, LIST_SCHEMA, 16000, 'games lists');

  // ---- validate lists
  const takenSlugs = new Set<string>();
  const lists: any[] = [];
  for (const l of plan.lists ?? []) {
    let picks = (l.picks ?? []).map((p: any) => ({ g: byPath.get(String(p.path).toLowerCase()), award: String(p.award).trim(), why: String(p.why).trim() })).filter((p: any) => p.g);
    picks = picks.filter((p: any, i: number) => picks.findIndex((x: any) => x.g.path === p.g.path) === i);
    const f = l.filter === 'none' ? undefined : l.filter;
    if (f) picks = picks.filter((p: any) => (f !== 'noIAP' ? p.g.ads === false : true) && (f !== 'noAds' ? p.g.iap === false : true));
    if (picks.length < 3) continue;
    let slug = slugify(String(l.title));
    if (!slug || takenSlugs.has(slug)) slug = `${slug || 'list'}-${lists.length + 1}`;
    takenSlugs.add(slug);
    lists.push({
      slug, title: String(l.title).trim(), intro: (l.intro ?? []).map(String),
      picks: picks.map((p: any) => ({ path: p.g.path, award: p.award, why: p.why })),
      howWeChose: String(l.howWeChose ?? ''), ...(f ? { filter: f } : {}), updated: today, author: 'editors', kids: Boolean(l.kids),
    });
  }
  if (lists.length < 6) throw new Error(`only ${lists.length} usable lists in the model's answer`);
  const byTitle = (t: string) => lists.find((l) => l.title.toLowerCase() === String(t).trim().toLowerCase());
  const spotlight = (plan.spotlight ?? []).map((s: any) => { const l = byTitle(s.listTitle); const g = byPath.get(String(s.path).toLowerCase()); return l && g && l.picks.some((p: any) => p.path === g.path) ? { list: l.slug, path: g.path, why: String(s.why) } : null; }).filter(Boolean);
  const homeLists = [...new Set([...(plan.homeLists ?? []).map((t: string) => byTitle(t)?.slug).filter(Boolean), ...lists.filter((l) => !l.kids).map((l) => l.slug)])].slice(0, 6);
  const featured = byPath.get(String(plan.featured).toLowerCase())?.path ?? lists[0].picks[0].path;

  // ---- reviews: the featured game, spotlight picks, then each list's top picks
  const want = [...new Set([featured, ...spotlight.map((s: any) => s.path), ...lists.flatMap((l) => l.picks.slice(0, 2).map((p: any) => p.path))])].slice(0, reviewCount);
  const rv = await claudeJson<any>(env, SYSTEM(site.name), `Write short reviews for ${site.name} of these Android games (facts: path | title | genre | rating | installs | price | ads | IAP | age rating):
${want.map((p) => fact(byPath.get(p.toLowerCase())!)).join('\n')}

For each: score out of 5 (one decimal, your editorial judgment, 3.5-4.9 for these picks), editorsChoice (true for at most a third),
verdict (one sentence), bestFor (one sentence), 2-4 pros, 1-3 cons (be honest about ads, purchases, length, difficulty), and a
2-3 paragraph body describing how it plays and who it suits. Use each path exactly as given.`, REVIEW_SCHEMA, 16000, 'games reviews');
  const reviews: Record<string, any> = {};
  for (const r of rv.reviews ?? []) {
    const g = byPath.get(String(r.path).toLowerCase());
    if (!g || !want.includes(g.path) || reviews[g.path]) continue;
    reviews[g.path] = { score: Math.round(Math.min(5, Math.max(1, Number(r.score) || 4)) * 10) / 10, editorsChoice: Boolean(r.editorsChoice), verdict: String(r.verdict), bestFor: String(r.bestFor), pros: (r.pros ?? []).map(String), cons: (r.cons ?? []).map(String), body: (r.body ?? []).map(String), author: 'editors', updated: today };
  }

  return {
    authors: [{ slug: 'editors', name: '{site} Editors' }],
    reviews,
    lists,
    method: (plan.method ?? []).map(String),
    home: { featured, spotlight, lists: homeLists },
  };
}

/**
 * Generates a site's own lists and reviews and commits content/<key>/editorial.json together with
 * content.editorialDir in its site.json (one commit, so Pages rebuilds once). The site must already have `content`.
 */
export async function writeSiteEditorial(env: Env, key: string) {
  const sp = sitePath(key);
  const site = await repo.readJson<any>(env, sp);
  if (!site?.content) throw new Error(`${key} has no content block (lists need a pool of mobile games: set "content" first)`);
  const pool = await loadPool(env, site.content.dir || key);
  const avoid = await usedTitles(env, key);
  const ed = await generateEditorial(env, { key, name: site.name }, pool, avoid);
  const ep = editorialPath(key);
  const r = await repo.updateJson(env, [ep, sp], (cur) => {
    const s = cur[sp] ?? site;
    s.content = { ...(s.content ?? site.content), editorialDir: key };
    return { [ep]: ed, [sp]: s };
  }, `New lists and reviews for ${key} (${ed.lists.length} lists, ${Object.keys(ed.reviews).length} reviews)`);
  return { lists: ed.lists.map((l) => l.title), reviews: Object.keys(ed.reviews), avoided: avoid.length, pool: pool.length, commit: r?.commit ?? null };
}
