// Postgres storage for jobs. DATABASE_URL works with Cloud SQL (unix socket via ?host=/cloudsql/PROJECT:REGION:INSTANCE)
// or any hosted Postgres. Tests use PGlite (real Postgres in-process) with DATABASE_URL=pglite:memory.

const KEEP_DAYS = () => Number(process.env.KEEP_DAYS ?? 21);
const MONTHLY_CAP = () => Number(process.env.MONTHLY_CAP ?? 9500);

let dbPromise = null;
async function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is not set');
      let q;
      if (url.startsWith('pglite:')) {
        const { PGlite } = await import('@electric-sql/pglite');
        const lite = new PGlite();
        q = (text, params) => lite.query(text, params);
      } else {
        const { default: pg } = await import('pg');
        const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
        q = (text, params) => pool.query(text, params);
      }
      await migrate(q);
      return q;
    })().catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function migrate(q) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS jobs (
       id          TEXT PRIMARY KEY,
       country     TEXT NOT NULL,
       categories  TEXT[] NOT NULL DEFAULT '{}',
       title       TEXT NOT NULL,
       company     TEXT NOT NULL DEFAULT '',
       location    TEXT NOT NULL DEFAULT '',
       remote      BOOLEAN NOT NULL DEFAULT FALSE,
       salary      TEXT,
       type        TEXT,
       level       TEXT,
       posted_at   TIMESTAMPTZ,
       url         TEXT NOT NULL,
       publisher   TEXT,
       logo        TEXT,
       snippet     TEXT,
       fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
       search      TSVECTOR GENERATED ALWAYS AS (
         setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
         setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
         setweight(to_tsvector('english', coalesce(location, '') || ' ' || coalesce(snippet, '')), 'C')
       ) STORED
     )`,
    `CREATE INDEX IF NOT EXISTS jobs_search_idx ON jobs USING GIN (search)`,
    `CREATE INDEX IF NOT EXISTS jobs_country_posted_idx ON jobs (country, posted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS jobs_categories_idx ON jobs USING GIN (categories)`,
    `CREATE TABLE IF NOT EXISTS api_usage (month TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0)`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS website TEXT`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_slug TEXT GENERATED ALWAYS AS (trim(both '-' from regexp_replace(lower(company), '[^a-z0-9]+', '-', 'g'))) STORED`,
    `CREATE INDEX IF NOT EXISTS jobs_company_slug_idx ON jobs (company_slug)`,
    `CREATE TABLE IF NOT EXISTS companies (
       slug        TEXT PRIMARY KEY,
       name        TEXT NOT NULL,
       website     TEXT,
       industry    TEXT,
       description TEXT,
       logo        BYTEA,
       logo_type   TEXT,
       logo_source TEXT,
       enriched_at TIMESTAMPTZ
     )`,
  ]) await q(sql);
}

const COLS = ['id', 'country', 'title', 'company', 'location', 'remote', 'salary', 'type', 'level', 'posted_at', 'url', 'publisher', 'logo', 'snippet', 'website'];

/** Upserts fresh jobs for a bucket. A job found under several categories keeps all of them. */
export async function upsertJobs(country, category, jobs) {
  const q = await db();
  for (const j of jobs) {
    const vals = [j.id, j.country || country, j.title, j.company ?? '', j.location ?? '', Boolean(j.remote), j.salary ?? null, j.type ?? null, j.level ?? null, j.postedAt ?? null, j.url, j.publisher ?? null, j.logo ?? null, j.snippet ?? null, j.website ?? null, [category]];
    await q(
      `INSERT INTO jobs (${COLS.join(', ')}, categories) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1})
       ON CONFLICT (id) DO UPDATE SET
         ${COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
         categories = ARRAY(SELECT DISTINCT unnest(jobs.categories || EXCLUDED.categories)),
         fetched_at = now()`,
      vals,
    );
  }
}

/** Deletes jobs older than KEEP_DAYS (by posted date, or fetch date when unknown). */
export async function prune() {
  const q = await db();
  const r = await q(`DELETE FROM jobs WHERE coalesce(posted_at, fetched_at) < now() - ($1 || ' days')::interval`, [String(KEEP_DAYS())]);
  return r.rowCount ?? r.affectedRows ?? 0;
}

/** Visitor search — reads the database only. */
export async function searchJobs({ country, category, remoteOnly, level, q: text, location, limit, offset, companySlug }) {
  const q = await db();
  const where = country ? ['country = $1'] : ['$1::text IS NULL'];
  const params = [country ?? null];
  if (companySlug) { params.push(companySlug); where.push(`company_slug = $${params.length}`); }
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (category) add('? = ANY(categories)', category);
  if (remoteOnly) where.push('remote');
  if (level) add('(level IS NULL OR level = ?)', level);
  if (location && location !== 'remote') add('location ILIKE ?', `%${location}%`);
  let order = 'posted_at DESC NULLS LAST';
  if (text) {
    add("search @@ websearch_to_tsquery('english', ?)", text);
    order = `ts_rank(search, websearch_to_tsquery('english', $${params.length})) DESC, ${order}`;
  }
  params.push(limit, offset);
  const r = await q(
    `SELECT ${COLS.join(', ')}, company_slug, count(*) OVER() AS total FROM jobs WHERE ${where.join(' AND ')}
     ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const rows = r.rows ?? [];
  return {
    total: rows.length ? Number(rows[0].total) : 0,
    jobs: rows.map((x) => ({
      id: x.id, title: x.title, company: x.company, location: x.location, country: x.country, remote: x.remote,
      salary: x.salary ?? undefined, type: x.type ?? undefined, level: x.level ?? undefined,
      postedAt: x.posted_at ? new Date(x.posted_at).toISOString() : undefined, url: x.url,
      publisher: x.publisher ?? undefined, logo: x.logo ?? undefined, snippet: x.snippet ?? undefined, companySlug: x.company_slug ?? undefined,
    })),
  };
}

/** Monthly JSearch request counter. Returns false (and counts nothing) if `n` more would exceed MONTHLY_CAP. */
export async function useRequests(n) {
  const q = await db();
  const month = new Date().toISOString().slice(0, 7);
  const r = await q(
    `INSERT INTO api_usage (month, requests) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET requests = api_usage.requests + EXCLUDED.requests
     WHERE api_usage.requests + EXCLUDED.requests <= $3
     RETURNING requests`,
    [month, n, MONTHLY_CAP()],
  );
  return (r.rows ?? []).length > 0 && n <= MONTHLY_CAP();
}

export async function usage(month) {
  const q = await db();
  const r = await q('SELECT month, requests FROM api_usage WHERE month = $1', [month]);
  return r.rows?.[0] ?? null;
}

/** Companies with the most open roles in the database (for "top companies" sections). */
export async function topCompanies({ country, category, remoteOnly, limit }) {
  const q = await db();
  const where = ["country = $1", "company <> ''"];
  const params = [country];
  if (category) { params.push(category); where.push(`$${params.length} = ANY(categories)`); }
  if (remoteOnly) where.push('remote');
  params.push(limit);
  const r = await q(
    `SELECT company, max(company_slug) AS slug,
            count(*)::int AS jobs,
            count(*) FILTER (WHERE remote)::int AS remote_jobs,
            max(logo) AS logo,
            (array_agg(title ORDER BY posted_at DESC NULLS LAST))[1:3] AS titles,
            (array_agg(salary ORDER BY posted_at DESC NULLS LAST) FILTER (WHERE salary IS NOT NULL))[1] AS salary,
            mode() WITHIN GROUP (ORDER BY location) AS top_location,
            max(posted_at) AS latest
       FROM jobs WHERE ${where.join(' AND ')}
      GROUP BY company
      ORDER BY count(*) DESC, max(posted_at) DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );
  const slugs = (r.rows ?? []).map((x) => x.slug);
  const info = new Map();
  if (slugs.length) {
    const c = await q(`SELECT slug, industry, description, logo IS NOT NULL AS has_logo FROM companies WHERE slug = ANY($1)`, [slugs]);
    for (const row of c.rows ?? []) info.set(row.slug, row);
  }
  return (r.rows ?? []).map((x) => ({
    slug: x.slug, hasLogo: Boolean(info.get(x.slug)?.has_logo), industry: info.get(x.slug)?.industry ?? undefined,
    summary: info.get(x.slug)?.description ? String(info.get(x.slug).description).split(/(?<=\.)\s/)[0] : undefined,
    company: x.company, jobs: x.jobs, remoteJobs: x.remote_jobs, logo: x.logo ?? undefined,
    titles: x.titles ?? [], salary: x.salary ?? undefined, topLocation: x.top_location ?? undefined,
    latest: x.latest ? new Date(x.latest).toISOString() : undefined,
  }));
}

/** Top employers (all countries) that have no writeup yet, or one older than `staleDays`. */
export async function companiesToEnrich(limit, staleDays = 30) {
  const q = await db();
  const r = await q(
    `SELECT j.company_slug AS slug, max(j.company) AS name, count(*)::int AS jobs,
            (array_agg(j.logo ORDER BY j.posted_at DESC NULLS LAST) FILTER (WHERE j.logo IS NOT NULL))[1] AS logo_url,
            (array_agg(j.website ORDER BY j.posted_at DESC NULLS LAST) FILTER (WHERE j.website IS NOT NULL))[1] AS website,
            (array_agg(j.title ORDER BY j.posted_at DESC NULLS LAST))[1:12] AS titles,
            array_agg(DISTINCT j.country) AS countries,
            count(*) FILTER (WHERE j.remote)::int AS remote_jobs,
            (array_agg(DISTINCT j.location))[1:6] AS locations,
            (SELECT array_agg(DISTINCT c) FROM unnest(array_agg(j.categories)) AS c) AS categories
       FROM jobs j LEFT JOIN companies c ON c.slug = j.company_slug
      WHERE j.company <> '' AND (c.enriched_at IS NULL OR c.enriched_at < now() - ($2 || ' days')::interval)
      GROUP BY j.company_slug
      ORDER BY count(*) DESC
      LIMIT $1`,
    [limit, String(staleDays)],
  );
  return r.rows ?? [];
}

export async function saveCompany({ slug, name, website, industry, description, logo, logoType, logoSource }) {
  const q = await db();
  await q(
    `INSERT INTO companies (slug, name, website, industry, description, logo, logo_type, logo_source, enriched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, website = coalesce(EXCLUDED.website, companies.website),
       industry = coalesce(EXCLUDED.industry, companies.industry), description = coalesce(EXCLUDED.description, companies.description),
       logo = coalesce(EXCLUDED.logo, companies.logo), logo_type = coalesce(EXCLUDED.logo_type, companies.logo_type),
       logo_source = coalesce(EXCLUDED.logo_source, companies.logo_source), enriched_at = now()`,
    [slug, name, website ?? null, industry ?? null, description ?? null, logo ?? null, logoType ?? null, logoSource ?? null],
  );
}

export async function getCompany(slug) {
  const q = await db();
  const c = (await q(`SELECT slug, name, website, industry, description, logo IS NOT NULL AS has_logo FROM companies WHERE slug = $1`, [slug])).rows?.[0];
  const s = (await q(
    `SELECT max(company) AS name, count(*)::int AS jobs, count(*) FILTER (WHERE remote)::int AS remote_jobs,
            array_agg(DISTINCT country) AS countries
       FROM jobs WHERE company_slug = $1`, [slug])).rows?.[0];
  if (!c && !s?.jobs) return null;
  return {
    slug, name: c?.name ?? s?.name ?? slug, website: c?.website ?? undefined, industry: c?.industry ?? undefined,
    description: c?.description ?? undefined, hasLogo: Boolean(c?.has_logo),
    jobs: s?.jobs ?? 0, remoteJobs: s?.remote_jobs ?? 0, countries: s?.countries ?? [],
  };
}

export async function getLogo(slug) {
  const q = await db();
  const r = await q(`SELECT logo, logo_type FROM companies WHERE slug = $1 AND logo IS NOT NULL`, [slug]);
  const row = r.rows?.[0];
  return row ? { bytes: Buffer.from(row.logo), type: row.logo_type || 'image/png' } : null;
}

export async function ping() {
  const q = await db();
  const r = await q('SELECT count(*)::int AS jobs FROM jobs');
  return r.rows[0].jobs;
}
