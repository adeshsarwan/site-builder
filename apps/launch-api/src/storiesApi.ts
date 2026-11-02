// Story (article) endpoints for the frontend. Mounted under /api/v1 (bearer auth from the parent router).
//
//   GET    /sites/:id/stories                 list (filter: q, category, draft, missingImage; sort; paging)
//   GET    /sites/:id/stories/:slug           one story (frontmatter + Markdown body)
//   POST   /sites/:id/stories                 write new stories with Claude: your titles, ideas, library topics, or "extra"
//   PUT    /sites/:id/stories/:slug           create/replace a story you wrote yourself
//   PATCH  /sites/:id/stories/:slug           edit fields (title, description, category, body, SEO, FAQ, draft, dates)
//   DELETE /sites/:id/stories/:slug           remove a story (and its photo)
//   POST   /sites/:id/stories/:slug/rewrite   rewrite one story with Claude (keeps URL, date and photo)
//   POST   /sites/:id/stories/:slug/photo     pick a new photo on the next deploy (optional search words)
//   GET    /sites/:id/library                 starting-library topics (for "write from library")
//   GET    /sites/:id/tasks                   recent story-writing tasks
//   GET    /tasks/:taskId                     one task with per-story progress (served from index.ts)
import { Hono } from 'hono';
import type { Env, LaunchInput } from './types';
import * as gh from './services/github';
import { topicFromMarkdown, slugify, CATEGORIES } from './services/content';
import { articlesDir, loadStories, loadStory, parseStory, serializeStory, summary, pixabayId, type Story } from './services/stories';
import { resolveSite, commitAndDeploy, type SiteRef } from './manage';
import type { StoryRequest } from './addArticles';

export const stories = new Hono<{ Bindings: Env }>();
const notFound = (c: any, what = 'site') => c.json({ error: `${what} not found` }, 404);
const bool = (v?: string) => (v === undefined ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase()));

/** Writer context for a site: launch input from D1 if launched by the API, else its config. */
async function inputFor(env: Env, site: SiteRef): Promise<LaunchInput> {
  const row = await env.DB.prepare('SELECT input_json, name FROM sites WHERE slug = ?').bind(site.slug).first<any>();
  const launched = row ? (JSON.parse(row.input_json) as LaunchInput) : ({} as LaunchInput);
  return { ...launched, domain: site.domain, name: site.config.name ?? launched.name ?? row?.name, country: launched.country ?? site.config.country, niche: launched.niche ?? site.config.niche };
}

async function startTask(env: Env, site: SiteRef, params: Record<string, unknown>) {
  const id = `stories-${site.slug}-${Date.now().toString(36)}`;
  await env.DB.prepare('INSERT OR IGNORE INTO tasks (id, site_slug, kind) VALUES (?, ?, ?)').bind(id, site.slug, params.kind ?? 'add').run().catch(() => null);
  const instance = await env.CONTENT.create({ id, params: { siteSlug: site.slug, input: await inputFor(env, site), ...params } });
  return { taskId: instance.id, site: site.slug, statusUrl: `/api/v1/tasks/${instance.id}` };
}

const deployFlag = (c: any, body: any) => body?.deploy !== false && c.req.query('deploy') !== '0';

// ---------- list / read ----------
stories.get('/sites/:id/stories', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const q = (c.req.query('q') ?? '').toLowerCase();
  const category = c.req.query('category');
  const draft = bool(c.req.query('draft'));
  const missingImage = bool(c.req.query('missingImage'));
  const sort = c.req.query('sort') ?? 'newest'; // newest | oldest | title
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? 100)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  let items = (await loadStories(c.env, site.slug)).map((s) => summary(s.slug, s.story));
  const counts = { total: items.length, drafts: items.filter((s) => s.draft).length, missingImage: items.filter((s) => !s.hasImage).length,
    byCategory: Object.fromEntries([...new Set(items.map((s) => s.category))].map((k) => [k, items.filter((s) => s.category === k).length])) };
  if (q) items = items.filter((s) => `${s.title} ${s.description} ${s.slug}`.toLowerCase().includes(q));
  if (category) items = items.filter((s) => s.category === category);
  if (draft !== undefined) items = items.filter((s) => s.draft === draft);
  if (missingImage !== undefined) items = items.filter((s) => !s.hasImage === missingImage);
  items.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title)
    : sort === 'oldest' ? String(a.pubDate).localeCompare(String(b.pubDate))
    : String(b.updatedDate ?? b.pubDate).localeCompare(String(a.updatedDate ?? a.pubDate)));
  return c.json({ site: site.slug, domain: site.domain, categories: site.config.categories ?? CATEGORIES, counts, matched: items.length, offset, limit,
    stories: items.slice(offset, offset + limit).map((s) => ({ ...s, url: `https://${site.domain}/${s.slug}` })) });
});

stories.get('/sites/:id/stories/:slug', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const story = await loadStory(c.env, site.slug, c.req.param('slug'));
  if (!story) return notFound(c, 'story');
  if (c.req.query('format') === 'markdown' || (c.req.header('accept') ?? '').includes('text/markdown')) return c.text(serializeStory(story), 200, { 'content-type': 'text/markdown; charset=utf-8' });
  return c.json({ ...summary(c.req.param('slug'), story), url: `https://${site.domain}/${c.req.param('slug')}`, frontmatter: story.fm, body: story.body });
});

// ---------- write new stories with Claude ----------
stories.post('/sites/:id/stories', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const b = (await c.req.json().catch(() => ({}))) as any;
  const own: StoryRequest[] = (Array.isArray(b.stories) ? b.stories : Array.isArray(b.titles) ? b.titles : [])
    .map((s: any) => (typeof s === 'string' ? { title: s } : s)).filter((s: any) => s?.title?.trim())
    .map((s: any) => ({ title: String(s.title).slice(0, 160), category: s.category, angle: s.angle, slug: s.slug ? slugify(s.slug) : undefined }));
  const ideas: string[] = (Array.isArray(b.ideas) ? b.ideas : []).map(String).filter(Boolean).map((s: string) => s.slice(0, 300));
  const extra = Math.max(0, Math.min(40, Number(b.extra ?? 0)));
  let library: { fromTopic: number; count: number } | null = null;
  if (b.library) {
    const launched = await inputFor(c.env, site);
    const lb = b.library === true ? {} : b.library;
    library = { fromTopic: Math.max(0, Number(lb.fromTopic ?? launched.libraryLimit ?? 0)), count: Math.max(0, Math.min(80, Number(lb.count ?? 0))) };
  }
  const total = own.length + ideas.length + extra;
  if (!total && !library) return c.json({ error: 'Give at least one of: stories (your titles), ideas, extra (count), library' }, 400);
  if (total > 80) return c.json({ error: 'At most 80 stories per task' }, 400);
  const bad = own.filter((s) => s.category && !CATEGORIES.includes(s.category));
  if (bad.length) return c.json({ error: `Unknown category "${bad[0].category}". Use one of: ${CATEGORIES.join(', ')} (or leave it out)` }, 400);
  const task = await startTask(c.env, site, { kind: 'add', stories: own, ideas, extra, library, instructions: b.instructions ? String(b.instructions).slice(0, 1000) : undefined, draft: Boolean(b.draft), deploy: b.deploy !== false });
  return c.json({ ...task, requested: { stories: own.length, ideas: ideas.length, extra, library } }, 202);
});

stories.post('/sites/:id/stories/:slug/rewrite', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const slug = c.req.param('slug');
  const story = await loadStory(c.env, site.slug, slug);
  if (!story) return notFound(c, 'story');
  const b = (await c.req.json().catch(() => ({}))) as any;
  const category = b.category ?? story.fm.categorySlug;
  const task = await startTask(c.env, site, {
    kind: 'rewrite',
    stories: [{ slug, title: String(b.title ?? story.fm.title), category: CATEGORIES.includes(category) ? category : undefined, angle: b.angle }],
    instructions: b.instructions ? String(b.instructions).slice(0, 1000) : undefined,
    deploy: b.deploy !== false,
  });
  return c.json(task, 202);
});

// ---------- hand edits ----------
const EDITABLE = ['title', 'description', 'category', 'body', 'draft', 'pubDate', 'updatedDate', 'heroAlt', 'faq', 'sources', 'related', 'author', 'authorBio'] as const;

function applyPatch(s: Story, b: any) {
  const fm = s.fm;
  for (const k of EDITABLE) {
    if (b[k] === undefined) continue;
    if (k === 'body') s.body = String(b.body);
    else if (k === 'category') { fm.category = fm.categorySlug = String(b.category); }
    else if (k === 'draft') { if (b.draft) fm.draft = true; else delete fm.draft; }
    else if (k === 'faq') fm.faq = (Array.isArray(b.faq) ? b.faq : []).filter((f: any) => f?.q && f?.a).map((f: any) => ({ q: String(f.q), a: String(f.a) }));
    else if (k === 'sources' || k === 'related') fm[k] = (Array.isArray(b[k]) ? b[k] : []).map(String);
    else fm[k] = String(b[k]);
  }
  if (b.seo && typeof b.seo === 'object') {
    fm.seo = { ...(fm.seo ?? {}) };
    for (const k of ['title', 'metaDescription', 'canonical', 'ogImage']) if (b.seo[k] !== undefined) fm.seo[k] = String(b.seo[k]);
    if (b.seo.keywords !== undefined) fm.seo.keywords = (Array.isArray(b.seo.keywords) ? b.seo.keywords : String(b.seo.keywords).split(',')).map((x: any) => String(x).trim()).filter(Boolean);
    if (b.seo.noindex !== undefined) fm.seo.noindex = Boolean(b.seo.noindex);
  }
  if (b.body !== undefined) {
    const words = s.body.split(/\s+/).filter(Boolean).length;
    fm.wordCount = words;
    fm.readTime = Math.max(3, Math.round(words / 230));
  }
}

function checkStory(s: Story): string | null {
  for (const k of ['title', 'description']) if (!String(s.fm[k] ?? '').trim()) return `"${k}" is required`;
  if (!s.body.trim()) return 'body is empty';
  if (/^#\s/m.test(s.body)) return 'body must not contain an H1 (# …); the title is the H1. Use ## and ### headings';
  return null;
}

stories.patch('/sites/:id/stories/:slug', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const slug = c.req.param('slug');
  const story = await loadStory(c.env, site.slug, slug);
  if (!story) return notFound(c, 'story');
  const b = (await c.req.json().catch(() => ({}))) as any;
  if (b.category !== undefined && !CATEGORIES.includes(b.category)) return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
  applyPatch(story, b);
  if (b.touch !== false && b.updatedDate === undefined && (b.body !== undefined || b.title !== undefined)) story.fm.updatedDate = new Date().toISOString().slice(0, 10);
  const err = checkStory(story);
  if (err) return c.json({ error: err }, 400);
  const changed = Object.keys(b).filter((k) => k !== 'deploy' && k !== 'touch');
  const out = await commitAndDeploy(c.env, site.slug, [{ path: `${articlesDir(site.slug)}/${slug}.md`, content: serializeStory(story) }], `Edit story ${slug} on ${site.slug} (${changed.join(', ')})`, deployFlag(c, b));
  return c.json({ changed, ...summary(slug, story), ...out }, 202);
});

// Create or replace a story you wrote yourself: { markdown } (full file with frontmatter) or fields { title, description, category, body, ... }.
stories.put('/sites/:id/stories/:slug', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const slug = slugify(c.req.param('slug'));
  if (!slug) return c.json({ error: 'invalid slug' }, 400);
  const b = (await c.req.json().catch(() => ({}))) as any;
  const existing = await loadStory(c.env, site.slug, slug);
  let story: Story;
  if (typeof b.markdown === 'string') story = parseStory(b.markdown);
  else { story = { fm: {}, body: '' }; applyPatch(story, b); }
  const fm = story.fm;
  const today = new Date().toISOString().slice(0, 10);
  const cat = fm.categorySlug ?? fm.category ?? b.category;
  if (!CATEGORIES.includes(cat)) return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
  story.fm = {
    title: fm.title, description: fm.description, slug, category: cat, categorySlug: cat,
    author: fm.author ?? `${site.config.name} Editorial Team`, authorBio: fm.authorBio ?? existing?.fm.authorBio ?? '',
    pubDate: fm.pubDate ?? existing?.fm.pubDate ?? today, ...(existing ? { updatedDate: today } : {}),
    readTime: fm.readTime ?? Math.max(3, Math.round(story.body.split(/\s+/).length / 230)), wordCount: story.body.split(/\s+/).filter(Boolean).length,
    origin: fm.origin ?? 'original',
    // keep the current photo unless the new file brings its own
    heroImage: fm.heroImage ?? existing?.fm.heroImage ?? '', heroAlt: fm.heroAlt ?? existing?.fm.heroAlt ?? '',
    ...(fm.heroCredit ?? (fm.heroImage ? undefined : existing?.fm.heroCredit) ? { heroCredit: fm.heroCredit ?? existing?.fm.heroCredit } : {}),
    ...(fm.draft ? { draft: true } : {}),
    seo: fm.seo ?? { title: String(fm.title ?? '').slice(0, 60), metaDescription: String(fm.description ?? '').slice(0, 155) },
    faq: fm.faq ?? [], sources: fm.sources ?? [], ...(fm.related ? { related: fm.related } : {}),
  };
  const err = checkStory(story);
  if (err) return c.json({ error: err }, 400);
  const out = await commitAndDeploy(c.env, site.slug, [{ path: `${articlesDir(site.slug)}/${slug}.md`, content: serializeStory(story) }], `${existing ? 'Replace' : 'Add'} story ${slug} on ${site.slug}`, deployFlag(c, b));
  return c.json({ created: !existing, ...summary(slug, story), url: `https://${site.domain}/${slug}`, note: story.fm.heroImage ? undefined : 'A photo is added during the deploy.', ...out }, existing ? 202 : 201);
});

stories.delete('/sites/:id/stories/:slug', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const slug = c.req.param('slug');
  const story = await loadStory(c.env, site.slug, slug);
  if (!story) return notFound(c, 'story');
  const files: gh.TreeFile[] = [{ path: `${articlesDir(site.slug)}/${slug}.md`, sha: null }];
  // Its photo, plus any earlier photo files of this story (slug.jpg, slug-<id>.jpg).
  const hero = String(story.fm.heroImage ?? '');
  const mine = new RegExp(`^${slug}(-\\d+)?\\.(jpe?g|png|webp)$`);
  for (const f of await gh.listTree(c.env, `sites/${site.slug}/public/images`)) {
    const name = f.path.split('/').pop()!;
    if (mine.test(name) || (hero.startsWith('/images/') && f.path === `sites/${site.slug}/public${hero}`)) files.push({ path: f.path, sha: null });
  }
  const out = await commitAndDeploy(c.env, site.slug, files, `Delete story ${slug} from ${site.slug}`, c.req.query('deploy') !== '0');
  return c.json({ deleted: slug, removedFiles: files.map((f) => f.path), ...out }, 202);
});

// New photo on the next deploy: clears the current one, never picks it again, optional search words.
stories.post('/sites/:id/stories/:slug/photo', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const slug = c.req.param('slug');
  const story = await loadStory(c.env, site.slug, slug);
  if (!story) return notFound(c, 'story');
  const b = (await c.req.json().catch(() => ({}))) as any;
  const avoid = pixabayId(story.fm.heroCredit?.sourceUrl);
  story.fm.heroImage = '';
  story.fm.heroAlt = '';
  delete story.fm.heroCredit;
  if (b.query) story.fm.imageQuery = String(b.query).slice(0, 80); else delete story.fm.imageQuery;
  if (avoid) story.fm.avoidImage = [...new Set([...(Array.isArray(story.fm.avoidImage) ? story.fm.avoidImage : []), avoid])];
  const out = await commitAndDeploy(c.env, site.slug, [{ path: `${articlesDir(site.slug)}/${slug}.md`, content: serializeStory(story) }], `New photo for ${slug} on ${site.slug}`, true);
  return c.json({ slug, query: story.fm.imageQuery ?? null, avoiding: story.fm.avoidImage ?? [], note: 'The deploy picks and commits the new photo.', ...out }, 202);
});

// ---------- library + tasks ----------
stories.get('/sites/:id/library', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const lib = await gh.listTree(c.env, 'sites/_library/articles');
  const launched = await inputFor(c.env, site);
  const topics = [];
  for (let i = 0; i < lib.length; i++) { const t = topicFromMarkdown(await gh.readBlob(c.env, lib[i].sha)); if (t) topics.push({ index: i, ...t }); }
  return c.json({ total: topics.length, launchedWith: launched.libraryLimit ?? null, note: 'Topics only: each site gets a freshly written story with its own title. Pass library: { fromTopic, count } to POST /stories.', topics });
});

stories.get('/sites/:id/tasks', async (c) => {
  const site = await resolveSite(c.env, c.req.param('id'));
  if (!site) return notFound(c);
  const rows = await c.env.DB.prepare('SELECT * FROM tasks WHERE site_slug = ? ORDER BY created_at DESC LIMIT ?').bind(site.slug, Math.min(100, Number(c.req.query('limit') ?? 20))).all();
  return c.json({ site: site.slug, tasks: rows.results.map((t: any) => ({ ...t, statusUrl: `/api/v1/tasks/${t.id}` })) });
});
