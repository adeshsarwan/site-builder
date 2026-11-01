/// <reference types="astro/client" />
declare const __SITE_SLUG__: string;

declare namespace App {
  interface Locals {
    funnelAnswers?: Record<string, string>;
  }
}

declare module 'cloudflare:workers' {
  export const env: {
    SITE_SLUG?: string;
    SITE_DOMAIN?: string;
    JOBS_API_BASE?: string;
    JOBS_API_KEY?: string;
    [key: string]: unknown;
  };
}
