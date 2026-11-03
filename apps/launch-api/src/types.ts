export interface Env {
  DB: D1Database;
  LAUNCH: Workflow<LaunchParams>;
  CONTENT: Workflow<any>;
  API_KEY: string;
  /** Second key for the superadmin (base topic library). Optional; without it nobody can edit the library. */
  SUPERADMIN_KEY?: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GCP_SA_JSON?: string;
  GA4_ACCOUNT_ID?: string;
  OWNER_EMAILS?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  WEBHOOK_SECRET?: string;
  PO_RUNTIME_URL?: string;
  IMAGE_PROVIDER?: string;
  PIXABAY_API_KEY?: string;
  UNSPLASH_ACCESS_KEY?: string;
  DRY_RUN?: string;
}

export interface LaunchInput {
  domain: string;
  name?: string;
  tagline?: string;
  description?: string;
  niche?: string;
  country?: string;
  primaryColor?: string;
  /** Write one NEW article per starting-library topic (topics only; no text is reused). Default true. */
  useLibraryTopics?: boolean;
  /** Cap on library topics used (default: all enabled topics). */
  libraryLimit?: number;
  /** Exact library topic ids to write from (GET /v1/library), in this order. Overrides "the first libraryLimit topics". */
  libraryTopics?: string[];
  /** Extra brand-new topics beyond the library (0–40). Default 0. */
  generateArticles?: number;
  /** "pixabay" (download + self-host), "unsplash" (hotlink + credit) or "none". Default from IMAGE_PROVIDER. */
  imageProvider?: 'pixabay' | 'unsplash' | 'none';
  /** Use an existing GA4 web stream (G-XXXX) instead of creating a property. */
  ga4MeasurementId?: string;
  adsTxt?: string[];
  jobsDefaultQuery?: Record<string, string>;
  webhookUrl?: string;
}

export interface LaunchParams { siteId: string; attempt: number }

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'warning' | 'skipped' | 'failed';
export type SiteStatus = 'queued' | 'running' | 'waiting' | 'live' | 'live_with_warnings' | 'failed';

export const STEPS = [
  { key: 'zone', label: 'Domain on Cloudflare' },
  { key: 'nameservers', label: 'Waiting for nameservers' },
  { key: 'analytics', label: 'Create GA4 property' },
  { key: 'content', label: 'Write articles + photos' },
  { key: 'repo', label: 'Commit site to GitHub' },
  { key: 'deploy', label: 'Build & deploy' },
  { key: 'custom_domain', label: 'Attach domain + SSL' },
  { key: 'search_console', label: 'Verify Search Console + sitemap' },
  { key: 'ads', label: 'Ads configuration' },
  { key: 'smoke_test', label: 'Check site is live' },
] as const;
export type StepKey = (typeof STEPS)[number]['key'];

export class StepWarning extends Error {}
export class StepSkipped extends Error {}

export const slugFromDomain = (d: string) => d.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
