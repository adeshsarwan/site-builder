import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const SITE = process.env.SITE || 'careertrailhead';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: `../../sites/${SITE}/content/articles` }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    slug: z.string(),
    category: z.string(),
    categorySlug: z.string(),
    author: z.string(),
    authorBio: z.string().optional().default(''),
    pubDate: z.coerce.date().nullable().optional(),
    updatedDate: z.coerce.date().nullable().optional(),
    readTime: z.number().nullable().optional(),
    wordCount: z.number().optional(),
    heroImage: z.string().optional().default(''),
    heroAlt: z.string().optional().default(''),
    draft: z.boolean().optional().default(false),
    // "generated" = written by the Launch API with Claude; "library" = copied from another site (canonical points to the original)
    origin: z.enum(['original', 'library', 'generated']).optional().default('original'),
    seo: z
      .object({
        title: z.string().optional(),
        metaDescription: z.string().optional(),
        canonical: z.string().optional(),
        ogTitle: z.string().optional(),
        ogDescription: z.string().optional(),
        ogType: z.string().optional(),
        ogImage: z.string().optional(),
        twitterCard: z.string().optional(),
        noindex: z.boolean().optional(),
      })
      .optional()
      .default({}),
    related: z.array(z.string()).optional().default([]),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).optional().default([]),
    sources: z.array(z.string()).optional().default([]),
  }),
});

export const collections = { articles };
