import { site, origin, abs } from './site';
import type { Article } from './articles';

export interface PageSeo {
  title: string;
  description: string;
  path: string;
  canonical?: string;
  ogType?: 'website' | 'article';
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
  jsonLd?: object[];
}

const orgLd = () => ({
  '@type': 'Organization',
  '@id': `${origin}/#org`,
  name: site.name,
  url: origin,
});

export function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name: site.name,
    url: origin,
    description: site.description,
    publisher: { '@id': `${origin}/#org` },
    inLanguage: site.locale,
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.path) })),
  };
}

/** Canonical: keep a cross-domain canonical (library copies point at the original); otherwise self. */
export function articleCanonical(a: Article) {
  const self = abs(`/${a.id}`);
  const c = a.data.seo?.canonical;
  if (!c) return self;
  try {
    return new URL(c).host === site.domain ? self : c;
  } catch {
    return self;
  }
}

export function articleSeo(a: Article, categoryName: string): PageSeo {
  const d = a.data;
  const url = abs(`/${a.id}`);
  const image = d.seo?.ogImage || d.heroImage || site.social?.defaultImage || '';
  const published = d.pubDate?.toISOString();
  const modified = (d.updatedDate ?? d.pubDate)?.toISOString();
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: d.title,
    description: d.seo?.metaDescription || d.description,
    mainEntityOfPage: url,
    url,
    image: image ? [abs(image)] : undefined,
    author: { '@type': 'Person', name: d.author },
    publisher: { ...orgLd(), '@context': undefined },
    articleSection: categoryName,
    datePublished: published,
    dateModified: modified,
    wordCount: d.wordCount,
    inLanguage: site.locale,
  };
  const ld: object[] = [article, breadcrumbLd([{ name: 'Home', path: '/' }, { name: categoryName, path: `/category/${d.categorySlug}` }, { name: d.title, path: `/${a.id}` }])];
  if (d.faq.length) {
    ld.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: d.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    });
  }
  return {
    title: d.seo?.title || `${d.title} | ${site.name}`,
    description: d.seo?.metaDescription || d.description,
    path: `/${a.id}`,
    canonical: articleCanonical(a),
    ogType: 'article',
    image,
    imageAlt: d.heroAlt,
    noindex: d.seo?.noindex,
    jsonLd: ld,
  };
}
