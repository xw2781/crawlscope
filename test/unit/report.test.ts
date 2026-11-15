import { describe, expect, it } from 'vitest';
import { renderReportHtml, renderDiffHtml } from '../../src/report/html.js';
import { buildReportData, safeJson } from '../../src/report/data.js';
import { diffCrawls } from '../../src/diff.js';
import { summarize } from '../../src/summary.js';
import { blankPage } from '../../src/crawler.js';
import { checkMeta } from '../../src/checks/index.js';
import type { CrawlResult, PageRecord } from '../../src/types.js';

function page(url: string, over: Partial<PageRecord> = {}): PageRecord {
  return { ...blankPage(url, 'link', 1), status: 200, isHtml: true, contentType: 'text/html', responseTimeMs: 40, sizeBytes: 2000, title: 'T ' + url, indexable: true, ...over };
}
function result(pages: PageRecord[], over: Partial<CrawlResult> = {}): CrawlResult {
  const r: CrawlResult = {
    schemaVersion: 1, tool: { name: 'crawlscope', version: '0.0.0' }, id: 'x', seed: 'https://example.test/', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z',
    durationMs: 5000, status: 'complete', truncated: false, options: { url: 'https://example.test/' } as never, summary: undefined as never, pages, links: [], issues: [], checks: checkMeta(),
    robots: { url: 'https://example.test/robots.txt', status: 404, present: false, fetchError: null, mode: 'allow-all', sizeBytes: null, parsed: null, raw: null },
    sitemaps: [], sitemapUrls: [], aiReadiness: null, externalLinks: [], site: { soft404: null, httpRedirect: null, favicon: null, hsts: null, isHttps: true }, ...over,
  };
  r.summary = summarize(r);
  return r;
}

const EVIL = '</script><script>window.__pwned=1</script><img src=x onerror=alert(1)>';

describe('report html', () => {
  const evil = result([page('https://example.test/', { title: EVIL, metaDescription: EVIL, headings: [{ level: 1, text: EVIL }] }), page('https://example.test/a?q=</script>')], {
    issues: [{ checkId: checkMeta()[0].id, severity: checkMeta()[0].severity, category: checkMeta()[0].category, url: 'https://example.test/', message: EVIL }],
  });
  const html = renderReportHtml(evil);

  it('is a complete html document with embedded data that round-trips', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    const m = /<script id="cs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
    const data = JSON.parse(m[1]);
    expect(data.v).toBe(1);
    expect(data.urls[0]).toBe('https://example.test/');
    expect(data.str).toContain(EVIL);
    expect(data.pages.n).toBe(2);
    expect(data.issues.m[0]).toBe(EVIL);
    expect(data.summary.pagesCrawled).toBe(2);
  });

  it('never lets crawled strings break out of the script element', () => {
    // the only closing script tags are the structural ones (7 script blocks: boot theme, data, common, diff, viewer, boot)
    const closers = html.match(/<\/script>/gi)!.length;
    const openers = html.match(/<script[\s>]/gi)!.length;
    expect(closers).toBe(openers);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('window.__pwned=1</script>');
  });

  it('makes no external requests', () => {
    const stripped = html.replace(/<script id="cs-data"[\s\S]*?<\/script>/, '');
    // no src/href/url()/@import pointing at the network (hrefs built from data at runtime are set via JS, not markup)
    expect(stripped).not.toMatch(/\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(stripped).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(stripped).not.toMatch(/@import/i);
    expect(stripped).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  });

  it('keeps the payload compact for big crawls', () => {
    const pages = Array.from({ length: 5000 }, (_, i) => page(`https://example.test/p/${i}`));
    const big = result(pages);
    const data = JSON.stringify(buildReportData(big));
    expect(data.length / 5000).toBeLessThan(1500); // bytes per page
  });

  it('escapes line separators and angle brackets in the data island', () => {
    const input = '<!-- ' + String.fromCharCode(0x2028) + ' </script>';
    const s = safeJson({ a: input });
    expect(s.includes('<') || s.includes('>') || s.includes(String.fromCharCode(0x2028))).toBe(false);
    expect(JSON.parse(s).a).toBe(input);
  });
});

describe('diff', () => {
  const A = result([page('https://example.test/'), page('https://example.test/gone'), page('https://example.test/about', { title: 'About', responseTimeMs: 100 })], {
    issues: [
      { checkId: 'title-missing', severity: 'error', category: 'on-page', url: 'https://example.test/gone', message: 'no title' },
      { checkId: 'h1-missing', severity: 'warning', category: 'on-page', url: 'https://example.test/', message: 'no h1' },
    ],
  });
  const B = result([page('https://example.test/'), page('https://example.test/new'), page('https://example.test/about', { title: 'About us', responseTimeMs: 900, status: 500 })], {
    issues: [
      { checkId: 'h1-missing', severity: 'warning', category: 'on-page', url: 'https://example.test/', message: 'no h1' },
      { checkId: 'status-5xx', severity: 'error', category: 'response', url: 'https://example.test/about', message: 'boom' },
    ],
  });
  const d = diffCrawls(A, B);
  it('finds added, removed and changed pages', () => {
    expect(d.pages.added).toEqual(['https://example.test/new']);
    expect(d.pages.removed).toEqual(['https://example.test/gone']);
    const about = d.pages.changed.find((c) => c.url.endsWith('/about'))!;
    expect(about.changes.map((c) => c.field).sort()).toEqual(['responseTimeMs', 'status', 'title']);
    expect(about.changes.find((c) => c.field === 'title')).toMatchObject({ before: 'About', after: 'About us' });
    expect(d.pages.unchanged).toBe(1);
  });
  it('classifies issues as new, resolved or persisting', () => {
    expect(d.issues.added.map((i) => i.checkId)).toEqual(['status-5xx']);
    expect(d.issues.resolved.map((i) => i.checkId)).toEqual(['title-missing']);
    expect(d.issues.persisting.map((i) => i.checkId)).toEqual(['h1-missing']);
    expect(d.totals).toMatchObject({ issuesAdded: 1, issuesResolved: 1, issuesPersisting: 1 });
    expect(d.byCheck.find((c) => c.checkId === 'status-5xx')).toMatchObject({ before: 0, after: 1, added: 1 });
  });
  it('computes deltas', () => {
    expect(d.deltas.pages).toBe(0);
    expect(d.deltas.errors).toBe(0);
    expect(d.deltas.healthScore).toBe(B.summary.healthScore - A.summary.healthScore);
  });
  it('matches pages across different origins by path', () => {
    const C = result([page('https://staging.test/'), page('https://staging.test/about', { title: 'About' })], { seed: 'https://staging.test/' });
    const x = diffCrawls(A, C);
    expect(x.pages.added).toEqual([]);
    expect(x.pages.removed).toEqual(['https://example.test/gone']);
  });
  it('renders a standalone diff html with escaped content', () => {
    const E = result([page('https://example.test/'), page('https://example.test/' + EVIL)]);
    const html = renderDiffHtml(diffCrawls(A, E));
    expect(html).not.toContain('<img src=x');
    const m = /<script id="cs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
    expect(JSON.parse(m[1]).schemaVersion).toBe(1);
  });
  it('can embed a diff into the report', () => {
    const html = renderReportHtml(B, { diff: d });
    const m = /<script id="cs-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
    expect(JSON.parse(m[1]).diff.totals.added).toBe(1);
  });
});

describe('web assets', () => {
  it('all client scripts parse', async () => {
    const { webAsset } = await import('../../src/web-assets.js');
    for (const f of ['common.js', 'viewer.js', 'diff-viewer.js', 'ui.js']) expect(() => new Function(webAsset(f)), f).not.toThrow();
  });
});
