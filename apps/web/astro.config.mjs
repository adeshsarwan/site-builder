// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { fileURLToPath } from 'node:url';
import { loadSiteConfig, siteDir } from './scripts/site-config.mjs';
import rehypeAdSlots from './src/plugins/rehype-ad-slots.mjs';

const site = loadSiteConfig();

export default defineConfig({
  site: `https://${site.domain}`,
  output: 'static', // pages are prerendered unless they set `export const prerender = false`
  trailingSlash: 'never',
  build: { format: 'file' },
  adapter: cloudflare({ imageService: 'passthrough' }),
  markdown: {
    rehypePlugins: [[rehypeAdSlots, { enabled: site.ads?.enabled !== false, slots: site.ads?.slots ?? null }]],
  },
  vite: {
    resolve: {
      alias: {
        '@site': siteDir(site.slug),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __SITE_SLUG__: JSON.stringify(site.slug),
    },
  },
});
