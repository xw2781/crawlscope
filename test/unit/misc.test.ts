import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { csvField, toCsv } from '../../src/output.js';
import { parseRetryAfter } from '../../src/fetcher.js';
import { decodeSitemapBody, parseSitemapXml } from '../../src/sitemap.js';
import { analyzeAiBots, AI_BOTS } from '../../src/ai-bots.js';
import { parseRobots } from '../../src/robots.js';
import { hamming, simhash } from '../../src/util/hash.js';

describe('csv', () => {
  it('quotes fields and guards formula injection', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('-cmd')).toBe("'-cmd");
    expect(csvField('-5')).toBe('-5');
    expect(csvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });
  it('joins rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
});

describe('retry-after', () => {
  it('parses seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(5000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('sitemaps', () => {
  it('parses urlset and index', () => {
    const s = parseSitemapXml('<urlset><url><loc>https://x.test/a</loc><lastmod>2025-01-01</lastmod></url><url><loc>https://x.test/b</loc></url></urlset>');
    expect(s.kind).toBe('urlset');
    expect(s.urls).toEqual([{ loc: 'https://x.test/a', lastmod: '2025-01-01' }, { loc: 'https://x.test/b', lastmod: null }]);
    const i = parseSitemapXml('<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>');
    expect(i.kind).toBe('index');
    expect(i.children).toEqual(['https://x.test/s1.xml']);
    expect(parseSitemapXml('<html></html>').kind).toBe('unknown');
  });
  it('decodes gzip bodies', () => {
    const d = decodeSitemapBody(gzipSync('<urlset></urlset>'));
    expect(d.gzip).toBe(true);
    expect(d.text).toBe('<urlset></urlset>');
  });
});

describe('ai bots', () => {
  it('reports per-bot allow/block with purpose', () => {
    const bots = analyzeAiBots(parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/'));
    const by = Object.fromEntries(bots.map((b) => [b.bot, b]));
    expect(by['GPTBot'].allowed).toBe(false);
    expect(by['GPTBot'].purpose).toBe('training');
    expect(by['OAI-SearchBot'].allowed).toBe(true);
    expect(by['OAI-SearchBot'].partial).toBe(true);
    expect(by['OAI-SearchBot'].purpose).toBe('search');
    expect(bots).toHaveLength(AI_BOTS.length);
  });
  it('disallow-all mode blocks everything', () => {
    expect(analyzeAiBots(null, 'disallow-all').every((b) => !b.allowed)).toBe(true);
  });
  it('includes the spec bot list', () => {
    const names = AI_BOTS.map((b) => b.bot);
    for (const n of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider', 'Amazonbot', 'Meta-ExternalAgent', 'cohere-ai', 'DuckAssistBot']) expect(names).toContain(n);
  });
});

describe('simhash', () => {
  it('close texts are close, different texts are far', () => {
    const base = Array.from({ length: 300 }, (_, i) => `w${(i * 7919) % 211}x`).join(' ');
    const edited = base.replace('w0x', 'changed');
    const other = Array.from({ length: 300 }, (_, i) => `z${(i * 104729) % 197}y`).join(' ');
    expect(hamming(simhash(base)!, simhash(edited)!)).toBeLessThanOrEqual(6);
    expect(hamming(simhash(base)!, simhash(other)!)).toBeGreaterThan(10);
    expect(simhash('too short')).toBeNull();
  });
});
