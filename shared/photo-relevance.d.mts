export const CATEGORY_QUERY: Record<string, string>;
export const GENERIC_QUERIES: string[];
export const WORK_WORDS: Set<string>;
export const OFF_TOPIC_WORDS: Set<string>;
export function photoScore(tags: string, query?: string): number;
export const MIN_PHOTO_SCORE: number;
export function looksOffTopic(alt: string): boolean;
export function imageQueries(primary: string | undefined, categorySlug: string): string[];
export function bestHit<T extends { tags?: string }>(hits: T[], query: string, isUsed?: (h: T) => boolean): T | null;
