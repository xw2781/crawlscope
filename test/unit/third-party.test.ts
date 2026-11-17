import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractHtml } from '../../src/extract.js';
import { buildThirdPartyInventory, knownHost } from '../../src/third-party.js';
import { getCheck } from '../../src/checks/index.js';
import { summarize } from '../../src/summary.js';
import { ctx, page } from '../helpers/factory.js';
import type { PageRecord, PageScript } from '../../src/types.js';

const html = readFileSync(new URL('../fixtures/site/third-party.html', import.meta.url), 'utf8');
const URL_ = 'https://example.test/p';

const sc = (url: string, o: Partial<PageScript> = {}): PageScript => ({ url, host: new URL(url).hostname, thirdParty: true, sri: false, crossorigin: null, ...o });
const withScripts = (path: string, scripts: PageScript[], patch: Partial<PageRecord> = {}) => page(path, { scripts, csp: { enforced: true, reportOnly: false, source: 'header' }, ...patch });
const run = (id: string, pages: PageRecord[]) => getCheck(id)!.run(ctx(pages));

describe('extractHtml scripts', () => {
  const x = extractHtml(html, URL_, null, 'https://www.example.test/');
  it('resolves every script src to an absolute URL', () => {
    expect(x.scripts.map((s) => s.url)).toEqual([
      'https://cdn.optimizely.com/js/123.js', 'https://www.googletagmanager.com/gtm.js?id=GTM-X', 'https://cdn.jsdelivr.net/npm/lib@1/lib.min.js',
      'https://example.test/app.js', 'https://static.example.test/x.js', 'http://insecure.example.org/old.js',
    ]);
  });
  it('flags third-party vs first-party (subdomains are first-party)', () => {
    expect(x.scripts.map((s) => s.thirdParty)).toEqual([true, true, true, false, false, true]);
  });
  it('records SRI and crossorigin', () => {
    const lib = x.scripts[2];
    expect(lib).toMatchObject({ sri: true, crossorigin: 'anonymous' });
    expect(x.scripts[0]).toMatchObject({ sri: false, crossorigin: null });
  });
  it('detects a CSP meta tag', () => {
    expect(x.cspMeta).toBe(true);
    expect(extractHtml('<html><head></head></html>', URL_).cspMeta).toBe(false);
  });
});

describe('inventory', () => {
  it('labels well-known hosts and aggregates per host', () => {
    expect(knownHost('cdn.optimizely.com')).toMatchObject({ category: 'experimentation', dynamic: true });
    expect(knownHost('www.googletagmanager.com')?.category).toBe('tag-manager');
    expect(knownHost('unknown.example')).toBeNull();
    const pages = [
      withScripts('/a', [sc('https://cdn.optimizely.com/js/1.js'), sc('https://cdn.jsdelivr.net/a.js', { sri: true })]),
      withScripts('/b', [sc('https://cdn.optimizely.com/js/1.js')], { csp: { enforced: false, reportOnly: true, source: null } }),
      withScripts('/c', [], { csp: { enforced: false, reportOnly: false, source: null } }),
    ];
    const inv = buildThirdPartyInventory(pages);
    expect(inv).toMatchObject({ pagesScanned: 3, totalScripts: 3, thirdPartyScripts: 3, thirdPartyWithSri: 1, pagesWithThirdParty: 2, csp: { enforced: 1, reportOnly: 1, none: 1 } });
    expect(inv.hosts[0]).toMatchObject({ host: 'cdn.optimizely.com', pages: 2, withSri: 0, sriCoverage: 0, category: 'experimentation' });
    expect(inv.hosts[1]).toMatchObject({ host: 'cdn.jsdelivr.net', category: 'cdn', sriCoverage: 1 });
  });
  it('is part of the crawl summary', () => {
    const s = summarize({ pages: [withScripts('/a', [sc('https://cdn.optimizely.com/x.js')])], issues: [], links: [], sitemapUrls: [], aiReadiness: null } as never);
    expect(s.thirdPartyScripts?.hosts.map((h) => h.host)).toEqual(['cdn.optimizely.com']);
  });
});

describe('checks', () => {
  it('third-party-script-no-sri aggregates per host and explains dynamic snippets', () => {
    const pages = [
      withScripts('/a', [sc('https://cdn.optimizely.com/1.js'), sc('https://cdn.jsdelivr.net/a.js', { sri: true }), sc('https://cdn.jsdelivr.net/b.js'), sc('https://x.test/first.js', { thirdParty: false })]),
      withScripts('/b', [sc('https://cdn.optimizely.com/1.js')]),
    ];
    const f = run('third-party-script-no-sri', pages);
    expect(f).toHaveLength(2);
    expect(f[0].message).toContain('cdn.optimizely.com');
    expect(f[0].message).toContain('2 pages');
    expect(f[0].message).toContain('SRI cannot be used for dynamic snippets');
    expect(f[1].message).not.toContain('cannot be used');
    expect(getCheck('third-party-script-no-sri')!.severity).toBe('notice');
  });
  it('insecure-script is an error only on https pages', () => {
    const bad = withScripts('/a', [sc('http://evil.test/a.js')]);
    const http = withScripts('http://example.test/b', [sc('http://evil.test/a.js')]);
    expect(run('insecure-script', [bad, http]).map((f) => f.url)).toEqual([bad.url]);
    expect(getCheck('insecure-script')!.severity).toBe('error');
  });
  it('csp-missing / csp-report-only report once per site', () => {
    const none = { enforced: false, reportOnly: false, source: null } as const;
    const ro = { enforced: false, reportOnly: true, source: null } as const;
    const pages = [withScripts('/a', [], { csp: none }), withScripts('/b', [], { csp: none }), withScripts('/c', [], { csp: ro }), withScripts('/d', [])];
    const m = run('csp-missing', pages);
    expect(m).toHaveLength(1);
    expect(m[0].details).toMatchObject({ pages: 2 });
    const r = run('csp-report-only', pages);
    expect(r).toHaveLength(1);
    expect(r[0].details).toMatchObject({ pages: 1 });
  });
  it('older crawls without script/csp data produce no findings', () => {
    const p = page('/old');
    for (const id of ['third-party-script-no-sri', 'insecure-script', 'csp-missing', 'csp-report-only']) expect(run(id, [p])).toEqual([]);
  });
});
