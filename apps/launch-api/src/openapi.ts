// OpenAPI 3.1 description of the Launch API (served at /api/openapi.json).
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain (jobsthe.world) or site folder (careertrailhead)', schema: { type: 'string' } };
const accepted = json(ref('Accepted'), 'Accepted — a commit and a deploy were started');

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Site Builder Launch API',
    version: '1.0.0',
    description: 'Launch and manage job sites. All /v1 routes need `Authorization: Bearer <API_KEY>` (or the SUPERADMIN_KEY, which can also edit the base topic library). Call from a server, not a browser. Changes that touch a site (config, ads, ads.txt) commit to GitHub and start a deploy; follow it with GET /v1/deploys/{runKey}.',
  },
  servers: [{ url: 'https://sitebuilder.thebesads.com/api' }],
  security: [{ bearer: [] }],
  tags: [
    { name: 'Launch', description: 'Stage 1: create and launch a site' },
    { name: 'Stories', description: 'List, write, edit, rewrite, re-photo and delete stories (articles)' },
    { name: 'Content', description: 'Older content endpoints (kept for compatibility)' },
    { name: 'Library', description: 'Base topic library (headlines new sites write fresh stories from). Reading needs any key; changes need the SUPERADMIN_KEY' },
    { name: 'Games', description: 'H5 games portals: shared game catalogue (superadmin) and per-site config, ad units, ads.txt. See docs/GAMES_API.md' },
    { name: 'Funnels', description: 'Questions + rewarded video before chosen URLs' },
    { name: 'Ads', description: 'Stage 2: enable ads, manage ads.txt' },
    { name: 'Site', description: 'Config, deploys, live health' },
    { name: 'Jobs data', description: 'Shared jobs database (Cloud Run)' },
  ],
  paths: {
    '/v1/sites': {
      get: { tags: ['Launch'], summary: 'List launched sites', responses: { 200: json({ type: 'object', properties: { sites: { type: 'array', items: { type: 'object' } } } }) } },
      post: {
        tags: ['Launch'], summary: 'Launch a new site (stage 1)',
        requestBody: { required: true, content: { 'application/json': { schema: ref('LaunchInput') } } },
        responses: { 202: json(ref('SiteStatus'), 'Launch started; includes nameservers'), 400: json(ref('Error')), 409: json(ref('Error'), 'Domain already launched') },
      },
    },
    '/v1/sites/{id}': { get: { tags: ['Launch'], summary: 'Launch status (steps, progress, nameservers)', parameters: [id], responses: { 200: json(ref('SiteStatus')), 404: json(ref('Error')) } } },
    '/v1/sites/{id}/events': { get: { tags: ['Launch'], summary: 'Live launch progress (Server-Sent Events: `step`, `status`)', parameters: [id, { name: 'key', in: 'query', schema: { type: 'string' }, description: 'API key (EventSource cannot send headers)' }], responses: { 200: { description: 'text/event-stream' } } } },
    '/v1/sites/{id}/retry': { post: { tags: ['Launch'], summary: 'Resume a failed launch from the failed step', parameters: [id], responses: { 202: json(ref('SiteStatus')), 409: json(ref('Error')) } } },

    '/v1/sites/{id}/stories': {
      get: {
        tags: ['Stories'], summary: 'List stories (with counts per category, drafts, missing photos)', parameters: [id,
          ...['q', 'category'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })),
          { name: 'draft', in: 'query', schema: { type: 'boolean' } }, { name: 'missingImage', in: 'query', schema: { type: 'boolean' } },
          { name: 'sort', in: 'query', schema: { enum: ['newest', 'oldest', 'title'] } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: json({ type: 'object', properties: { counts: { type: 'object' }, matched: { type: 'integer' }, categories: { type: 'array' }, stories: { type: 'array', items: ref('StorySummary') } } }) },
      },
      post: {
        tags: ['Stories'], summary: 'Write new stories with Claude, one by one (your titles, ideas, library topics and/or extra); follow GET /v1/tasks/{taskId}', parameters: [id],
        requestBody: { required: true, content: { 'application/json': { schema: ref('NewStories') } } },
        responses: { 202: json(ref('TaskStarted')), 400: json(ref('Error')) },
      },
    },
    '/v1/sites/{id}/stories/{slug}': {
      get: { tags: ['Stories'], summary: 'One story: frontmatter + Markdown body (?format=markdown for the raw file)', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }, { name: 'format', in: 'query', schema: { enum: ['json', 'markdown'] } }], responses: { 200: json(ref('Story')), 404: json(ref('Error')) } },
      patch: {
        tags: ['Stories'], summary: 'Edit a story by hand (only the fields you send change)', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }],
        requestBody: { required: true, content: { 'application/json': { schema: ref('StoryEdit') } } },
        responses: { 202: accepted, 400: json(ref('Error')) },
      },
      put: {
        tags: ['Stories'], summary: 'Create or replace a story you wrote yourself (fields, or a full Markdown file); keeps the existing photo and date', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }],
        requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [ref('StoryEdit'), { type: 'object', required: ['markdown'], properties: { markdown: { type: 'string' }, deploy: { type: 'boolean' } } }] } } } },
        responses: { 201: accepted, 202: accepted, 400: json(ref('Error')) },
      },
      delete: { tags: ['Stories'], summary: 'Delete a story and its photo files', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }, { name: 'deploy', in: 'query', schema: { enum: ['0', '1'] } }], responses: { 202: accepted, 404: json(ref('Error')) } },
    },
    '/v1/sites/{id}/stories/{slug}/rewrite': {
      post: {
        tags: ['Stories'], summary: 'Rewrite one story with Claude (same URL, publish date and photo; sets updatedDate)', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, category: ref('Category'), angle: { type: 'string' }, instructions: { type: 'string' }, deploy: { type: 'boolean' } } } } } },
        responses: { 202: json(ref('TaskStarted')) },
      },
    },
    '/v1/sites/{id}/stories/{slug}/photo': {
      post: {
        tags: ['Stories'], summary: 'Replace the photo: the deploy picks a new Pixabay photo (never the old one), optionally from your search words', parameters: [id, { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, description: 'Story slug (the URL path)' }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string', example: 'remote team video call' } } } } } },
        responses: { 202: accepted },
      },
    },
    '/v1/sites/{id}/library': { get: { tags: ['Stories'], summary: 'Library topics for this site: which it has used and how many remain', parameters: [id], responses: { 200: json({ type: 'object' }) } } },
    '/v1/sites/{id}/photos/refresh': {
      post: {
        tags: ['Stories'], summary: 'New photos for many stories at once (default: every story whose photo looks off-topic)', parameters: [id],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
          slugs: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' },
          queries: { type: 'object', additionalProperties: { type: 'string' }, description: 'slug → your own photo search words' },
          dryRun: { type: 'boolean', description: 'List what would change; change nothing' } } } } } },
        responses: { 200: json({ type: 'object' }, 'Dry run, or nothing to change'), 202: accepted },
      },
    },
    '/v1/games': {
      get: { tags: ['Games'], summary: 'Game catalogue (filters: q, category, disabled)', responses: { 200: json({ type: 'object' }) } },
      post: { tags: ['Games'], summary: 'Superadmin: add a game from R2 ({ slug, categories? })', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 201: json({ type: 'object' }), 404: json(ref('Error')), 409: json(ref('Error')) } },
      patch: { tags: ['Games'], summary: 'Superadmin: edit many games in one commit ({ games: { slug: fields } })', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/categories': { get: { tags: ['Games'], summary: 'Categories with game counts', responses: { 200: json({ type: 'object' }) } } },
    '/v1/games/categories/rename': { post: { tags: ['Games'], summary: 'Superadmin: rename a category on every game ({ from, to })', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } } },
    '/v1/games/{slug}': {
      get: { tags: ['Games'], summary: 'One game with media URLs', parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } },
      patch: { tags: ['Games'], summary: 'Superadmin: edit title, tagline, description, how_to_play, categories, orientation, disabled', parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/sites': {
      get: { tags: ['Games'], summary: 'Games portals', responses: { 200: json({ type: 'object' }) } },
      post: { tags: ['Games'], summary: 'Launch a games portal ({ domain, name, theme, games, exclude, featured, categories, adsTxt, networkCode… })', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json(ref('SiteStatus')), 400: json(ref('Error')), 409: json(ref('Error')) } },
    },
    '/v1/games/sites/{id}': { get: { tags: ['Games'], summary: 'Portal + launch status', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/games/sites/{id}/retry': { post: { tags: ['Games'], summary: 'Resume a failed launch', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 202: json(ref('SiteStatus')), 409: json(ref('Error')) } } },
    '/v1/games/sites/{id}/config': {
      get: { tags: ['Games'], summary: 'site.json', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } },
      patch: { tags: ['Games'], summary: 'Edit name, tagline, description, language, theme, logo, games, exclude, featured, categories, contactEmail, assets', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/sites/{id}/games': { get: { tags: ['Games'], summary: 'Games on this portal with URLs and ad units', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/games/sites/{id}/ads': {
      get: { tags: ['Games'], summary: 'Ad mode, network, units per game and page slot', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } },
      patch: { tags: ['Games'], summary: 'Edit networkCode, patterns, siteUnits, games: { slug: units | null }', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/sites/{id}/ads/games/{slug}': {
      put: { tags: ['Games'], summary: 'Set a game\'s units on this portal ({ rewarded, interstitial, native })', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }, { name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
      delete: { tags: ['Games'], summary: 'Back to R2 ads.json / pattern', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }, { name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/sites/{id}/ads/enable': { post: { tags: ['Games'], summary: 'Live ads (stage 2), optional ads.txt lines', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } } },
    '/v1/games/sites/{id}/ads/disable': { post: { tags: ['Games'], summary: 'Back to test ads', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } } },
    '/v1/games/sites/{id}/ads.txt': {
      get: { tags: ['Games'], summary: 'ads.txt lines', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } },
      put: { tags: ['Games'], summary: 'Replace ads.txt', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
      patch: { tags: ['Games'], summary: 'Add/remove ads.txt lines', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 202: json({ type: 'object' }, 'Committed; Cloudflare Pages rebuilds'), 400: json(ref('Error')), 403: json(ref('Error')) } },
    },
    '/v1/games/sites/{id}/deploy': { post: { tags: ['Games'], summary: 'Rebuild now', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 202: json({ type: 'object' }) } } },
    '/v1/games/sites/{id}/deployments': { get: { tags: ['Games'], summary: 'Pages builds (?commit= or ?id= for one)', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/games/sites/{id}/health': { get: { tags: ['Games'], summary: 'Live checks', parameters: [{ name: 'id', in: 'path', required: true, description: 'Launch id (site_…), domain or site key', schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/me': { get: { tags: ['Library'], summary: 'Which key you used: role admin or superadmin', responses: { 200: json({ type: 'object', properties: { role: { type: 'string', enum: ['admin', 'superadmin'] }, superadminConfigured: { type: 'boolean' } } }) } } },
    '/v1/library': {
      get: { tags: ['Library'], summary: 'List base topics (filters: q, category, enabled, site)', parameters: ['q', 'category', 'enabled', 'site'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), responses: { 200: json({ type: 'object' }) } },
      post: {
        tags: ['Library'], summary: 'Superadmin: add headlines (category and summary filled in if left out; duplicates skipped)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['topics'], properties: { topics: { type: 'array', items: { oneOf: [{ type: 'string' }, ref('LibraryTopicInput')] } } } } } } },
        responses: { 201: json({ type: 'object' }), 403: json(ref('Error'), 'Not the superadmin key') },
      },
    },
    '/v1/library/suggest': {
      post: {
        tags: ['Library'], summary: 'Superadmin: Claude proposes new headlines that do not overlap the library ("save": true adds them)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer', maximum: 50 }, category: { type: 'string' }, theme: { type: 'string' }, save: { type: 'boolean' } } } } } },
        responses: { 200: json({ type: 'object' }), 201: json({ type: 'object' }), 403: json(ref('Error')) },
      },
    },
    '/v1/library/{topicId}': {
      get: { tags: ['Library'], summary: 'One topic and the sites that used it', parameters: [{ name: 'topicId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json(ref('LibraryTopic')), 404: json(ref('Error')) } },
      patch: { tags: ['Library'], summary: 'Superadmin: edit title, summary, category, enabled, position', parameters: [{ name: 'topicId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: ref('LibraryTopicInput') } } }, responses: { 200: json(ref('LibraryTopic')), 403: json(ref('Error')), 404: json(ref('Error')) } },
      delete: { tags: ['Library'], summary: 'Superadmin: delete a topic (stories already written stay)', parameters: [{ name: 'topicId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), 403: json(ref('Error')), 404: json(ref('Error')) } },
    },
    '/v1/sites/{id}/tasks': { get: { tags: ['Stories'], summary: 'Recent story-writing tasks for a site', parameters: [id, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/tasks/{taskId}': { get: { tags: ['Stories'], summary: 'Task progress with per-story status (pending → writing → written → published, or failed)', parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json(ref('Task')), 404: json(ref('Error')) } } },

    '/v1/sites/{id}/articles': {
      post: {
        tags: ['Content'], summary: 'Older: write stories from more library topics (prefer POST /v1/sites/{id}/stories with library)', deprecated: true,
        parameters: [id],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer', description: '0 = all remaining library topics' }, extra: { type: 'integer', maximum: 40 }, fromTopic: { type: 'integer' } } } } } },
        responses: { 202: json(ref('TaskStarted')) },
      },
    },
    '/v1/sites/{id}/images': { post: { tags: ['Content'], summary: 'Older: add photos from the Worker (photos are added on every deploy now)', deprecated: true, parameters: [id], responses: { 200: json({ type: 'object' }) } } },

    '/v1/sites/{id}/funnels': { get: { tags: ['Funnels'], summary: 'List funnels in priority order (the first funnel that covers a URL wins)', parameters: [id], responses: { 200: json({ type: 'object', properties: { funnels: { type: 'array', items: ref('Funnel') } } }) } } },
    '/v1/sites/{id}/funnels/match': { get: { tags: ['Funnels'], summary: 'Which funnel a URL gets (page gate, redirect, or none) and why', parameters: [id, { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'Full URL or path' }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/sites/{id}/funnels/{fid}': {
      get: { tags: ['Funnels'], summary: 'One funnel', parameters: [id, { name: 'fid', in: 'path', required: true, schema: { type: 'string' }, description: 'Funnel id, e.g. guide-unlock' }], responses: { 200: json(ref('Funnel')), 404: json(ref('Error')) } },
      put: { tags: ['Funnels'], summary: 'Create or replace a funnel (then deploys)', parameters: [id, { name: 'fid', in: 'path', required: true, schema: { type: 'string' }, description: 'Funnel id, e.g. guide-unlock' }], requestBody: { required: true, content: { 'application/json': { schema: ref('FunnelInput') } } }, responses: { 201: accepted, 202: accepted, 400: json(ref('Error')) } },
      patch: { tags: ['Funnels'], summary: 'Change some fields (position reorders; enabled:false pauses)', parameters: [id, { name: 'fid', in: 'path', required: true, schema: { type: 'string' }, description: 'Funnel id, e.g. guide-unlock' }], requestBody: { required: true, content: { 'application/json': { schema: ref('FunnelInput') } } }, responses: { 202: accepted, 400: json(ref('Error')) } },
      delete: { tags: ['Funnels'], summary: 'Delete a funnel', parameters: [id, { name: 'fid', in: 'path', required: true, schema: { type: 'string' }, description: 'Funnel id, e.g. guide-unlock' }], responses: { 202: accepted } },
    },
    '/v1/sites/{id}/funnels/{fid}/pages': {
      patch: { tags: ['Funnels'], summary: 'Add/remove URLs for a funnel (full URLs or paths; "/prefix/*", "*", "!/exclude")', parameters: [id, { name: 'fid', in: 'path', required: true, schema: { type: 'string' }, description: 'Funnel id, e.g. guide-unlock' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } }, deploy: { type: 'boolean' } } } } } },
        responses: { 202: accepted } },
    },

    '/v1/sites/{id}/ads': { get: { tags: ['Ads'], summary: 'Ads state + what the Price Optimiser runtime serves for the domain', parameters: [id], responses: { 200: json(ref('AdsState')) } } },
    '/v1/sites/{id}/ads/enable': {
      post: {
        tags: ['Ads'], summary: 'Stage 2: enable ads (checks the runtime serves this site key)', parameters: [id],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } }, text: { type: 'string' }, requireRuntime: { type: 'boolean', default: true } } } } } },
        responses: { 202: accepted, 409: json(ref('Error'), 'Runtime not serving this site key yet') },
      },
    },
    '/v1/sites/{id}/ads/disable': { post: { tags: ['Ads'], summary: 'Disable ads', parameters: [id], responses: { 202: accepted } } },
    '/v1/sites/{id}/ads.txt': {
      get: { tags: ['Ads'], summary: 'Configured ads.txt lines (send Accept: text/plain for the raw file)', parameters: [id], responses: { 200: json({ type: 'object', properties: { domain: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } } }) } },
      put: {
        tags: ['Ads'], summary: 'Replace ads.txt', parameters: [id],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } }, text: { type: 'string', description: 'Alternative: newline-separated' } } } } } },
        responses: { 202: accepted, 200: json({ type: 'object', properties: { changed: { const: false } } }, 'No change') },
      },
      patch: {
        tags: ['Ads'], summary: 'Add and/or remove ads.txt lines', parameters: [id],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { 202: accepted },
      },
    },

    '/v1/sites/{id}/config': {
      get: { tags: ['Site'], summary: 'Full site.config.json', parameters: [id], responses: { 200: json({ type: 'object' }) } },
      patch: {
        tags: ['Site'], summary: 'Update name, tagline, description, theme colours, contact email, find-jobs landing copy', parameters: [id],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, theme: { type: 'object', properties: { primary: { type: 'string' }, accent: { type: 'string' }, logoText: { type: 'string' } } }, legal: { type: 'object', properties: { contactEmail: { type: 'string' } } }, jobs: { type: 'object', properties: { landing: { type: 'object' } } } } } } } },
        responses: { 202: accepted },
      },
    },
    '/v1/sites/{id}/deploy': { post: { tags: ['Site'], summary: 'Redeploy a site (also fills missing photos)', parameters: [id], responses: { 202: json({ type: 'object', properties: { deploy: ref('Deploy') } }) } } },
    '/v1/deploys/{runKey}': { get: { tags: ['Site'], summary: 'Deploy status (queued | in_progress | completed + conclusion)', parameters: [{ name: 'runKey', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { status: { type: 'string' }, conclusion: { type: ['string', 'null'] }, url: { type: 'string' } } }) } } },
    '/v1/sites/{id}/health': { get: { tags: ['Site'], summary: 'Live checks: pages, ads.txt in sync, SDK tag, runtime, GA4 tag', parameters: [id], responses: { 200: json({ type: 'object' }) } } },

    '/v1/jobs/health': { get: { tags: ['Jobs data'], summary: 'Jobs database health + job count', responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/usage': { get: { tags: ['Jobs data'], summary: 'OpenWeb Ninja requests used this month vs cap', parameters: [{ name: 'month', in: 'query', schema: { type: 'string', example: '2026-11' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/search': { get: { tags: ['Jobs data'], summary: 'Search stored jobs', parameters: ['country', 'category', 'remote', 'level', 'q', 'location', 'limit', 'offset'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/companies': { get: { tags: ['Jobs data'], summary: 'Top employers', parameters: ['country', 'category', 'remote', 'limit'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/companies/{slug}': { get: { tags: ['Jobs data'], summary: 'Employer profile + open roles', parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/refresh': { post: { tags: ['Jobs data'], summary: 'Run a refresh now (uses OpenWeb Ninja requests)', parameters: ['country', 'category'].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })), responses: { 200: json({ type: 'object' }) } } },
    '/v1/jobs/enrich': { post: { tags: ['Jobs data'], summary: 'Enrich top employers now (logos + writeups)', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: json({ type: 'object' }) } } },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      LibraryTopic: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, category: { type: 'string' }, enabled: { type: 'boolean' }, position: { type: 'integer' }, usedBy: { type: 'array', items: { type: 'string' } } } },
      LibraryTopicInput: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, category: { type: 'string', enum: ['job-search-strategy', 'resume-cover-letters', 'interview-prep', 'salary-negotiation', 'workplace-success', 'career-change-growth'] }, enabled: { type: 'boolean' }, position: { type: 'integer' } } },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
      Deploy: { type: 'object', properties: { runKey: { type: 'string' }, statusUrl: { type: 'string' } } },
      Accepted: { type: 'object', properties: { changed: { type: 'boolean' }, commit: { type: 'string' }, deploy: ref('Deploy'), warnings: { type: 'array', items: { type: 'string' } } } },
      LaunchInput: {
        type: 'object', required: ['domain'],
        properties: {
          domain: { type: 'string', example: 'jobsthe.world' }, name: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' },
          niche: { type: 'string' }, country: { type: 'string', example: 'US' }, primaryColor: { type: 'string', example: '#1d4ed8' },
          useLibraryTopics: { type: 'boolean', default: true }, libraryLimit: { type: 'integer', description: 'Use the first N enabled library topics' }, libraryTopics: { type: 'array', items: { type: 'string' }, description: 'Exact library topic ids (GET /v1/library); overrides libraryLimit' }, generateArticles: { type: 'integer', maximum: 40 },
          imageProvider: { enum: ['pixabay', 'unsplash', 'none'] }, ga4MeasurementId: { type: 'string' }, webhookUrl: { type: 'string', format: 'uri' },
        },
      },
      SiteStatus: {
        type: 'object',
        properties: {
          siteId: { type: 'string' }, domain: { type: 'string' }, slug: { type: 'string' }, status: { enum: ['queued', 'running', 'waiting', 'live', 'live_with_warnings', 'failed'] },
          progress: { type: 'integer' }, nameservers: { type: ['array', 'null'], items: { type: 'string' } }, liveUrl: { type: ['string', 'null'] }, error: { type: ['string', 'null'] },
          steps: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, status: { enum: ['pending', 'running', 'waiting', 'done', 'warning', 'skipped', 'failed'] }, detail: { type: ['string', 'null'] } } } },
        },
      },
      Category: { enum: ['job-search-strategy', 'resume-cover-letters', 'interview-prep', 'salary-negotiation', 'workplace-success', 'career-change-growth'] },
      StorySummary: {
        type: 'object',
        properties: {
          slug: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
          pubDate: { type: ['string', 'null'] }, updatedDate: { type: ['string', 'null'] }, draft: { type: 'boolean' }, origin: { type: 'string' },
          readTime: { type: ['number', 'null'] }, wordCount: { type: 'integer' }, heroImage: { type: ['string', 'null'] }, hasImage: { type: 'boolean' }, seoTitle: { type: ['string', 'null'] },
        },
      },
      Story: { allOf: [{ $ref: '#/components/schemas/StorySummary' }, { type: 'object', properties: { frontmatter: { type: 'object' }, body: { type: 'string', description: 'Markdown, ## and ### headings, no H1' } } }] },
      StoryEdit: {
        type: 'object',
        properties: {
          title: { type: 'string' }, description: { type: 'string' }, category: { $ref: '#/components/schemas/Category' }, body: { type: 'string' },
          draft: { type: 'boolean' }, pubDate: { type: 'string', format: 'date' }, updatedDate: { type: 'string', format: 'date' }, heroAlt: { type: 'string' },
          seo: { type: 'object', properties: { title: { type: 'string' }, metaDescription: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, canonical: { type: 'string' }, noindex: { type: 'boolean' } } },
          faq: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } } } },
          sources: { type: 'array', items: { type: 'string' } }, related: { type: 'array', items: { type: 'string' } },
          deploy: { type: 'boolean', default: true, description: 'false = commit only (batch several edits, then POST /deploy)' },
        },
      },
      NewStories: {
        type: 'object',
        description: 'Any mix; at most 80 stories per task.',
        properties: {
          stories: { type: 'array', description: 'Your exact titles (strings, or objects)', items: { oneOf: [{ type: 'string' }, { type: 'object', required: ['title'], properties: { title: { type: 'string' }, category: { $ref: '#/components/schemas/Category' }, angle: { type: 'string' }, slug: { type: 'string' } } }] } },
          ideas: { type: 'array', items: { type: 'string' }, description: 'Briefs; Claude writes a fresh title for each' },
          extra: { type: 'integer', maximum: 40, description: 'Claude picks this many new topics' },
          library: { oneOf: [{ type: 'boolean', description: 'true = every library topic this site has not used yet' }, { type: 'object', properties: { topics: { type: 'array', items: { type: 'string' }, description: 'Exact library topic ids' }, count: { type: 'integer', description: 'How many unused topics (0 = all remaining)' }, fromTopic: { type: 'integer', description: 'Old index-based start (ignores usage)' } } }] },
          instructions: { type: 'string', description: 'Guidance for every story in this task' },
          draft: { type: 'boolean', description: 'Write as drafts (hidden until PATCH draft:false)' },
          deploy: { type: 'boolean', default: true },
        },
      },
      TaskStarted: { type: 'object', properties: { taskId: { type: 'string' }, site: { type: 'string' }, statusUrl: { type: 'string' } } },
      Task: {
        type: 'object',
        properties: {
          taskId: { type: 'string' }, site: { type: 'string' }, kind: { enum: ['add', 'rewrite'] },
          status: { enum: ['queued', 'planning', 'writing', 'deploying', 'complete', 'failed'] }, progress: { type: 'integer' },
          total: { type: 'integer' }, written: { type: 'integer' }, failed: { type: 'integer' }, deploy: { oneOf: [{ $ref: '#/components/schemas/Deploy' }, { type: 'null' }] },
          stories: { type: 'array', items: { type: 'object', properties: { idx: { type: 'integer' }, title: { type: 'string' }, slug: { type: 'string' }, category: { type: 'string' }, status: { enum: ['pending', 'writing', 'written', 'published', 'failed'] }, error: { type: ['string', 'null'] } } } },
          error: { type: ['string', 'null'] },
        },
      },
      FunnelInput: {
        type: 'object',
        properties: {
          title: { type: 'string', example: 'Quick question before you read' }, intro: { type: 'string' },
          steps: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', required: ['question', 'options'], properties: {
            question: { type: 'string' }, help: { type: 'string' }, key: { type: 'string', description: 'Optional; made from the question' },
            options: { type: 'array', minItems: 2, maxItems: 12, items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } }] } } } } },
          pages: { type: 'array', items: { type: 'string' }, description: 'On-page gate: "/exact", "https://site/exact", "/prefix/*", "*", "!/exclude"' },
          gate: { type: 'array', items: { type: 'string' }, description: 'Server pages that redirect to /start/<id> (e.g. /jobs)' },
          query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Only visits with these query values ("*" = any), e.g. {"utm_source":"facebook"}' },
          frequency: { enum: ['once', 'session', 'always'], default: 'once' }, rememberDays: { type: 'integer', default: 30 },
          rewarded: { type: 'object', properties: { enabled: { type: 'boolean', default: true }, title: { type: 'string' }, cta: { type: 'string' }, skip: { type: 'string' }, allowSkip: { type: 'boolean', default: true } } },
          trigger: { enum: ['page', 'apply'], default: 'page', description: 'apply = rewarded video before an external job link (no steps)' },
          message: { type: 'string', description: 'Apply funnels: overlay text; {company} and {title} are filled in' },
          applyFrequency: { enum: ['job', 'session', 'always'], default: 'job' },
          enabled: { type: 'boolean', default: true }, position: { type: 'integer', description: 'Priority (0 = first)' }, deploy: { type: 'boolean', default: true },
        },
      },
      Funnel: { allOf: [{ $ref: '#/components/schemas/FunnelInput' }, { type: 'object', properties: { id: { type: 'string' }, previewUrl: { type: ['string', 'null'], description: 'Opens the page with ?funnel=preview (always shows the funnel)' }, startUrl: { type: 'string' } } }] },
      AdsState: {
        type: 'object',
        properties: {
          domain: { type: 'string' }, enabled: { type: 'boolean' }, poSite: { type: ['string', 'null'] }, adsTxt: { type: 'array', items: { type: 'string' } },
          runtime: { type: 'object', properties: { reachable: { type: 'boolean' }, siteKey: { type: ['string', 'null'] }, configurationRevision: { type: ['integer', 'null'] }, serving: { type: 'boolean' } } },
        },
      },
    },
  },
} as const;
