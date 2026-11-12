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
  "priceOptimiserScript": "https://serve.thebesads.com/sdk/playfun.com.js",
  "adsTxt": ["google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0"],
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
  "content": "torunex-site",
  "networkCode": "23360556473",
  "webhookUrl": "https://your-frontend.example/api/launch-webhook"
}
→ 202 { siteId, siteKey, nameservers, steps, statusUrl, eventsUrl }
```
Only `domain` is required (`url` works too: `https://www.playfun.com` → `playfun.com`). Show `nameservers` to set at the registrar.

- `design`: `"vibrant"` (default, the torunex.site design: separate desktop and mobile game pages, sidebar ad) or `"classic"`.
- `priceOptimiserScript`: the Price Optimiser `<script src>` tag, its https URL, or `true` for
  `https://serve.thebesads.com/sdk/<domain>.js`. With it the pages carry no GPT slots of their own: the script fills
  `gam-native-01` (sidebar on desktop) and `gam-native-02` (above "More free games"), plus interstitial and rewarded
  (`ads.mode: "off"`, `ads.nativeSlots: true`). The `ads` step then shows the script instead of being skipped, and
  `POST …/ads/enable` is refused for that site.
- **Launching before the script exists** (e.g. while GAM verifies the site): leave `priceOptimiserScript` out. The
  site goes live with no ad divs and no GPT (`ads.mode: "off"`), and ads.txt is already published for the GAM check.
  When the script is ready: `PATCH /v1/games/sites/{id}/config { "priceOptimiserScript": "…" }`. That adds the script
  and the `gam-native-01` / `gam-native-02` divs, and the site rebuilds in 1–3 minutes. `"adsMode": "test"` at launch
  gives the old Google test ads instead.
- For the Rules API SDK (`https://serve.thebesads.com/sdk/publisher-sdk.js`) the stored tag always carries
  `data-po-site="<domain>"` and `data-po-runtime-config-url="https://serve.thebesads.com/runtime/config"` (taken from
  the tag you send if present, otherwise these defaults). Without them the SDK falls back to the legacy
  `priceoptimiser1.thebesads.com/v1/runtime-config`, which 404s. A tag pointing at the legacy runtime, or with a
  `data-po-site` that isn't the site's domain, is refused with 400. `data-auto-init="false"` is dropped (games pages
  have no init script).
- The div ids are fixed by the site, not the script: every Price Optimiser config for a games site needs two native
  slots with domId `gam-native-01` and `gam-native-02` (sizes 300x250, 336x280), plus interstitial and rewarded.
- `content`: the lists, reviews, mobile game pages and blog (home page "What should I download?", `/best/`,
  `/topgames/`, `/blog/`, `/how-we-review/`). **On by default**: new portals copy them from `GAMES_CONTENT_FROM`
  (`torunex-site`). Pass another site key or domain to copy from that site, or `false` for a games-only portal.
  The site gets `"content": { "dir": "<source folder>", "replaceNames": { … } }`, with the source's brand names
  rewritten to this site's name, domain and contact email; `{site}` in the content files becomes the site name.
- **Own lists per site** (`newLists`, default `true`): after site.json is written, the `lists` step has Claude write
  this site's own best-of lists (10–14, new titles: it is given every other site's list titles to avoid), home-page
  picks, ~12 reviews and How-we-review page, using only games from the shared pool with their live Google Play facts.
  Saved to `content/<siteKey>/editorial.json` (`content.editorialDir`). The mobile game pages and Play data stay shared.
  If generation fails the step is a warning and the site launches with the source's lists. `newLists: false` shares them.
- `adsTxt`: the lines, or the whole file as one string; invalid lines are refused with `400`. Steps, in order:
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
  "featured": [slugs], "categories": [names], "contactEmail", "assets": "proxy" | "cdn",
  "design": "vibrant" | "classic", "priceOptimiserScript": "<tag or URL>" | true | null,
  "content": "<site key or domain to copy lists/reviews/blog from>" | null }
→ 202 { config, commit, deploy: { statusUrl } }
```
`theme` and `logo` merge with what is there; the other fields replace. Unknown game slugs are refused.
`priceOptimiserScript: null` removes the script and its ad divs (no ads until it is added again).
`content: "torunex-site"` adds (or refreshes) the lists, reviews, mobile game pages and blog on a site launched without
them; send it again after changing `name` or `contactEmail` so the names in the content follow. `content: null` removes them.

```http
POST /v1/games/sites/{id}/content/lists   → 202 { lists: [titles], reviews: [paths], avoided, pool, commit, deploy }
```
Writes new lists, reviews and How-we-review text for the site (1–3 minutes; the GitHub Action "Games site new lists"
runs it). Use it after adding `content` to an existing site, or to refresh a site's lists.

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
