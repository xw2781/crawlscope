import { blankPage } from '../../src/crawler.js';
import { buildContext } from '../../src/crawler.js';
import { resolveOptions } from '../../src/options.js';
import type { CheckContext, LinkRecord, PageRecord, RobotsInfo, SiteProbes, SitemapFile, SitemapUrl } from '../../src/types.js';

export const BASE = 'https://example.test';

export function page(path: string, patch: Partial<PageRecord> = {}): PageRecord {
  const url = path.startsWith('http') ? path : BASE + path;
  const p = blankPage(url, 'link', 1);
  Object.assign(p, {
    status: 200, statusText: 'OK', isHtml: true, contentType: 'text/html', responseTimeMs: 50, sizeBytes: 5000, indexable: true, indexabilityReason: 'indexable',
    title: 'A reasonably descriptive page title for tests', metaDescription: 'A reasonably descriptive meta description for the test page, long enough to pass.',
    headings: [{ level: 1, text: 'Heading' }], canonicals: [url], lang: 'en', viewport: 'width=device-width', wordCount: 400, titleCount: 1, metaDescriptionCount: 1,
  }, patch);
  return p;
}

export function link(from: string, to: string, patch: Partial<LinkRecord> = {}): LinkRecord {
  return { from: BASE + from, to: BASE + to, type: 'a', anchor: 'text', rel: [], nofollow: false, internal: true, imageOnly: false, ...patch };
}

export const robotsOk: RobotsInfo = { url: BASE + '/robots.txt', status: 200, present: true, fetchError: null, mode: 'rules', sizeBytes: 10, parsed: { groups: [], sitemaps: [], warnings: [] }, raw: '' };
export const siteOk: SiteProbes = { soft404: { url: BASE + '/x', status: 404 }, httpRedirect: { tested: true, startUrl: 'http://example.test/', status: 301, location: BASE + '/', redirectsToHttps: true }, favicon: { url: BASE + '/favicon.ico', status: 200, declaredInHtml: false }, hsts: 'max-age=1', isHttps: true };

export function ctx(pages: PageRecord[], extra: { links?: LinkRecord[]; robots?: RobotsInfo; sitemaps?: SitemapFile[]; sitemapUrls?: SitemapUrl[]; site?: SiteProbes; complete?: boolean; opts?: Parameters<typeof resolveOptions>[0] } = {}): CheckContext {
  const options = resolveOptions({ url: BASE + '/', ...(extra.opts ?? {}) });
  return buildContext(options, BASE + '/', pages, extra.links ?? [], extra.robots ?? robotsOk, extra.sitemaps ?? [], extra.sitemapUrls ?? [], [], extra.site ?? siteOk, null, extra.complete ?? true);
}
