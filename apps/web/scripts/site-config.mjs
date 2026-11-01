// Shared by astro.config.mjs, content.config.ts and the CI scripts.
// The site being built is chosen with the SITE env var (folder name under /sites).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function siteDir(slug) {
  return path.join(repoRoot, 'sites', slug);
}

export function loadSiteConfig(slug = process.env.SITE || 'careertrailhead') {
  const file = path.join(siteDir(slug), 'site.config.json');
  if (!existsSync(file)) throw new Error(`No site config at ${file}. Set SITE=<folder under /sites>.`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  if (cfg.slug !== slug) throw new Error(`site.config.json slug "${cfg.slug}" must match folder "${slug}"`);
  return cfg;
}
