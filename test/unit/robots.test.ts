import { describe, expect, it } from 'vitest';
import { parseRobots, robotsMatcher, productToken } from '../../src/robots.js';

const allowed = (txt: string, ua: string, path: string) => robotsMatcher(parseRobots(txt), ua).isAllowed(path);

describe('robots.txt (RFC 9309)', () => {
  it('longest match wins, allow wins ties', () => {
    const t = 'User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c\nAllow: /x\nDisallow: /x';
    expect(allowed(t, 'bot', '/a/zzz')).toBe(false);
    expect(allowed(t, 'bot', '/a/b/zzz')).toBe(true);
    expect(allowed(t, 'bot', '/a/b/c/d')).toBe(false);
    expect(allowed(t, 'bot', '/x')).toBe(true); // tie -> allow
  });
  it('supports * wildcards and $ anchors', () => {
    const t = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*/secret\nDisallow: /*?session=';
    expect(allowed(t, 'bot', '/doc.pdf')).toBe(false);
    expect(allowed(t, 'bot', '/doc.pdf?x=1')).toBe(true);
    expect(allowed(t, 'bot', '/private-area/secret')).toBe(false);
    expect(allowed(t, 'bot', '/page?session=1')).toBe(false);
    expect(allowed(t, 'bot', '/page')).toBe(true);
  });
  it('empty Disallow allows everything; Disallow: / blocks all', () => {
    expect(allowed('User-agent: *\nDisallow:', 'bot', '/anything')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /', 'bot', '/anything')).toBe(false);
  });
  it('selects the specific group over *, and merges duplicate groups', () => {
    const t = 'User-agent: *\nDisallow: /\n\nUser-agent: CrawlScope\nDisallow: /one\n\nUser-agent: crawlscope\nDisallow: /two';
    const m = robotsMatcher(parseRobots(t), 'crawlscope/1.0 (+https://x)');
    expect(m.matchedBy).toBe('explicit');
    expect(m.isAllowed('/')).toBe(true);
    expect(m.isAllowed('/one')).toBe(false);
    expect(m.isAllowed('/two')).toBe(false);
  });
  it('shares rules across stacked user-agent lines', () => {
    const t = 'User-agent: a\nUser-agent: b\nDisallow: /x';
    expect(allowed(t, 'a', '/x')).toBe(false);
    expect(allowed(t, 'b', '/x')).toBe(false);
    expect(allowed(t, 'c', '/x')).toBe(true);
  });
  it('is case-insensitive for directives and UA names but case-sensitive for paths', () => {
    const t = 'USER-AGENT: *\nDISALLOW: /Private';
    expect(allowed(t, 'bot', '/Private')).toBe(false);
    expect(allowed(t, 'bot', '/private')).toBe(true);
  });
  it('normalises percent-encoding', () => {
    const t = 'User-agent: *\nDisallow: /a%2fb\nDisallow: /caf%C3%A9';
    expect(allowed(t, 'bot', '/a%2Fb')).toBe(false);
    expect(allowed(t, 'bot', '/caf%c3%a9')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /~user', 'bot', '/%7Euser')).toBe(false);
  });
  it('always allows /robots.txt itself and handles BOM, CRLF, comments', () => {
    const t = '﻿User-agent: * # everyone\r\nDisallow: / # all\r\n';
    expect(allowed(t, 'bot', '/robots.txt')).toBe(true);
    expect(allowed(t, 'bot', '/x')).toBe(false);
  });
  it('reads crawl-delay and sitemaps and warns on junk', () => {
    const p = parseRobots('Sitemap: https://x.test/s.xml\nUser-agent: *\nCrawl-delay: 5\nDisallow: foo\nBogus: 1\nnonsense line\nAllow: /ok');
    expect(p.sitemaps).toEqual(['https://x.test/s.xml']);
    expect(robotsMatcher(p, 'bot').crawlDelay).toBe(5);
    expect(p.warnings.map((w) => w.line)).toEqual([4, 5, 6]);
  });
  it('flags rules before any user-agent', () => {
    expect(parseRobots('Disallow: /x').warnings).toHaveLength(1);
  });
  it('no robots (null) allows everything', () => {
    expect(robotsMatcher(null, 'bot').isAllowed('/x')).toBe(true);
  });
  it('productToken extracts the product name', () => {
    expect(productToken('crawlscope/0.1.0 (+https://github.com/x)')).toBe('crawlscope');
    expect(productToken('Mozilla/5.0 (compatible; GPTBot/1.0)')).toBe('mozilla');
  });
});
