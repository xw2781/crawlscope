import * as cheerio from 'cheerio';
import type { HeadingInfo, HreflangEntry, ImageInfo, PageAiSignals, StructuredDataItem } from './types.js';
import { normalizeUrl } from './util/url.js';
import { sha256Short, simhash } from './util/hash.js';
import { extractStructuredData } from './structured-data.js';
import { parseMetaRefresh } from './util/headers.js';

export interface RawLink {
  to: string;
  anchor: string;
  rel: string[];
  imageOnly: boolean;
}

export interface HtmlExtract {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string | null;
  canonicals: string[];
  canonicalRelative: boolean;
  lang: string | null;
  viewport: string | null;
  headings: HeadingInfo[];
  hreflang: HreflangEntry[];
  images: ImageInfo[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  structuredData: StructuredDataItem[];
  paginationNext: string | null;
  paginationPrev: string | null;
  faviconHref: string | null;
  mixedContent: string[];
  wordCount: number;
  textBytes: number;
  textRatio: number | null;
  contentHash: string | null;
  simhash: string | null;
  links: RawLink[];
  metaRefresh: { delay: number; url: string | null } | null;
  resources: { iframes: string[]; srcset: string[] };
  ai: PageAiSignals;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return null;
  }
}

function dateFrom(sd: StructuredDataItem[], key: string): string | null {
  for (const i of sd) {
    const v = i.data[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function hasSdAuthor(sd: StructuredDataItem[]): boolean {
  return sd.some((i) => {
    const a = i.data['author'] ?? i.data['creator'];
    return a !== undefined && a !== null && a !== '' && !(Array.isArray(a) && !a.length);
  });
}

export function extractHtml(html: string, pageUrl: string, xRobotsTag: string | null = null): HtmlExtract {
  const $ = cheerio.load(html);
  const baseHref = abs($('base[href]').first().attr('href'), pageUrl);
  const base = baseHref ?? pageUrl;

  const titles = $('head title');
  const allTitles = titles.length ? titles : $('title');
  const title = allTitles.length ? collapse(allTitles.first().text()) : null;
  const descs = $('meta[name="description" i]');
  const metaDescription = descs.length ? collapse(descs.first().attr('content') ?? '') : null;
  const robotsMetas = $('meta[name="robots" i], meta[name="googlebot" i]');
  const metaRobots = robotsMetas.length
    ? robotsMetas.map((_, e) => ($(e).attr('content') ?? '').toLowerCase()).get().join(', ')
    : null;

  const canonEls = $('link[rel~="canonical" i]');
  const canonicals: string[] = [];
  let canonicalRelative = false;
  canonEls.each((_, e) => {
    const raw = ($(e).attr('href') ?? '').trim();
    if (!raw) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) canonicalRelative = true;
    const n = normalizeUrl(raw, base);
    if (n) canonicals.push(n);
  });

  const headings: HeadingInfo[] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, e) => {
    headings.push({ level: Number((e as { tagName: string }).tagName[1]), text: collapse($(e).text()) });
  });

  const hreflang: HreflangEntry[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_, e) => {
    const href = abs($(e).attr('href'), base);
    if (href) hreflang.push({ lang: ($(e).attr('hreflang') ?? '').trim(), href: normalizeUrl(href) ?? href, source: 'html' });
  });

  const images: ImageInfo[] = [];
  $('img').each((_, e) => {
    const el = $(e);
    const src = el.attr('src') ?? el.attr('data-src') ?? '';
    images.push({
      src: abs(src, base) ?? src,
      alt: el.attr('alt') === undefined ? null : (el.attr('alt') as string),
      width: el.attr('width') ?? null,
      height: el.attr('height') ?? null,
    });
  });

  const og: Record<string, string> = {};
  $('meta[property^="og:" i]').each((_, e) => {
    og[($(e).attr('property') ?? '').toLowerCase()] ??= $(e).attr('content') ?? '';
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:" i]').each((_, e) => {
    twitter[($(e).attr('name') ?? '').toLowerCase()] ??= $(e).attr('content') ?? '';
  });

  const structuredData = extractStructuredData($);

  const next = abs($('link[rel~="next" i]').first().attr('href'), base);
  const prev = abs($('link[rel~="prev" i]').first().attr('href'), base);
  const favicon = abs($('link[rel~="icon" i], link[rel="shortcut icon" i]').first().attr('href'), base);

  // mixed content (only meaningful on https pages)
  const mixed = new Set<string>();
  if (pageUrl.startsWith('https:')) {
    const sel: [string, string][] = [
      ['img[src]', 'src'], ['script[src]', 'src'], ['link[rel~="stylesheet" i][href]', 'href'], ['iframe[src]', 'src'],
      ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'], ['embed[src]', 'src'],
    ];
    for (const [s, a] of sel) {
      $(s).each((_, e) => {
        const u = abs($(e).attr(a), base);
        if (u && u.startsWith('http:')) mixed.add(u);
      });
    }
  }

  // links
  const links: RawLink[] = [];
  $('a[href]').each((_, e) => {
    const el = $(e);
    const href = (el.attr('href') ?? '').trim();
    if (!href || /^(mailto|tel|javascript|sms|data|ftp|file):/i.test(href) || href.startsWith('#')) return;
    const to = normalizeUrl(href, base);
    if (!to) return;
    const text = collapse(el.text());
    const imgAlt = collapse(el.find('img').first().attr('alt') ?? '');
    const imageOnly = !text && el.find('img').length > 0;
    const rel = (el.attr('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    links.push({ to, anchor: text || imgAlt, rel, imageOnly });
  });

  // meta refresh + non-crawled resources (iframes, srcset)
  let metaRefresh: HtmlExtract['metaRefresh'] = null;
  const mr = parseMetaRefresh($('meta[http-equiv="refresh" i]').first().attr('content'));
  if (mr) metaRefresh = { delay: mr.delay, url: mr.url ? normalizeUrl(mr.url, base) ?? mr.url : null };
  const iframes = new Set<string>();
  $('iframe[src], frame[src]').each((_, e) => { const u = abs($(e).attr('src'), base); if (u && /^https?:/.test(u)) iframes.add(u); });
  const srcset = new Set<string>();
  $('img[srcset], source[srcset]').each((_, e) => {
    for (const part of ($(e).attr('srcset') ?? '').split(',')) {
      const u = abs(part.trim().split(/\s+/)[0], base);
      if (u && /^https?:/.test(u)) srcset.add(u);
    }
  });
  const resources = { iframes: [...iframes].slice(0, 50), srcset: [...srcset].slice(0, 100) };

  // ---- visible text ----
  const scriptCount = $('script').length;
  const noscriptText = collapse($('noscript').text()).toLowerCase();
  const bodyHtml = $('body').length ? $('body').first().html() : $.root().html();
  const bodyClone = cheerio.load(bodyHtml ?? '');
  bodyClone('script,style,noscript,template,svg,iframe').remove();
  const fullText = collapse(bodyClone.root().text());
  const mainEl = bodyClone('main, [role="main"], article').first();
  let text: string;
  if (mainEl.length) text = collapse(mainEl.text());
  else {
    bodyClone('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]').remove();
    text = collapse(bodyClone.root().text());
  }
  if (!text) text = fullText;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const wordCount = words.length;
  const textBytes = Buffer.byteLength(text);
  const htmlBytes = Buffer.byteLength(html);
  const textRatio = htmlBytes > 0 ? Math.round((textBytes / htmlBytes) * 1000) / 1000 : null;

  // ---- AI signals (heuristics) ----
  const sdAll = structuredData;
  const hasMain = $('main, [role="main"]').length > 0;
  const hasArticle = $('article').length > 0;
  const metaAuthor = $('meta[name="author" i], link[rel~="author" i], a[rel~="author" i], [itemprop="author"], [class*="byline" i], [class~="author" i], [rel="author"]').length > 0;
  const hasAuthor = metaAuthor || hasSdAuthor(sdAll);
  const datePublished =
    $('meta[property="article:published_time" i], meta[itemprop="datePublished" i], meta[name="date" i], meta[name="publish-date" i]').first().attr('content') ??
    $('[itemprop="datePublished"]').first().attr('datetime') ??
    $('time[datetime]').first().attr('datetime') ??
    dateFrom(sdAll, 'datePublished') ??
    null;
  const dateModified =
    $('meta[property="article:modified_time" i], meta[itemprop="dateModified" i]').first().attr('content') ?? dateFrom(sdAll, 'dateModified') ?? null;
  const questionHeadings = headings.filter((h) => h.level >= 2 && /\?\s*$/.test(h.text)).length;
  const faqLike =
    sdAll.some((i) => i.types.includes('FAQPage') || i.types.includes('QAPage')) || questionHeadings >= 2 || $('details > summary').length >= 2;
  const lead = text.slice(0, 1500);
  const summaryLike =
    headings.some((h) => /\b(tl;?\s?dr|key takeaways?|summary|at a glance|in short|quick answer)\b/i.test(h.text)) ||
    /\b(tl;?\s?dr|key takeaways?|in short|quick answer)\b/i.test(lead);
  const mount = $('#root, #app, #__next, #__nuxt, [data-reactroot]').length > 0;
  const jsShell = wordCount < 30 && scriptCount >= 1 && (mount || /javascript/.test(noscriptText) || scriptCount >= 3);
  const snippetDirectives: string[] = [];
  const directiveSource = [metaRobots ?? '', xRobotsTag ?? ''].join(',').toLowerCase();
  for (const m of directiveSource.matchAll(/nosnippet|max-snippet\s*:\s*-?\d+|noimageai|noai/g)) snippetDirectives.push(m[0].replace(/\s+/g, ''));
  if ($('[data-nosnippet]').length) snippetDirectives.push('data-nosnippet');
  const articleLike =
    sdAll.some((i) => i.types.some((t) => /Article|BlogPosting|NewsArticle/.test(t))) ||
    (hasArticle && wordCount >= 250) ||
    $('meta[property="og:type"]').attr('content') === 'article';

  return {
    title,
    titleCount: $('title').length,
    metaDescription,
    metaDescriptionCount: descs.length,
    metaRobots,
    canonicals,
    canonicalRelative,
    lang: ($('html').attr('lang') ?? '').trim() || null,
    viewport: $('meta[name="viewport" i]').first().attr('content') ?? null,
    headings,
    hreflang,
    images,
    og,
    twitter,
    structuredData,
    paginationNext: next ? normalizeUrl(next) : null,
    paginationPrev: prev ? normalizeUrl(prev) : null,
    faviconHref: favicon,
    mixedContent: [...mixed],
    wordCount,
    textBytes,
    textRatio,
    contentHash: wordCount > 0 ? sha256Short(text.toLowerCase()) : null,
    simhash: wordCount >= 20 ? simhash(text) : null,
    links,
    metaRefresh,
    resources,
    ai: {
      hasMain,
      hasArticle,
      hasAuthor,
      hasDate: !!datePublished,
      datePublished,
      dateModified,
      hasJsonLd: sdAll.some((i) => i.format === 'json-ld' && !i.parseError),
      faqLike,
      summaryLike,
      jsShell,
      scriptCount,
      snippetDirectives: [...new Set(snippetDirectives)],
      articleLike,
    },
  };
}
