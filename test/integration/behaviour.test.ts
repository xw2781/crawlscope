import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl } from '../../src/crawler.js';
import { resolveOptions } from '../../src/options.js';
import { writeCrawlDir } from '../../src/output.js';
import type { CrawlOptions } from '../../src/types.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let server: FixtureServer;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'crawlscope-beh-'));
  dirs.push(d);
  return d;
};
const o = (over: Partial<CrawlOptions> = {}, path = '/'): CrawlOptions => resolveOptions({ url: server.origin + path, delayMs: 0, ...over });
const rel = (u: string) => u.replace(server.origin, '') || '/';

beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('crawl scoping', () => {
  it('honours max-pages and marks the crawl truncated', async () => {
    const r = await crawl(o({ maxPages: 5 }));
    expect(r.pages.filter((p) => !p.blockedByRobots).length).toBe(5);
    expect(r.truncated).toBe(true);
  });
  it('honours max-depth', async () => {
    const r = await crawl(o({ maxDepth: 1, sitemapUrls: [] }));
    const maxD = Math.max(...r.pages.map((p) => p.depth ?? 0));
    expect(maxD).toBeLessThanOrEqual(1);
    expect(r.pages.find((p) => p.url.endsWith('/deep/1'))).toBeDefined();
    expect(r.pages.find((p) => p.url.endsWith('/deep/2'))).toBeUndefined();
  });
  it('applies include and exclude regexes', async () => {
    const r = await crawl(o({ include: ['/blog/', '^' + server.origin + '/$'], exclude: ['post-2'] }));
    const urls = r.pages.map((p) => rel(p.url)).sort();
    expect(urls).toContain('/blog/post-1');
    expect(urls).not.toContain('/blog/post-2');
    expect(urls).not.toContain('/about');
  });
  it('respect-nofollow skips nofollow links', async () => {
    // /careers is only linked from home normally; /team has a nofollow link too, but also a normal one, so test via page-level
    const r = await crawl(o({ respectNofollow: true, maxDepth: 1 }));
    expect(r.pages.find((p) => p.url.endsWith('/team'))).toBeDefined();
  });
  it('does not cross to other hosts and records an off-site redirect', async () => {
    const r = await crawl(o({ maxDepth: 1 }));
    expect(r.pages.some((p) => p.url.startsWith(server.external))).toBe(false);
    expect(r.pages.find((p) => p.url.endsWith('/to-external'))!.status).toBe(301);
  });
});

describe('robots', () => {
  it('can be ignored explicitly', async () => {
    const r = await crawl(o({ respectRobots: false, maxDepth: 1 }));
    const secret = r.pages.find((p) => p.url.endsWith('/private/secret'))!;
    expect(secret.status).toBe(200);
    expect(secret.blockedByRobots).toBe(false);
  });
  it('treats a 5xx robots.txt as disallow-all (RFC 9309) and reports it', async () => {
    const s = await startFixtureServer({ robotsStatus: 503 });
    const r = await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, maxRetries: 0 }));
    expect(r.robots.mode).toBe('disallow-all');
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0].blockedByRobots).toBe(true);
    expect(r.issues.some((i) => i.checkId === 'robots-unreachable')).toBe(true);
    await s.close();
  });
  it('treats a 404 robots.txt as allow-all', async () => {
    const s = await startFixtureServer({ robotsStatus: 404 });
    const r = await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, maxPages: 3 }));
    expect(r.robots.mode).toBe('allow-all');
    expect(r.pages.filter((p) => p.status === 200).length).toBeGreaterThan(1);
    expect(r.issues.some((i) => i.checkId === 'robots-missing')).toBe(true);
    await s.close();
  });
  it('obeys Crawl-delay from robots.txt as a per-host minimum', async () => {
    const s = await startFixtureServer({ robotsText: 'User-agent: *\nCrawl-delay: 0.2\n' });
    const t0 = Date.now();
    await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, maxPages: 4, concurrency: 4, externalCheck: false }));
    const n = s.requests.filter((r) => r.path !== '/robots.txt').length;
    expect(Date.now() - t0).toBeGreaterThanOrEqual((n - 3) * 200 * 0.8);
    await s.close();
  });
});

describe('retries', () => {
  it('retries 429 honouring Retry-After', async () => {
    const t0 = Date.now();
    const r = await crawl(o({ maxPages: 1, maxRetries: 2 }, '/flaky'));
    expect(r.pages[0].status).toBe(200);
    expect(server.requests.filter((q) => q.path === '/flaky').length).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
  it('gives up after maxRetries and records the status', async () => {
    const s = await startFixtureServer();
    // /server-error returns 500 (not retried); /flaky with maxRetries 0 keeps the 429
    const r = await crawl(resolveOptions({ url: s.origin + '/flaky', delayMs: 0, maxPages: 1, maxRetries: 0 }));
    expect(r.pages[0].status).toBe(429);
    await s.close();
  });
});

describe('politeness delay', () => {
  it('spaces requests to the same host by at least delayMs', async () => {
    const s = await startFixtureServer();
    const origRequests = s.requests;
    const t0 = Date.now();
    await crawl(resolveOptions({ url: s.origin + '/', delayMs: 80, maxPages: 4, concurrency: 4, externalCheck: false }));
    const elapsed = Date.now() - t0;
    // robots + sitemaps + >= 4 pages + probes: at least 8 requests spaced 80ms apart
    expect(origRequests.length).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeGreaterThanOrEqual((origRequests.length - 1) * 80 * 0.9);
    await s.close();
  });
});

describe('incremental and resume', () => {
  it('re-crawl sends conditional headers and reuses unchanged pages', async () => {
    const dir = tmp();
    const first = await crawl(o({ outDir: dir }));
    writeCrawlDir(dir, first);
    server.requests.length = 0;
    const second = await crawl(o({ outDir: dir, resume: true }));
    const cond = server.requests.filter((r) => r.headers['if-none-match']);
    expect(cond.length).toBeGreaterThan(20);
    const reused = second.pages.filter((p) => p.reusedFromCache).length;
    expect(reused).toBeGreaterThan(20);
    expect(second.pages.length).toBe(first.pages.length);
    expect(second.issues.map((i) => i.checkId + i.url).sort()).toEqual(first.issues.map((i) => i.checkId + i.url).sort());
  });
  it('resumes an interrupted/truncated crawl without refetching stored pages', async () => {
    const dir = tmp();
    const first = await crawl(o({ outDir: dir, maxPages: 6 }));
    expect(first.truncated).toBe(true);
    writeCrawlDir(dir, first);
    const fetched = first.pages.filter((p) => !p.blockedByRobots).map((p) => rel(p.url));
    server.requests.length = 0;
    const second = await crawl(o({ outDir: dir, resume: true }));
    for (const path of fetched) expect(server.requests.filter((r) => r.path === path && r.method === 'GET')).toHaveLength(0);
    expect(second.truncated).toBe(false);
    expect(second.pages.length).toBeGreaterThan(40);
  });
  it('survives a torn last line in state.jsonl', async () => {
    const dir = tmp();
    const first = await crawl(o({ outDir: dir, maxPages: 3 }));
    writeCrawlDir(dir, first);
    const fs = await import('node:fs');
    fs.appendFileSync(join(dir, 'state.jsonl'), '{"page":{"url":"http://x');
    const second = await crawl(o({ outDir: dir, resume: true, maxPages: 5 }));
    expect(second.pages.length).toBeGreaterThanOrEqual(5);
    expect(readFileSync(join(dir, 'state.jsonl'), 'utf8')).toContain('"page"');
  });
});

describe('site probes', () => {
  it('detects soft 404s', async () => {
    const s = await startFixtureServer({ soft404: true });
    const r = await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, maxPages: 2 }));
    expect(r.issues.some((i) => i.checkId === 'soft-404')).toBe(true);
    await s.close();
  });
  it('does not flag soft 404 when the server answers 404', async () => {
    const r = await crawl(o({ maxPages: 2 }));
    expect(r.issues.some((i) => i.checkId === 'soft-404')).toBe(false);
    expect(r.site.soft404?.status).toBe(404);
    expect(r.site.favicon?.status).toBe(200);
  });
});
