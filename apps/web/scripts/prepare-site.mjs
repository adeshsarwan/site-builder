#!/usr/bin/env node
// Writes apps/web/wrangler.jsonc for the site in $SITE before `astro build`.
// Each site deploys as its own Worker named `site-<slug>`; the custom domain is attached by the Launch API.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig } from './site-config.mjs';

const site = loadSiteConfig();
const config = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: `site-${site.slug}`,
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  observability: { enabled: true },
  vars: {
    SITE_SLUG: site.slug,
    SITE_DOMAIN: site.domain,
  },
  // JOBS_API_BASE / JOBS_API_KEY are Worker secrets, set by CI (wrangler secret bulk).
};

const out = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`wrangler.jsonc written for ${site.slug} (${site.domain})`);
