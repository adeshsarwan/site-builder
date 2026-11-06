// Site config for the site being built. Resolved at build time through the @site alias,
// so every Worker carries exactly one site's settings.
import raw from '@site/site.config.json';

export interface FunnelOption { value: string; label: string }
export interface FunnelStep { key: string; question: string; help?: string; options: FunnelOption[] }
export interface Funnel {
  id: string;
  title: string;
  intro?: string;
  /** Path prefixes that require this funnel to be completed first, e.g. ["/jobs"] */
  gate: string[];
  steps: FunnelStep[];
  /** Step index (0-based) after which an interstitial opportunity is requested. Omit for none. */
  interstitialAfterStep?: number;
  /** Cookie lifetime in days */
  rememberDays?: number;
  /** Offer an opt-in rewarded video before showing results (preloaded while the visitor answers). */
  rewarded?: { enabled: boolean; title?: string; cta?: string; skip?: string; allowSkip?: boolean };
  /**
   * On-page gate: on these URLs the questions appear the moment the visitor lands, then the rewarded
   * video, then the page itself. Patterns: "/exact-path", "/prefix/*", "*" (every page), "!/path" (exclude).
   */
  pages?: string[];
  /** Only gate visits whose URL has these query values ("*" = any value), e.g. { "utm_source": "facebook" } */
  query?: Record<string, string>;
  /** once = once per rememberDays (default), session = once per browser session, always = every page view */
  frequency?: 'once' | 'session' | 'always';
  /**
   * "page" (default): questions + video before the URLs in `pages`.
   * "apply": video before leaving for an external job link (Apply / job title). `pages` optionally limits where.
   */
  trigger?: 'page' | 'apply';
  /** Apply funnels: text in the overlay; {company} and {title} are filled in. */
  message?: string;
  /** Apply funnels: how often to ask. job = once per job per visit (default), session = once per visit, always = every click */
  applyFrequency?: 'job' | 'session' | 'always';
  /** false = paused (kept in config, not shown) */
  enabled?: boolean;
}
export interface Category { slug: string; name: string; description: string }

export interface SiteConfig {
  slug: string;
  domain: string;
  name: string;
  tagline: string;
  description: string;
  locale: string;
  country: string;
  theme: { primary: string; accent: string; logoText?: string };
  categories: Category[];
  nav?: { label: string; href: string }[];
  ads: {
    enabled: boolean;
    poSite: string;
    sdkUrl: string;
    runtimeUrl: string;
    adsTxt: string[];
    /** Show the sticky anchor container */
    anchor?: boolean;
  };
  analytics: { ga4MeasurementId?: string };
  searchConsole?: { googleSiteVerification?: string };
  jobs: {
    enabled: boolean; pageSize: number; defaultQuery: Record<string, string>; countries?: FunnelOption[]; categories?: FunnelOption[];
    /** Job-search landing page at /find-jobs */
    landing?: { headline: string; subhead: string; popular: { label: string; href: string }[]; defaultCountry?: string };
  };
  funnels: Funnel[];
  legal: { companyName: string; contactEmail: string };
  social?: { defaultImage?: string };
}

export const site = raw as SiteConfig;
export const origin = `https://${site.domain}`;
export const abs = (path: string) => new URL(path, origin).href;
export const categoryBySlug = (slug: string) => site.categories.find((c) => c.slug === slug);
