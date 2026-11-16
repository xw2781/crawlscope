import type { CrawlOptions, Thresholds } from './types.js';
import { DEFAULT_UA } from './fetcher.js';

export const DEFAULT_THRESHOLDS: Thresholds = {
  slowMs: 1000,
  verySlowMs: 3000,
  largeHtmlBytes: 1024 * 1024,
  titleMax: 60,
  titleMin: 30,
  descMax: 160,
  descMin: 70,
  thinWords: 200,
  urlMaxLength: 115,
  deepPage: 4,
  nearDuplicateDistance: 6,
};

export function resolveOptions(partial: Partial<CrawlOptions> & { url: string }): CrawlOptions {
  return {
    maxPages: null,
    maxDepth: null,
    concurrency: 4,
    delayMs: 250,
    include: [],
    exclude: [],
    userAgent: DEFAULT_UA,
    respectRobots: true,
    respectNofollow: false,
    subdomains: false,
    externalCheck: false,
    timeoutMs: 15000,
    maxBodyBytes: 5 * 1024 * 1024,
    maxRetries: 2,
    maxUrlsPerPattern: 1000,
    maxRetryWaitMs: 30000,
    sitemapUrls: [],
    aiBotsCheck: false,
    resume: false,
    outDir: null,
    ...partial,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(partial.thresholds ?? {}) },
  };
}
