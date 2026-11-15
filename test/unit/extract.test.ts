import { describe, expect, it } from 'vitest';
import { extractHtml } from '../../src/extract.js';

const html = (head: string, body: string) => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe('extractHtml', () => {
  it('extracts basics', () => {
    const x = extractHtml(html('<title> Hi  there </title><meta name="description" content="d"><meta name="robots" content="NoIndex, Follow"><link rel="canonical" href="/c">', '<h1>A</h1><h2>B</h2><p>one two three</p>'), 'https://x.test/p');
    expect(x.title).toBe('Hi there');
    expect(x.metaDescription).toBe('d');
    expect(x.metaRobots).toBe('noindex, follow');
    expect(x.canonicals).toEqual(['https://x.test/c']);
    expect(x.canonicalRelative).toBe(true);
    expect(x.headings.map((h) => h.level)).toEqual([1, 2]);
    expect(x.lang).toBe('en');
  });
  it('collects links with anchor text, rel, and skips mailto/fragments', () => {
    const x = extractHtml(html('', '<a href="/a" rel="nofollow ugc">Alpha</a><a href="#top">x</a><a href="mailto:a@b.c">m</a><a href="/img"><img src="i.png" alt="Pic"></a><a href="/e"></a>'), 'https://x.test/');
    expect(x.links.map((l) => [l.to, l.anchor, l.imageOnly])).toEqual([
      ['https://x.test/a', 'Alpha', false], ['https://x.test/img', 'Pic', true], ['https://x.test/e', '', false],
    ]);
    expect(x.links[0].rel).toEqual(['nofollow', 'ugc']);
  });
  it('respects <base href>', () => {
    const x = extractHtml(html('<base href="https://cdn.test/dir/">', '<a href="p">x</a>'), 'https://x.test/');
    expect(x.links[0].to).toBe('https://cdn.test/dir/p');
  });
  it('detects mixed content only on https pages', () => {
    const body = '<img src="http://a.test/i.png"><script src="http://a.test/s.js"></script><link rel="stylesheet" href="https://ok.test/c.css">';
    expect(extractHtml(html('', body), 'https://x.test/').mixedContent).toHaveLength(2);
    expect(extractHtml(html('', body), 'http://x.test/').mixedContent).toHaveLength(0);
  });
  it('captures hreflang, images, og and twitter tags', () => {
    const x = extractHtml(html('<link rel="alternate" hreflang="fr" href="/fr"><meta property="og:title" content="T"><meta name="twitter:card" content="summary">', '<img src="/a.png"><img src="/b.png" alt="" width="1" height="2">'), 'https://x.test/');
    expect(x.hreflang).toEqual([{ lang: 'fr', href: 'https://x.test/fr', source: 'html' }]);
    expect(x.images.map((i) => i.alt)).toEqual([null, '']);
    expect(x.og['og:title']).toBe('T');
    expect(x.twitter['twitter:card']).toBe('summary');
  });
  it('counts words only in main content and hashes text', () => {
    const a = extractHtml(html('', '<nav>menu menu menu</nav><main><p>alpha beta gamma delta</p></main>'), 'https://x.test/');
    const b = extractHtml(html('', '<header>different nav</header><main><p>alpha  beta gamma delta</p></main>'), 'https://x.test/');
    expect(a.wordCount).toBe(4);
    expect(a.contentHash).toBe(b.contentHash);
  });
  it('flags JS shells and snippet directives', () => {
    const shell = extractHtml(html('', '<div id="root"></div><script src="a.js"></script><script src="b.js"></script>'), 'https://x.test/');
    expect(shell.ai.jsShell).toBe(true);
    const x = extractHtml(html('<meta name="robots" content="nosnippet, max-snippet:0">', '<p data-nosnippet>x</p>'), 'https://x.test/', 'noai');
    expect(x.ai.snippetDirectives.sort()).toEqual(['data-nosnippet', 'max-snippet:0', 'noai', 'nosnippet']);
  });
  it('detects author/date/FAQ signals', () => {
    const x = extractHtml(html('<meta name="author" content="Ann">', '<article><time datetime="2025-01-01">x</time><h2>Why?</h2><h2>How?</h2></article>'), 'https://x.test/');
    expect(x.ai.hasAuthor).toBe(true);
    expect(x.ai.hasDate).toBe(true);
    expect(x.ai.faqLike).toBe(true);
    expect(x.ai.hasArticle).toBe(true);
  });
});
