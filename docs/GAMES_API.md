# H5 Games Portals API — frontend guide

Same API, key and rules as the jobs sites (see [API.md](API.md)): base URL `https://sitebuilder.thebesads.com/api`,
`Authorization: Bearer <API_KEY>` on every `/v1` call, call it from your server.

**What is shared and what is per site**

| Shared by every portal (the catalogue) | Different on each portal |
|---|---|
| The games (one copy in R2, `games.gamewhame.com/<slug>/`) | Domain, name, tagline, description, theme, logo |
| Title, tagline, description, how to play, categories, orientation | Which games it shows (`games`, `exclude`), `featured` order, which categories it lists |
| Icons, cover, screenshots (`<slug>/media/`) | Ad units inside each game (rewarded / interstitial / native) and on its pages |
| | ads.txt, GA4, Search Console |

The catalogue lives in `catalog/games.json` and each portal in `sites/<siteKey>/site.json` in
[`h5-games-site-builder`](https://github.com/adeshsarwan/h5-games-site-builder). Every change is a commit there;
Cloudflare Pages rebuilds the affected sites by itself (1–3 minutes). A catalogue change rebuilds every portal;
a site change rebuilds only that portal.

`{id}` for a portal can be the launch id (`site_…`), the domain (`playfun.com`) or the site key (`playfun-com`, or `demo`).

---

## 1. The game catalogue (shared metadata)

Reading works with any key. **Changing it needs the `SUPERADMIN_KEY`**, because it changes every site at once.

```http
GET  /v1/games?q=pong&category=Arcade&disabled=false   → { total, categories, games: [ { slug, title, tagline, description, how_to_play, categories, orientation, disabled, media: { icon512, icon192, thumb, cover } } ] }
GET  /v1/games/{slug}
GET  /v1/games/categories                               → [ { name, games } ]
```

### Edit one game
```http
PATCH /v1/games/beer-pong
{
  "title": "Beer Pong: Trick Shots",
  "tagline": "Sink the ball in every cup.",
  "description": "Paragraphs separated by a blank line…",
  "how_to_play": ["Swipe up to throw the ball.", "Land it in a cup to clear it.", "Clear every cup to win."],
  "categories": ["Arcade", "Sports"],
  "orientation": "portrait",
  "disabled": false
}
→ 202 { game, commit, deploy: { note } }
```
Only the fields you send change. `how_to_play` takes a list of steps (or one string with a line per step). `disabled: true`
takes the game off **every** portal without deleting it. A category is just a name: put a new one on a game and it exists.

### Edit many games in one commit
```http
PATCH /v1/games
{ "games": { "craps": { "disabled": true }, "roulette": { "title": "Roulette Royale" } } }
```
If any slug is unknown or any field is invalid, nothing is saved.

### Rename a category everywhere
```http
POST /v1/games/categories/rename   { "from": "Brain", "to": "Logic" }
```
Then update the `categories` list of portals that show it (§2, config).

### Add a new game
Upload the build, `media/` and `catalog/game.json` to R2 first (see the builder's SPEC), then:
```http
POST /v1/games   { "slug": "new-game", "categories": ["Puzzle"] }
```
It copies the text from `catalog/game.json` into the catalogue. Every portal with `"games": "all"` gets it on the build that follows.

---

## 2. Portals

### Launch
```http
POST /v1/games/sites
{
  "domain": "playfun.com",
  "name": "PlayFun",
  "tagline": "Free games, no downloads",
  "description": "SEO text for the home page",
  "primaryColor": "#7c3aed",
  "theme": { "background": "#f3e8ff" },
  "logo": { "text": "PlayFun", "mark": "P" },
  "games": "all",
  "exclude": ["craps", "roulette"],
  "featured": ["water-sort", "beer-pong"],
  "categories": ["Puzzle", "Casual", "Arcade"],
  "contactEmail": "hello@playfun.com",
  "networkCode": "23360556473",
  "adsTxt": ["google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0"],
  "webhookUrl": "https://your-frontend.example/api/launch-webhook"
}
→ 202 { siteId, siteKey, nameservers, steps, statusUrl, eventsUrl }
```
Only `domain` is required. Show `nameservers` to set at the registrar. Steps, in order:
`zone` → `nameservers` (waits until Cloudflare reports the zone active) → `analytics` (GA4: finds the domain's property or creates one, then adds the custom dimensions, metrics and key events below) → `repo` (`sites/<key>/site.json`)
→ `pages` (Cloudflare Pages project `games-<key>`, built from the repo with `SITE=<key>`, rebuilt only by its own folder
or shared code/catalogue) → `deploy` → `custom_domain` (whatever served apex + www before is detached — Worker custom domains and routes, then A/AAAA/CNAME records, listed in the step detail so you can put them back — then domain attached, SSL, www → apex)
→ `search_console` (DNS verification, property, sitemap) → `ads` (skipped: test ads until stage 2) → `smoke_test`.

Progress: poll `GET /v1/games/sites/{id}` or stream `GET /v1/sites/{id}/events?key=<API_KEY>` (SSE `step` / `status`, same as jobs).
Webhooks, step and site statuses are the same as for jobs sites. A failed launch resumes with `POST /v1/games/sites/{id}/retry`; `?force=1` also restarts a running launch's current step (finished steps are kept).

```http
GET /v1/games/sites            → { sites: [...], notLaunchedByApi: ["demo"] }
GET /v1/games/sites/{id}       → { siteKey, domain, pagesProject, adsMode, analytics: { measurementId, property, propertyId, keyEvents }, launch: { status, progress, steps } }
```

### Settings
```http
GET   /v1/games/sites/{id}/config       → the site.json
PATCH /v1/games/sites/{id}/config
{ "name", "tagline", "description", "language", "theme": { … }, "logo": { … }, "games": "all" | [slugs], "exclude": [slugs],
  "featured": [slugs], "categories": [names], "contactEmail", "assets": "proxy" | "cdn" }
→ 202 { config, commit, deploy: { statusUrl } }
```
`theme` and `logo` merge with what is there; the other fields replace. Unknown game slugs are refused.

```http
GET /v1/games/sites/{id}/games   → the games this portal shows, with page URL, play URL, the ad units each one gets, media
```

### Ad units
Inside each game, units are chosen in this order:
1. **Test mode** (`mode: "test"`, the default until stage 2) or no domain → Google's sample units.
2. Units set for that game on this site (`ads.games[slug]` in site.json, set below).
3. `games.gamewhame.com/<slug>/sites/<siteKey>/ads.json` in R2, if your GAM automator wrote one.
4. The pattern: `/{network}/{domain}_{game}_{kind}`, e.g. `/23360556473/playfun.com_water_sort_rewarded`.

So if your GAM units follow the pattern, you don't have to set anything per game.

```http
GET   /v1/games/sites/{id}/ads   → { mode, networkCode, pageSlots: { game_side: { sizes, unit } … }, games: { slug: { source, units } } }

PUT    /v1/games/sites/{id}/ads/games/water-sort
       { "rewarded": "/23360556473/playfun.com_water_sort_rewarded", "interstitial": "/…_interstitial", "native": "/…_native" }
DELETE /v1/games/sites/{id}/ads/games/water-sort          → back to R2 / pattern

PATCH  /v1/games/sites/{id}/ads
{
  "networkCode": "23360556473",
  "gameUnitPattern": "/{network}/{domain}_{game}_{kind}",
  "siteUnitPattern": "/{network}/{domain}_{slot}",
  "siteUnits": { "home_rect": "/23360556473/playfun_home", "game_side": null },
  "games": { "beer-pong": { "rewarded": "…", "interstitial": "…", "native": "…" }, "craps": null }
}
```
Page slots are `game_side`, `home_rect` and `game_below`; `null` resets one to the pattern.

### Stage 2: live ads and ads.txt
```http
POST /v1/games/sites/{id}/ads/enable   { "lines": ["google.com, pub-…, DIRECT, f08c47fec0942fa0"] }
POST /v1/games/sites/{id}/ads/disable  → back to test ads
GET  /v1/games/sites/{id}/ads.txt      (Accept: text/plain → the raw file)
PUT  /v1/games/sites/{id}/ads.txt      { "lines": [...] } or { "text": "…" }
PATCH /v1/games/sites/{id}/ads.txt     { "add": [...], "remove": [...] }
```
Add a consent banner (Google CMP) before serving real ads to visitors in the EEA/UK.

### Analytics (GA4)
The launch step and this endpoint do the same idempotent setup in GA account `GA4_ACCOUNT_ID` (Thebesads): find the
property for the site (by Measurement ID, else by the web stream's domain) or create one (time zone `GA4_TIME_ZONE`,
default `Asia/Singapore`, USD), then add whatever is missing:

| What | Values |
|---|---|
| Custom dimensions (event scope) | `game`, `placement`, `page_type`, `app_name`, `list`, `source`, `view`, `ad_slot` |
| Custom metrics | `seconds_played` (seconds), `list_position` (standard) |
| Key events | `game_start`, `store_click` (created before GA has seen them, so no 24-hour wait) |
| Data retention | 14 months (event and user data) |

These match the events the portal sends (`src/app.js` in `h5-games-site-builder`); keep the two lists in sync
(`apps/launch-api/src/games/analytics.ts`). Nothing is ever deleted.

```http
POST /v1/games/sites/{id}/analytics/setup   { "measurementId"?: "G-…", "property"?: "properties/123" }
→ 200 { changed: false, measurementId, property, createdProperty, setup: { dimensions, metrics, keyEvents, retention, errors }, summary }
→ 202 { changed: true, …, commit, deploy }   when site.json gets a new analytics.ga4 / analytics.ga4Property (site rebuilds)
```
Works for sites made by hand too (`{id}` = site key, e.g. `torunex-site`). `analytics.propertyId` in `GET /v1/games/sites/{id}` is the
property to use when linking GA4 to Ad Manager and Google Ads from your frontend (available once the `analytics` step is done). Not done by the API: the Ad Manager link (frontend)
and the Google Ads link. Enhanced measurement is on by default for every new web stream.

### Deploys and health
Every change returns `commit` and `deploy.statusUrl`:
```http
GET  /v1/games/sites/{id}/deployments?commit=9f2c…   → { status: queued | building | success | failure | canceled, url }
GET  /v1/games/sites/{id}/deployments               → the last 10 builds
POST /v1/games/sites/{id}/deploy                     → rebuild now (e.g. after new media in R2)
GET  /v1/games/sites/{id}/health                     → status of /, robots, sitemap, ads.txt, one game page, its /play/ and gam-config.js;
                                                       ads.txt in sync; whether the game serves this site's units; GA4 tag
```

## Errors
Same as jobs: `{ "error": "…" }` with `400`, `401`, `403` (catalogue change without the superadmin key), `404`, `409` (domain already used,
no domain for live ads), `5xx` (GitHub or Cloudflare).

## One-time setup
- `CF_API_TOKEN` needs **Cloudflare Pages: Edit** (plus the zone/DNS permissions it already has) on the games account
  (`GAMES_CF_ACCOUNT_ID` in `wrangler.jsonc`). New portal domains are added as zones in that account.
- `GITHUB_TOKEN` must also have **Contents: Read and write** on `h5-games-site-builder`, or set a separate `GAMES_GITHUB_TOKEN` secret.
- The Cloudflare Pages GitHub app must have access to the repo (it does, from the first site).
- GA4: `GCP_SA_JSON` service account must be **Editor** on GA account `GA4_ACCOUNT_ID` (Account access management), and the
  Google Analytics Admin API must be enabled in its Cloud project (`site-builder-513503`).
