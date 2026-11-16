import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawl } from '../../src/crawler.js';
import { resolveOptions } from '../../src/options.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';
import type { CrawlResult } from '../../src/types.js';
import { decodeBody } from '../../src/util/charset.js';
import { parseLinkHeader, parseMetaRefresh, xRobotsDirectives } from '../../src/util/headers.js';

let server: FixtureServer;
let r: CrawlResult;
const NO_RULES = 'User-agent: *\nAllow: /\n';
const page = (p: string) => r.pages.find((x) => x.url === server.origin + p)!;
const has = (id: string, path?: string) => r.issues.some((i) => i.checkId === id && (!path || i.url === server.origin + path));

beforeAll(async () => {
  server = await startFixtureServer({ robotsText: NO_RULES });
  r = await crawl(resolveOptions({ url: server.origin + '/edge/hub', delayMs: 0, maxUrlsPerPattern: 20 }));
}, 60000);
afterAll(() => server.close());

describe('unit helpers', () => {
  it('decodes charsets from header, meta and fallback', () => {
    expect(decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=iso-8859-1').text).toBe('café');
    expect(decodeBody(Buffer.from('<meta charset="windows-1252">caf\xe9', 'latin1'), 'text/html').text).toContain('café');
    expect(decodeBody(Buffer.from([0x63, 0xe9]), 'text/html').charset).toBe('windows-1252');
    expect(decodeBody(Buffer.from('café'), 'text/html').text).toBe('café');
    expect(decodeBody(Buffer.from([0, 1, 2, 3]), 'text/html').binary).toBe(true);
  });
  it('parses Link, X-Robots-Tag and meta refresh values', () => {
    expect(parseLinkHeader('<https://a.test/x>; rel="canonical", <https://a.test/fr>; rel="alternate"; hreflang="fr"')).toEqual([
      { url: 'https://a.test/x', rel: ['canonical'], hreflang: null }, { url: 'https://a.test/fr', rel: ['alternate'], hreflang: 'fr' }]);
    expect(xRobotsDirectives('noindex, nofollow')).toEqual(['noindex', 'nofollow']);
    expect(xRobotsDirectives('otherbot: noindex')).toEqual([]);
    expect(xRobotsDirectives('googlebot: noindex, max-snippet: 5')).toEqual(['noindex', 'max-snippet: 5']);
    expect(parseMetaRefresh('5; url=/next')).toEqual({ delay: 5, url: '/next' });
    expect(parseMetaRefresh("0;URL='http://x.test/'")).toEqual({ delay: 0, url: 'http://x.test/' });
    expect(parseMetaRefresh('30')).toEqual({ delay: 30, url: null });
  });
});

describe('edge cases on the fixture', () => {
  it('decodes non-UTF-8 pages', () => {
    expect(page('/edge/latin1').title).toBe('Café au lait crème and more words for the title');
    expect(page('/edge/latin1').charset).toBe('windows-1252');
    expect(page('/edge/sniffed').title).toContain('Naïve café');
  });
  it('does not parse binary data served as HTML', () => {
    const p = page('/edge/binary');
    expect(p.isHtml).toBe(false);
    expect(p.indexabilityReason).toMatch(/binary/);
  });
  it('caps huge bodies and flags them', () => {
    const p = page('/edge/huge');
    expect(p.bodyTruncated).toBe(true);
    expect(p.sizeBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(has('body-truncated', '/edge/huge')).toBe(true);
  });
  it('flags meta refresh and follows its target', () => {
    expect(page('/edge/refresh').metaRefresh).toEqual({ delay: 3, url: server.origin + '/edge/refresh-target' });
    expect(has('meta-refresh', '/edge/refresh')).toBe(true);
    expect(page('/edge/refresh-target').status).toBe(200);
  });
  it('resolves links and canonical against a relative <base href>', () => {
    expect(page('/edge/sub/leaf').status).toBe(200);
    expect(page('/edge/base').canonicals).toEqual([server.origin + '/edge/sub/leaf']);
  });
  it('records iframe and srcset URLs without crawling them', () => {
    const p = page('/edge/embeds');
    expect(p.resources?.iframes).toEqual([server.origin + '/edge/iframe-target']);
    expect(p.resources?.srcset).toEqual([server.origin + '/edge/img-1x.png', server.origin + '/edge/img-2x.png']);
    expect(server.requests.some((q) => /iframe-target|img-[12]x/.test(q.path))).toBe(false);
  });
  it('reads canonical, hreflang (Link header) and X-Robots-Tag', () => {
    const p = page('/edge/header-canon');
    expect(p.canonicalHeader).toBe(server.origin + '/edge/hub');
    expect(p.canonicals).toContain(server.origin + '/edge/hub');
    expect(p.hreflang.some((h) => h.source === 'header' && h.lang === 'fr')).toBe(true);
    expect(p.noindex).toBe(true);
    expect(p.indexable).toBe(false);
  });
  it('notices trailing-slash duplicates', () => {
    expect(r.issues.filter((i) => i.checkId === 'url-duplicate-variant')).toHaveLength(1);
  });
  it('never requests absurdly long URLs and records them as failed', () => {
    const long = r.pages.find((p) => p.url.includes('/edge/long-xxxx'))!;
    expect(long.fetchError?.code).toBe('URL_TOO_LONG');
    expect(server.requests.some((q) => q.path.length > 4096)).toBe(false);
    expect(has('fetch-failed')).toBe(true);
    // 2000-char query is fetched and flagged
    expect(r.pages.find((p) => p.url.includes('qqqq'))!.status).toBe(200);
    expect(has('url-too-long')).toBe(true);
  });
  it('stops an endless calendar after --max-urls-per-pattern and warns', () => {
    const cal = r.pages.filter((p) => p.url.includes('/edge/cal/'));
    expect(cal.length).toBe(20);
    expect(r.site.trapPatterns?.[0].pattern).toContain('/edge/cal/');
    expect(has('crawl-trap-suspected')).toBe(true);
  });
});

describe('robots.txt unreachable', () => {
  it('finishes gracefully, blocks the crawl and reports it', async () => {
    const s = await startFixtureServer({ robotsHang: true });
    const res = await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, maxRetries: 0 }));
    expect(res.robots.mode).toBe('disallow-all');
    expect(res.robots.fetchError).toBeTruthy();
    expect(res.pages.every((p) => p.blockedByRobots)).toBe(true);
    expect(res.issues.some((i) => i.checkId === 'robots-unreachable')).toBe(true);
    await s.close();
  });
});
