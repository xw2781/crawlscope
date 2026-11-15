import { describe, expect, it } from 'vitest';
import { ALL_CHECKS, getCheck, runChecks } from '../../src/checks/index.js';
import type { CheckContext, PageRecord } from '../../src/types.js';
import { BASE, ctx, link, page, siteOk } from '../helpers/factory.js';

/** run a single check and return the affected URL paths */
function run(id: string, c: CheckContext): string[] {
  const check = getCheck(id);
  if (!check) throw new Error('unknown check ' + id);
  return check.run(c).map((f) => f.url.replace(BASE, '') || '/');
}
const only = (id: string, pages: PageRecord[], extra: Parameters<typeof ctx>[1] = {}) => run(id, ctx(pages, extra));

describe('registry', () => {
  it('every check has complete metadata and unique id', () => {
    const ids = new Set<string>();
    for (const c of ALL_CHECKS) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(['error', 'warning', 'notice']).toContain(c.severity);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(15);
      expect(c.howToFix.length).toBeGreaterThan(15);
    }
    expect(ALL_CHECKS.length).toBeGreaterThanOrEqual(80);
  });
  it('a clean page produces no error/warning issues', () => {
    const issues = runChecks(ctx([page('/', { depth: 0, ai: { ...page('/').ai, hasMain: true, hasJsonLd: true } })], { sitemaps: [{ url: BASE + '/sitemap.xml', source: 'default', kind: 'urlset', status: 200, gzip: false, urlCount: 1, lastmodCount: 1, children: [], error: null }] }));
    expect(issues.filter((i) => i.severity !== 'notice')).toEqual([]);
  });
});

describe('response checks', () => {
  it('status 4xx / 5xx / fetch failures', () => {
    const pages = [page('/a', { status: 404, indexable: false }), page('/b', { status: 503 }), page('/c', { status: 0, fetchError: { code: 'TIMEOUT', message: 't' } })];
    expect(only('status-4xx', pages)).toEqual(['/a']);
    expect(only('status-5xx', pages)).toEqual(['/b']);
    expect(only('fetch-failed', pages)).toEqual(['/c']);
  });
  it('redirect, chain, loop, cross-host', () => {
    const pages = [
      page('/r1', { status: 301, redirectTo: BASE + '/r2' }), page('/r2', { status: 302, redirectTo: BASE + '/r3' }), page('/r3'),
      page('/l1', { status: 302, redirectTo: BASE + '/l2' }), page('/l2', { status: 302, redirectTo: BASE + '/l1' }),
      page('/x', { status: 301, redirectTo: 'https://other.test/' }),
    ];
    expect(only('redirect', pages).sort()).toEqual(['/l1', '/l2', '/r1', '/r2', '/x']);
    expect(only('redirect-chain', pages)).toEqual(['/r1']);
    expect(only('redirect-loop', pages).sort()).toEqual(['/l1', '/l2']);
    expect(only('redirect-cross-host', pages)).toEqual(['/x']);
  });
  it('slow / very slow thresholds are exclusive and configurable', () => {
    const pages = [page('/ok', { responseTimeMs: 900 }), page('/slow', { responseTimeMs: 1500 }), page('/vslow', { responseTimeMs: 4000 })];
    expect(only('slow-response', pages)).toEqual(['/slow']);
    expect(only('very-slow-response', pages)).toEqual(['/vslow']);
    expect(only('slow-response', pages, { opts: { url: BASE, thresholds: { slowMs: 500, verySlowMs: 1000 } as never } })).toEqual(['/ok']);
  });
  it('mixed content, large html', () => {
    expect(only('mixed-content', [page('/m', { mixedContent: ['http://a/i.png'] }), page('/n')])).toEqual(['/m']);
    expect(only('large-html', [page('/big', { sizeBytes: 2 * 1024 * 1024 }), page('/s')])).toEqual(['/big']);
  });
  it('broken internal links are reported on the source page', () => {
    const pages = [page('/', { depth: 0 }), page('/gone', { status: 404 }), page('/ok')];
    const links = [link('/', '/gone'), link('/', '/ok')];
    const f = getCheck('broken-internal-link')!.run(ctx(pages, { links }));
    expect(f).toHaveLength(1);
    expect(f[0].url).toBe(BASE + '/');
    expect(f[0].details?.['target']).toBe(BASE + '/gone');
  });
  it('sitemap URLs that are not 200', () => {
    expect(only('sitemap-url-non-200', [page('/a', { inSitemap: true, status: 301 }), page('/b', { inSitemap: true })])).toEqual(['/a']);
  });
});

describe('on-page checks', () => {
  it('titles', () => {
    const pages = [
      page('/none', { title: null }), page('/long', { title: 'x'.repeat(61) }), page('/short', { title: 'Too short' }),
      page('/d1', { title: 'Same Title Here For Duplicates Test' }), page('/d2', { title: 'same title here for duplicates test' }),
    ];
    expect(only('title-missing', pages)).toEqual(['/none']);
    expect(only('title-too-long', pages)).toEqual(['/long']);
    expect(only('title-too-short', pages)).toEqual(['/short']);
    expect(only('title-duplicate', pages)).toEqual(['/d1', '/d2']);
  });
  it('titles ignore non-indexable pages for duplicates', () => {
    const pages = [page('/a', { title: 'Same Title Here For Duplicates Test' }), page('/b', { title: 'Same Title Here For Duplicates Test', indexable: false })];
    expect(only('title-duplicate', pages)).toEqual([]);
  });
  it('meta descriptions', () => {
    const pages = [page('/n', { metaDescription: null }), page('/l', { metaDescription: 'x'.repeat(170) }), page('/s', { metaDescription: 'short' })];
    expect(only('meta-description-missing', pages)).toEqual(['/n']);
    expect(only('meta-description-too-long', pages)).toEqual(['/l']);
    expect(only('meta-description-too-short', pages)).toEqual(['/s']);
  });
  it('headings', () => {
    const pages = [
      page('/none', { headings: [] }), page('/empty', { headings: [{ level: 1, text: '' }] }), page('/multi', { headings: [{ level: 1, text: 'a' }, { level: 1, text: 'b' }] }),
      page('/skip', { headings: [{ level: 1, text: 'a' }, { level: 3, text: 'c' }] }),
    ];
    expect(only('h1-missing', pages)).toEqual(['/none']);
    expect(only('h1-empty', pages)).toEqual(['/empty']);
    expect(only('h1-multiple', pages)).toEqual(['/multi']);
    expect(only('heading-order-skip', pages)).toEqual(['/skip']);
  });
  it('images, viewport, lang, thin content', () => {
    const imgs = [{ src: 'a', alt: null, width: null, height: null }, { src: 'b', alt: '', width: '1', height: '1' }];
    const pages = [page('/i', { images: imgs, viewport: null, lang: null, wordCount: 50 })];
    expect(only('image-alt-missing', pages)).toEqual(['/i']);
    expect(only('image-alt-empty', pages)).toEqual(['/i']);
    expect(only('image-dimensions-missing', pages)).toEqual(['/i']);
    expect(only('viewport-missing', pages)).toEqual(['/i']);
    expect(only('html-lang-missing', pages)).toEqual(['/i']);
    expect(only('thin-content', pages)).toEqual(['/i']);
  });
  it('exact and near duplicates', () => {
    const pages = [
      page('/a', { contentHash: 'h1', simhash: '0000000000000000' }), page('/b', { contentHash: 'h1', simhash: '0000000000000000' }),
      page('/c', { contentHash: 'h2', simhash: '0000000000000001' }), page('/d', { contentHash: 'h3', simhash: 'ffffffffffffffff' }),
    ];
    expect(only('duplicate-content', pages)).toEqual(['/a', '/b']);
    expect(only('near-duplicate-content', pages).sort()).toEqual(['/a', '/b', '/c']);
  });
  it('open graph and twitter', () => {
    const pages = [page('/a', { og: { 'og:title': 'x' }, twitter: {} }), page('/b', { og: { 'og:title': 'x', 'og:description': 'x', 'og:image': 'x', 'og:type': 'website' }, twitter: { 'twitter:card': 'summary' } })];
    expect(only('og-missing', pages)).toEqual(['/a']);
    expect(only('twitter-card-missing', pages)).toEqual(['/a']);
  });
});

describe('indexability checks', () => {
  it('noindex via meta or header, nofollow', () => {
    const pages = [page('/a', { noindex: true, indexable: false }), page('/b', { nofollow: true })];
    expect(only('noindex-page', pages)).toEqual(['/a']);
    expect(only('nofollow-page', pages)).toEqual(['/b']);
    expect(only('noindex-in-sitemap', [page('/a', { noindex: true, inSitemap: true, indexable: false })])).toEqual(['/a']);
  });
  it('canonical variants', () => {
    const other = BASE + '/other';
    const pages = [
      page('/none', { canonicals: [] }), page('/multi', { canonicals: [BASE + '/x', BASE + '/y'] }), page('/to-other', { canonicals: [other] }),
      page('/rel', { canonicalRelative: true }), page('/to-404', { canonicals: [BASE + '/dead'] }), page('/dead', { status: 404, indexable: false, canonicals: [] }),
      page('/other', { canonicals: [other] }),
    ];
    expect(only('canonical-missing', pages)).toEqual(['/none']);
    expect(only('canonical-multiple', pages)).toEqual(['/multi']);
    expect(only('canonical-to-other', pages)).toEqual(['/to-other', '/to-404']);
    expect(only('canonical-relative', pages)).toEqual(['/rel']);
    expect(only('canonical-non-200', pages)).toEqual(['/to-404']);
  });
  it('blocked by robots', () => {
    expect(only('blocked-by-robots', [page('/p', { blockedByRobots: true, status: 0 })])).toEqual(['/p']);
  });
  it('hreflang validation', () => {
    const h = (lang: string, path: string) => ({ lang, href: BASE + path, source: 'html' as const });
    const pages = [
      page('/en', { hreflang: [h('en', '/en'), h('fr', '/fr'), h('xx_bad', '/de'), h('it', '/it'), h('es', '/gone')] }),
      page('/fr', { hreflang: [h('fr', '/fr'), h('en', '/en')] }),
      page('/de', { hreflang: [h('en', '/en')] }),
      page('/it', { hreflang: [] }), page('/gone', { status: 404, indexable: false }),
    ];
    expect(only('hreflang-invalid-code', pages)).toEqual(['/en']);
    expect(only('hreflang-missing-self', pages)).toEqual(['/de']);
    expect(only('hreflang-missing-return', pages)).toEqual(['/en']);
    expect(only('hreflang-non-200', pages)).toEqual(['/en']);
    expect(only('hreflang-no-x-default', pages)).toEqual(['/en', '/fr', '/de']);
    expect(only('hreflang-noindex', [page('/a', { hreflang: [h('fr', '/n')] }), page('/n', { noindex: true, indexable: false })])).toEqual(['/a']);
  });
});

describe('link, url and site checks', () => {
  it('anchor text checks aggregate per page', () => {
    const pages = [page('/', { depth: 0 }), page('/a')];
    const links = [link('/', '/a', { anchor: '' }), link('/', '/a', { anchor: 'Click here' }), link('/', '/a', { anchor: 'read more...' }), link('/', '/a', { anchor: 'Good', nofollow: true, rel: ['nofollow'] })];
    expect(only('link-text-empty', pages, { links })).toEqual(['/']);
    expect(only('link-text-generic', pages, { links })).toEqual(['/']);
    expect(only('nofollow-internal-link', pages, { links })).toEqual(['/']);
  });
  it('orphans, few inlinks, depth', () => {
    const pages = [page('/o', { inSitemap: true, depth: null }), page('/f', { uniqueInlinkSources: 1, depth: 2 }), page('/deep', { depth: 7 })];
    expect(only('orphan-page', pages)).toEqual(['/o']);
    expect(only('few-inlinks', pages)).toEqual(['/f']);
    expect(only('deep-page', pages)).toEqual(['/deep']);
    expect(only('few-inlinks', pages, { complete: false })).toEqual([]);
  });
  it('url hygiene', () => {
    const pages = [page('/Upper'), page('/with_underscore'), page('/p?x=1'), page('/' + 'a'.repeat(120)), page('/a%20b'), page('/ok')];
    expect(only('url-uppercase', pages)).toEqual(['/Upper']);
    expect(only('url-underscore', pages)).toEqual(['/with_underscore']);
    expect(only('url-parameters', pages)).toEqual(['/p?x=1']);
    expect(only('url-too-long', pages)).toHaveLength(1);
    expect(only('url-spaces', pages)).toEqual(['/a%20b']);
  });
  it('robots.txt checks', () => {
    const base = ctx([page('/')]);
    expect(getCheck('robots-missing')!.run({ ...base, robots: { ...base.robots, present: false, status: 404, mode: 'allow-all' } })).toHaveLength(1);
    expect(getCheck('robots-unreachable')!.run({ ...base, robots: { ...base.robots, present: false, status: 503, mode: 'disallow-all' } })).toHaveLength(1);
    expect(getCheck('robots-syntax')!.run({ ...base, robots: { ...base.robots, parsed: { groups: [], sitemaps: [], warnings: [{ line: 3, message: 'x' }] } } })).toHaveLength(1);
  });
  it('sitemap checks', () => {
    const f = { url: BASE + '/s.xml', source: 'robots' as const, kind: 'urlset' as const, status: 200, gzip: false, urlCount: 1, lastmodCount: 0, children: [], error: null };
    expect(only('sitemap-missing', [page('/')])).toEqual(['/']);
    expect(only('sitemap-missing', [page('/')], { sitemaps: [f] })).toEqual([]);
    expect(run('sitemap-invalid', ctx([page('/')], { sitemaps: [{ ...f, status: 404, error: 'HTTP 404', kind: 'unknown' }] }))).toEqual(['/s.xml']);
    const su = [{ loc: BASE + '/in', lastmod: null, sitemap: f.url }];
    expect(only('indexable-not-in-sitemap', [page('/in', { inSitemap: true }), page('/out')], { sitemapUrls: su })).toEqual(['/out']);
  });
  it('security and probes', () => {
    expect(run('not-https', ctx([page('/')], { site: { ...siteOk, isHttps: false } }))).toEqual(['/']);
    expect(run('hsts-missing', ctx([page('/')], { site: { ...siteOk, hsts: null } }))).toEqual(['/']);
    expect(run('http-not-redirected', ctx([page('/')], { site: { ...siteOk, httpRedirect: { ...siteOk.httpRedirect!, redirectsToHttps: false, status: 200 } } }))).toHaveLength(1);
    expect(run('favicon-missing', ctx([page('/')], { site: { ...siteOk, favicon: { url: BASE + '/favicon.ico', status: 404, declaredInHtml: false } } }))).toEqual(['/']);
    expect(run('soft-404', ctx([page('/')], { site: { ...siteOk, soft404: { url: BASE + '/zzz', status: 200 } } }))).toEqual(['/zzz']);
    expect(run('soft-404', ctx([page('/')]))).toEqual([]);
  });
});

describe('structured data and ai checks', () => {
  const sd = (data: Record<string, unknown>, extra: object = {}) => ({ format: 'json-ld' as const, types: [String(data['@type'] ?? '')].filter(Boolean), data, hasContext: '@context' in data, ...extra });
  it('structured data checks map validator output', () => {
    const pages = [
      page('/bad', { structuredData: [{ format: 'json-ld', types: [], data: {}, hasContext: false, parseError: 'oops' }] }),
      page('/ctx', { structuredData: [sd({ '@type': 'Thing' })] }),
      page('/req', { structuredData: [sd({ '@context': 'https://schema.org', '@type': 'Product' })] }),
    ];
    expect(only('sd-invalid-json', pages)).toEqual(['/bad']);
    expect(only('sd-missing-context', pages)).toEqual(['/ctx']);
    expect(only('sd-missing-required', pages)).toEqual(['/req']);
    expect(only('sd-missing-recommended', pages)).toEqual(['/req']);
  });
  it('page-level ai checks', () => {
    const a = page('/article', { ai: { ...page('/').ai, articleLike: true, hasAuthor: false, hasDate: false, hasMain: false, hasArticle: false, hasJsonLd: false } });
    const shell = page('/shell', { wordCount: 3, ai: { ...page('/').ai, jsShell: true, scriptCount: 4 } });
    const snip = page('/snip', { ai: { ...page('/').ai, snippetDirectives: ['nosnippet'], hasMain: true, hasJsonLd: true } });
    const pages = [a, shell, snip];
    expect(only('ai-missing-author', pages)).toEqual(['/article']);
    expect(only('ai-missing-date', pages)).toEqual(['/article']);
    expect(only('ai-js-shell', pages)).toEqual(['/shell']);
    expect(only('ai-snippet-restricted', pages)).toEqual(['/snip']);
    expect(only('ai-no-semantic-main', pages)).toEqual(['/article']);
    expect(only('ai-no-structured-data', pages)).toEqual(['/article']);
  });
});
