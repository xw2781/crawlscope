import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl } from '../../src/crawler.js';
import { resolveOptions } from '../../src/options.js';
import { readCrawl, writeCrawlDir } from '../../src/output.js';
import type { CrawlOptions, CrawlResult } from '../../src/types.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let server: FixtureServer;
let result: CrawlResult;
let dir: string;
const rel = (u: string) => u.replace(server.origin, '').replace(server.external, 'EXT') || '/';

const opts = (over: Partial<CrawlOptions> = {}): CrawlOptions =>
  resolveOptions({ url: server.origin + '/', delayMs: 0, externalCheck: true, aiBotsCheck: true, outDir: dir, thresholds: { slowMs: 300, verySlowMs: 2000 } as never, ...over });

beforeAll(async () => {
  server = await startFixtureServer();
  dir = mkdtempSync(join(tmpdir(), 'crawlscope-int-'));
  result = await crawl(opts());
  writeCrawlDir(dir, result, ['json', 'csv']);
});
afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const issuesOf = (check: string) => result.issues.filter((i) => i.checkId === check).map((i) => rel(i.url)).sort();

describe('fixture crawl: exact errors and warnings', () => {
  it('finds exactly the expected error/warning issues', () => {
    const got = result.issues
      .filter((i) => i.severity !== 'notice')
      .map((i) => `${i.severity} ${i.checkId} ${rel(i.url)}`)
      .sort();
    const expected = [
      'error broken-internal-link /',
      'error broken-internal-link /',
      'error canonical-non-200 /canon-404',
      'error hreflang-invalid-code /hreflang/de',
      'error hreflang-missing-return /hreflang/en',
      'error hreflang-missing-return /hreflang/en',
      'error redirect-loop /loop-a',
      'error redirect-loop /loop-b',
      'error sd-invalid-json /bad-jsonld',
      'error sd-missing-required /bad-jsonld',
      'error sd-missing-required /products/widget',
      'error status-4xx /gone',
      'error status-5xx /server-error',
      'error title-missing /no-meta',
      'warning ai-js-shell /js-shell',
      'warning ai-search-bot-blocked /robots.txt',
      'warning blocked-by-robots /private/secret',
      'warning broken-external-link /',
      'warning duplicate-content /dup-a',
      'warning duplicate-content /dup-b',
      'warning h1-missing /js-shell',
      'warning h1-missing /no-meta',
      'warning hreflang-missing-self /hreflang/de',
      'warning hreflang-noindex /hreflang/en',
      'warning image-alt-missing /no-meta',
      'warning llms-txt-invalid /llms.txt',
      'warning meta-description-missing /no-meta',
      'warning noindex-in-sitemap /noindex',
      'warning not-https /',
      'warning orphan-page /orphan',
      'warning redirect-chain /redirect-start',
      'warning robots-syntax /robots.txt',
      'warning sd-missing-type /bad-jsonld',
      'warning sitemap-url-non-200 /gone',
      'warning sitemap-url-non-200 /redirect-start',
      'warning slow-response /slow',
      'warning title-duplicate /careers',
      'warning title-duplicate /dup-a',
      'warning title-duplicate /dup-b',
      'warning title-duplicate /team',
      'warning viewport-missing /no-meta',
    ].sort();
    expect(got).toEqual(expected);
  });

  it('finds expected notices for the flaws placed on purpose', () => {
    expect(issuesOf('near-duplicate-content')).toEqual(['/near-a', '/near-b']);
    expect(issuesOf('thin-content')).toEqual(['/thin']);
    expect(issuesOf('deep-page')).toEqual(['/deep/5', '/deep/6']);
    expect(issuesOf('large-html')).toEqual(['/big']);
    expect(issuesOf('noindex-page')).toEqual(['/noindex']);
    expect(issuesOf('canonical-to-other')).toEqual(['/canon-404', '/canon-other']);
    expect(issuesOf('canonical-missing')).toEqual(['/Upper_Case?x=1', '/no-meta']);
    expect(issuesOf('redirect-cross-host')).toEqual(['/to-external']);
    expect(issuesOf('heading-order-skip')).toEqual(['/headings']);
    expect(issuesOf('h1-multiple')).toEqual(['/headings']);
    expect(issuesOf('pagination-rel')).toEqual(['/blog/page-1']);
    expect(issuesOf('url-uppercase')).toEqual(['/Upper_Case?x=1']);
    expect(issuesOf('ai-missing-author')).toEqual(['/blog/post-2']);
    expect(issuesOf('ai-missing-date')).toEqual(['/blog/post-2']);
    expect(issuesOf('link-text-generic')).toEqual(['/']);
    expect(issuesOf('nofollow-internal-link')).toEqual(['/']);
    expect(issuesOf('llms-full-missing')).toEqual([]);
    expect(issuesOf('mixed-content')).toEqual([]); // fixture is plain http; covered by unit tests on https URLs
  });
});

describe('fixture crawl: data model', () => {
  it('records page facts', () => {
    const by = (p: string) => result.pages.find((x) => x.url === server.origin + p)!;
    expect(by('/').depth).toBe(0);
    expect(by('/about').depth).toBe(1);
    expect(by('/deep/6').depth).toBe(6);
    expect(by('/orphan').depth).toBeNull();
    expect(by('/orphan').inSitemap).toBe(true);
    expect(by('/redirect-start').redirectTo).toBe(server.origin + '/redirect-mid');
    expect(by('/redirect-end').status).toBe(200);
    expect(by('/private/secret').blockedByRobots).toBe(true);
    expect(by('/private/secret').status).toBe(0);
    expect(by('/files/report.pdf').isHtml).toBe(false);
    expect(by('/files/report.pdf').status).toBe(200);
    expect(by('/noindex').indexable).toBe(false);
    expect(by('/canon-other').indexable).toBe(false);
    expect(by('/big').bodyTruncated).toBe(false);
    expect(by('/big').sizeBytes!).toBeGreaterThan(1024 * 1024);
    expect(by('/about').inlinks).toBeGreaterThan(5);
    expect(by('/').structuredData.map((s) => s.types[0])).toEqual(['Organization', 'WebSite']);
    expect(by('/').etag).toMatch(/^"/);
  });
  it('is schemaVersion 1 and self-describing', () => {
    expect(result.schemaVersion).toBe(1);
    expect(result.status).toBe('complete');
    expect(result.checks.length).toBeGreaterThan(70);
    expect(result.summary.bySeverity.error).toBe(result.issues.filter((i) => i.severity === 'error').length);
    expect(result.summary.statusCodes['blocked']).toBe(1);
    expect(result.summary.healthScore).toBeGreaterThanOrEqual(0);
    expect(result.options).not.toHaveProperty('outDir');
    const reread = readCrawl(dir);
    expect(reread.pages.length).toBe(result.pages.length);
  });
  it('discovers sitemaps (index + gzip) and compares them with the crawl', () => {
    expect(result.sitemaps.map((s) => [rel(s.url), s.kind, s.gzip])).toEqual([
      ['/sitemap-index.xml', 'index', false], ['/sitemap-pages.xml', 'urlset', false], ['/sitemap-extra.xml.gz', 'urlset', true],
    ]);
    expect(result.sitemapUrls.map((u) => rel(u.loc)).sort()).toEqual(['/', '/about', '/blog/post-1', '/gone', '/noindex', '/orphan', '/private/secret', '/products/widget', '/redirect-start'].sort());
  });
  it('external links are checked but never crawled', () => {
    expect(result.externalLinks.map((e) => [rel(e.url), e.status])).toEqual([['EXT/ext-missing', 404], ['EXT/ext-ok', 200]]);
    expect(result.pages.some((p) => p.url.startsWith(server.external))).toBe(false);
    const hitsExternalGet = server.requests.filter((r) => r.path === '/ext-ok' && r.method === 'GET');
    expect(hitsExternalGet.length).toBe(0); // HEAD sufficed
  });
});

describe('fixture crawl: AI readiness', () => {
  it('reports llms.txt problems and per-bot status', () => {
    const ai = result.aiReadiness!;
    expect(ai.llmsTxt.present).toBe(true);
    expect(ai.llmsTxt.valid).toBe(false);
    expect(ai.llmsTxt.brokenLinks.map(rel)).toEqual(['/missing-doc']);
    expect(ai.llmsTxt.sections.map((s) => s.name)).toEqual(['Docs', 'Optional']);
    expect(ai.llmsFullTxt.present).toBe(true);
    const bot = (n: string) => ai.bots.find((b) => b.bot === n)!;
    expect(bot('GPTBot')).toMatchObject({ allowed: false, purpose: 'training', matchedBy: 'explicit' });
    expect(bot('ClaudeBot').allowed).toBe(false);
    expect(bot('PerplexityBot')).toMatchObject({ allowed: false, purpose: 'search' });
    expect(bot('OAI-SearchBot')).toMatchObject({ allowed: true, partial: true, matchedBy: 'wildcard' });
    expect(bot('CCBot')).toMatchObject({ allowed: true, partial: true, matchedBy: 'explicit' });
    expect(ai.score).toBeGreaterThan(0);
    expect(ai.score).toBeLessThanOrEqual(100);
    expect(ai.components.reduce((a, c) => a + c.max, 0)).toBe(100);
    expect(ai.stats.orgSameAs).toBe(true);
    expect(ai.disclaimer).toMatch(/heuristic/i);
  });
});

describe('fixture crawl: politeness', () => {
  it('never requests robots-disallowed paths', () => {
    expect(server.requests.filter((r) => r.path.startsWith('/private/'))).toEqual([]);
  });
  it('fetched robots.txt once and sent the crawlscope user agent', () => {
    expect(server.requests.filter((r) => r.path === '/robots.txt').length).toBeGreaterThanOrEqual(1);
    const ua = server.requests[0].headers['user-agent'];
    expect(ua).toMatch(/^crawlscope\/\S+ \(\+https:\/\/github\.com\/xw2781\/crawlscope\)$/);
  });
});

describe('outputs', () => {
  it('writes crawl.json, CSVs and state.jsonl', () => {
    for (const f of ['crawl.json', 'pages.csv', 'issues.csv', 'links.csv', 'state.jsonl']) expect(existsSync(join(dir, f))).toBe(true);
    const pages = readFileSync(join(dir, 'pages.csv'), 'utf8').split('\r\n');
    expect(pages[0].startsWith('url,status,')).toBe(true);
    expect(pages.length).toBe(result.pages.length + 2); // header + trailing newline
    const issues = readFileSync(join(dir, 'issues.csv'), 'utf8').split('\r\n');
    expect(issues[0]).toBe('severity,check_id,category,title,url,message,how_to_fix');
    expect(issues.length).toBe(result.issues.length + 2);
    const state = readFileSync(join(dir, 'state.jsonl'), 'utf8').trim().split('\n');
    expect(state.length).toBe(result.pages.length);
  });
});
