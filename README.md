# site-builder

One Astro codebase, many job sites. Push to `main` and changed sites deploy to Cloudflare.
`POST /api/v1/sites` on the Launch API sets up a new domain end to end and reports progress.

```
apps/web/          Shared Astro 7 app (articles, categories, live jobs, funnels, Price Optimiser ads)
apps/launch-api/   Cloudflare Worker + Workflows + D1 — the Launch API
sites/<slug>/      One folder per site: site.config.json + content/articles/*.md
sites/_template/   Config template used for new launches
sites/_library/    Topic list for new sites (titles/summaries only — never published or copied)
.github/workflows/ deploy.yml (sites) · deploy-launch-api.yml (API)
```

## How a site is built

- `SITE=<slug>` selects the folder; `apps/web/scripts/prepare-site.mjs` writes `wrangler.jsonc` with Worker name `site-<slug>`.
- Articles, categories, legal pages, sitemap, robots, ads.txt are prerendered static files (free, cached at the edge).
- `/jobs` and `/start/<funnel>` are server-rendered in the Worker. `/jobs` calls your jobs API with `JOBS_API_BASE` / `JOBS_API_KEY` (Worker secrets) and caches responses for 5 minutes. Until those are set, demo listings show.
- Funnels: any path in a funnel's `gate` redirects to `/start/<id>` until answered; answers go in an httpOnly cookie and become jobs API filters. Configure questions in `site.config.json`.

### Ads (Price Optimiser)

Implemented exactly as the publisher integration guide says:
- One SDK tag, `defer`, `data-auto-init="false"`, `data-po-site` = the site's `ads.poSite`, then `/assets/price-optimiser-integration.js` (also `defer`). No async, no inline init, no GPT code anywhere else.
- Registered DIVs, each at most once per page: `ad-leaderboard` (all pages), `ad-anchor` (all pages), `ad-sidebar`, `ad-incontent` / `-2` / `-3` (inserted before the 2nd/4th/6th H2 of articles), `ad-results` (jobs page). Space is reserved in CSS.
- `window.siteAds` exposes `preloadNextViewAds`, `revealNextViewAds`, `showRewardAfterOptIn`, `requestInterstitialOpportunity`. Funnels request an interstitial after `interstitialAfterStep`.
- Every new domain needs a published Price Optimiser configuration whose `siteKey` is that domain. The Launch API checks the runtime and reports a warning until it exists.

## One-time setup

1. **Cloudflare API token** (Account → API Tokens) with: Zone:Edit, DNS:Edit, Zone Settings:Edit, Workers Scripts:Edit, Workers Routes:Edit, Zone Rulesets (Single Redirect):Edit, D1:Edit, Workers KV:Edit — scoped to your account.
2. **GitHub repo secrets** (Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional `JOBS_API_BASE`, `JOBS_API_KEY`.
3. **Google Cloud**: create a service account; enable *Site Verification API*, *Google Search Console API*, *Google Analytics Admin API*; add the service account's email as **Editor** on your GA4 account. Download its JSON key.
4. **GitHub token for the Launch API**: fine-grained PAT on `adeshsarwan/site-builder` with *Contents: Read and write* and *Actions: Read and write*.
5. Push to `main` → `deploy-launch-api.yml` deploys the API and creates/migrates the D1 database. Then set its secrets:
   ```sh
   cd apps/launch-api
   npx wrangler secret put API_KEY            # long random string your frontend backend sends
   npx wrangler secret put CF_API_TOKEN
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GCP_SA_JSON        # paste the JSON key
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put PIXABAY_API_KEY    # and/or UNSPLASH_ACCESS_KEY
   npx wrangler secret put WEBHOOK_SECRET     # optional
   ```
   Set `GA4_ACCOUNT_ID` (numeric) and `ALLOWED_ORIGINS` in `wrangler.jsonc` vars. The API is served at `https://sitebuilder.thebesads.com/api` (custom domain in `wrangler.jsonc`; needs the thebesads.com zone in the same Cloudflare account).

## Launch API

All `/api/v1` routes need `Authorization: Bearer <API_KEY>`. Call it from your frontend's **server** (never ship the key to browsers). The events stream also accepts `?key=` because `EventSource` can't send headers — proxy it through your backend.

| Method | Path | |
| --- | --- | --- |
| POST | `/api/v1/sites` | Start a launch. Returns `202` with status + `nameservers` |
| GET | `/api/v1/sites` | List launches |
| GET | `/api/v1/sites/:id` | Status (id or domain) |
| GET | `/api/v1/sites/:id/events` | Server-Sent Events: `step` and `status` events |
| POST | `/api/v1/sites/:id/retry` | Resume a failed launch from the failed step |

```http
POST /api/v1/sites
{
  "domain": "jobsthe.world",
  "name": "Jobs The World",
  "tagline": "Find work that fits your life",
  "niche": "job seekers worldwide",
  "country": "US",
  "primaryColor": "#1d4ed8",
  "useLibraryTopics": true,
  "generateArticles": 5,
  "imageProvider": "pixabay",
  "adsTxt": ["google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0"],
  "webhookUrl": "https://your-frontend.example/api/launch-webhook"
}
```

Steps, in order: `zone` → `nameservers` (waits until Cloudflare reports the zone active) → `analytics` (GA4) → `content` (new articles + photos, written fresh for this site) → `repo` (one commit) → `deploy` (GitHub Actions) → `custom_domain` (Worker custom domain, SSL, www→apex) → `search_console` (DNS verification, property, sitemap) → `ads` (Price Optimiser runtime check) → `smoke_test`.

Step statuses: `pending | running | waiting | done | warning | skipped | failed`.
Site statuses: `queued | running | waiting | live | live_with_warnings | failed`.

Webhooks: each change POSTs `{ "type": "site.status", "data": <status> }` with `X-Launch-Signature: sha256=<hmac of body with WEBHOOK_SECRET>`.

### Frontend example

```ts
// server: start
const r = await fetch(`https://sitebuilder.thebesads.com/api/v1/sites`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) });
const { siteId, nameservers } = await r.json(); // show nameservers to set at the registrar

// browser: live progress via your own proxy route that forwards /api/v1/sites/:id/events
const es = new EventSource(`/api/launch/${siteId}/events`);
es.addEventListener('status', (e) => render(JSON.parse(e.data))); // { status, progress, steps[] }
```

### Content notes

- Every launched site gets its own articles. The library supplies only topic titles and one-line summaries; Claude plans a new title and angle for the site's audience and writes each article from scratch (new structure, wording, examples, SEO title, meta description, keywords, FAQ). No source text is reused and nothing links or canonicalises to another site.
- Hero photos: `pixabay` (default) downloads the photo and commits it to `sites/<slug>/public/images/`, served from the site's own domain, as Pixabay's API terms require. `unsplash` hotlinks `images.unsplash.com`, triggers download tracking and shows the photographer credit with UTM links, as Unsplash's API guidelines require. Both show a credit line under the photo.
- Bylines are "<Site> Editorial Team"; Claude is told not to invent statistics or people. Review generated articles before relying on them.
- Cost and time scale with article count. Use `libraryLimit` to cap topics (e.g. 20 for a first launch).

## Local development

```sh
cd apps/web && npm i && SITE=careertrailhead node scripts/prepare-site.mjs && SITE=careertrailhead npx astro dev
cd apps/launch-api && npm i && printf 'API_KEY=dev-key\nDRY_RUN=true\n' > .dev.vars && npx wrangler d1 migrations apply launch-db --local && npx wrangler dev
```
`DRY_RUN=true` runs the full launch workflow with external calls mocked.
