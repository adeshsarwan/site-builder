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
  jobs: { enabled: boolean; pageSize: number; defaultQuery: Record<string, string>; countries?: FunnelOption[]; categories?: FunnelOption[] };
  funnels: Funnel[];
  legal: { companyName: string; contactEmail: string };
  social?: { defaultImage?: string };
}

export const site = raw as SiteConfig;
export const origin = `https://${site.domain}`;
export const abs = (path: string) => new URL(path, origin).href;
export const categoryBySlug = (slug: string) => site.categories.find((c) => c.slug === slug);
