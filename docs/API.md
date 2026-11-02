# Site Builder API — frontend guide

Base URL: `https://sitebuilder.thebesads.com/api`
Machine-readable spec: `GET /api/openapi.json` (OpenAPI 3.1; import into Postman/Swagger or generate a typed client).

Every `/v1` call needs `Authorization: Bearer <API_KEY>`. Call the API from your frontend's **server** (API route, server action, backend) — never ship the key to browsers.

`{id}` in a path can be the launch id (`site_…`), the domain (`jobsthe.world`) or the site folder (`jobsthe-world`).

## How changes reach a live site

Anything that changes a site (stories, config, ads, ads.txt) is committed to GitHub and then deployed. Those calls return `202` with:

```json
{ "commit": "9f2c…", "deploy": { "runKey": "jobsthe-world-mh1x2k", "statusUrl": "/api/v1/deploys/jobsthe-world-mh1x2k" } }
```

Poll `GET /v1/deploys/{runKey}` every 10 s until `status: "completed"`; `conclusion: "success"` means the change is live (usually 2–4 minutes). Pass `"deploy": false` (or `?deploy=0`) to batch several edits, then `POST /v1/sites/{id}/deploy` once.

---

## 1. Launch a site (stage 1: stories, photos, SEO)

```http
POST /v1/sites
{ "domain": "newsite.com", "name": "New Site", "niche": "remote workers", "country": "US", "libraryLimit": 15, "generateArticles": 0 }
```
Returns `siteId`, `nameservers` (set them at the registrar) and `steps`. Follow progress with `GET /v1/sites/{id}` (poll) or `GET /v1/sites/{id}/events?key=<API_KEY>` (Server-Sent Events: `step`, `status`). A failed launch resumes with `POST /v1/sites/{id}/retry`. Ads are **not** turned on here; that is stage 2.

## 2. Stories

### How stories are written (one by one)
`POST /v1/sites/{id}/stories` starts a task that:
1. reads the site's existing titles so nothing overlaps,
2. plans: your own titles are kept as given (Claude only picks a category/angle if you leave them out); ideas, library topics and `extra` get fresh titles for this site,
3. writes each story on its own (4 at a time, 3 retries each; one failing story never stops the rest),
4. commits every batch of 4 as it finishes, so finished stories are kept even if a later one fails,
5. deploys once at the end — the deploy also gives every story without a photo a new Pixabay photo (downloaded and self-hosted, with credit).

### Add new stories
```http
POST /v1/sites/jobsthe.world/stories
{
  "stories": ["How to Ask for a Four-Day Week", { "title": "Remote Offer Red Flags", "category": "job-search-strategy" }],
  "ideas": ["visa sponsorship for remote roles"],
  "extra": 3,
  "library": { "count": 5 },
  "instructions": "UK spelling; include a checklist",
  "draft": false
}
→ 202 { "taskId": "stories-jobsthe-world-mh1x2k", "statusUrl": "/api/v1/tasks/stories-jobsthe-world-mh1x2k" }
```
Use any mix of `stories` (exact titles), `ideas` (briefs), `extra` (Claude picks topics) and `library` (`true` = all remaining starting-library topics; or `{ fromTopic, count }` — see `GET /v1/sites/{id}/library`). Max 80 per task. `draft: true` writes them hidden; publish later with `PATCH … { "draft": false }`.

Categories: `job-search-strategy`, `resume-cover-letters`, `interview-prep`, `salary-negotiation`, `workplace-success`, `career-change-growth`.

### Follow progress (per story)
```http
GET /v1/tasks/{taskId}
→ { "status": "writing", "progress": 40, "total": 10, "written": 4, "failed": 0,
    "stories": [ { "idx": 0, "title": "…", "slug": "…", "status": "published" }, { "idx": 4, "status": "writing" }, … ],
    "deploy": null }
```
Task `status`: `queued → planning → writing → deploying → complete` (or `failed`). Story `status`: `pending → writing → written → published` (or `failed` with `error`). When `deploy` appears, poll its `statusUrl` to know when the stories are live. `GET /v1/sites/{id}/tasks` lists recent tasks.

### List and read
```http
GET /v1/sites/jobsthe.world/stories?q=salary&category=salary-negotiation&draft=false&missingImage=false&sort=newest&limit=50&offset=0
GET /v1/sites/jobsthe.world/stories/{slug}                 → summary + frontmatter + Markdown body
GET /v1/sites/jobsthe.world/stories/{slug}?format=markdown → the raw .md file
```
The list includes `counts` (total, drafts, missingImage, byCategory) for dashboards.

### Edit by hand
```http
PATCH /v1/sites/jobsthe.world/stories/{slug}
{ "title": "…", "description": "…", "category": "interview-prep", "body": "## …", "draft": false,
  "seo": { "title": "…", "metaDescription": "…", "keywords": ["…"] }, "faq": [{ "q": "…", "a": "…" }] }
```
Only the fields you send change. Editing `title` or `body` sets `updatedDate` (send `"touch": false` to skip). The body is Markdown with `##`/`###` headings and no `#` H1.

### Your own story
```http
PUT /v1/sites/jobsthe.world/stories/my-story-slug
{ "title": "…", "description": "…", "category": "workplace-success", "body": "## …" }
```
or `{ "markdown": "---\ntitle: …\n---\n## …" }`. Creates the story (201) or replaces it (202), keeping its photo and publish date. A photo is added on deploy if it has none.

### Rewrite, re-photo, delete
```http
POST   /v1/sites/{id}/stories/{slug}/rewrite  { "instructions": "shorter, add a table", "title": "optional new title" }   → task
POST   /v1/sites/{id}/stories/{slug}/photo    { "query": "remote team video call" }   → new photo on deploy, never the old one
DELETE /v1/sites/{id}/stories/{slug}                                                    → removes the story and its photo files
```
A rewrite keeps the URL, publish date and photo, and sets `updatedDate`.

## 3. Ads (stage 2)

After you create the ad units in Price Optimiser for the domain:
```http
POST /v1/sites/jobsthe.world/ads/enable
{ "lines": ["google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0"] }
```
The call returns `409` until `serve.thebesads.com/runtime/config?site=<domain>` serves that site key (override with `"requireRuntime": false`). `GET /v1/sites/{id}/ads` shows the state plus what the runtime serves; `POST /v1/sites/{id}/ads/disable` turns ads off.

### Change ads.txt any time
```http
GET   /v1/sites/{id}/ads.txt                     → { lines: [...] }   (Accept: text/plain → the raw file)
PUT   /v1/sites/{id}/ads.txt  { "lines": [...] }  or { "text": "line1\nline2" }   → replace everything
PATCH /v1/sites/{id}/ads.txt  { "add": [...], "remove": [...] }                    → incremental change
```
Lines are trimmed and de-duplicated. Comments (`#`) and variables (`OWNERDOMAIN=`, `MANAGERDOMAIN=`, `CONTACT=` …) are kept. Lines that don't look like `domain, account, DIRECT|RESELLER[, cert]` are kept but reported in `warnings`. When nothing changes the call returns `200 { changed: false }`. Once the deploy finishes, `GET /v1/sites/{id}/health` reports whether the live `https://<domain>/ads.txt` matches.

## 4. Site settings, deploys, health
```http
GET   /v1/sites/{id}/config
PATCH /v1/sites/{id}/config  { "name", "tagline", "description", "theme": { "primary", "accent", "logoText" }, "legal": { "contactEmail" }, "jobs": { "landing": {…} } }
POST  /v1/sites/{id}/deploy
GET   /v1/deploys/{runKey}
GET   /v1/sites/{id}/health   → live checks: home/find-jobs pages, ads.txt in sync, SDK tag, runtime, GA4 tag
```

## 5. Shared jobs data
```http
GET  /v1/jobs/health | /v1/jobs/usage?month=2026-11
GET  /v1/jobs/search?country=us&category=software&remote=true&q=react&limit=20
GET  /v1/jobs/companies?country=us | /v1/jobs/companies/{slug}
POST /v1/jobs/refresh?country=us&category=software   (uses OpenWeb Ninja requests)
POST /v1/jobs/enrich?limit=20                        (logos + writeups)
```
Visitor searches on the sites read only from the stored jobs database, never OpenWeb Ninja.

## Errors
`{ "error": "message" }` with `400` (bad input), `401` (missing/wrong key), `404` (site or story not found), `409` (state conflict, e.g. runtime not serving yet), `5xx` (upstream: GitHub, Claude, Cloudflare).
