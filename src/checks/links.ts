import type { CheckDef, CheckContext, Finding, LinkRecord } from '../types.js';
import { def, isOkHtml, perPage } from './helpers.js';

const GENERIC_ANCHORS = new Set(['click here', 'here', 'read more', 'more', 'learn more', 'this', 'link', 'click', 'details', 'continue', 'this link', 'click here to read more']);

function outAnchors(ctx: CheckContext, url: string): LinkRecord[] {
  return (ctx.outlinksByUrl.get(url) ?? []).filter((l) => l.type === 'a');
}

function aggregate(ctx: CheckContext, pred: (l: LinkRecord) => boolean, msg: (n: number) => string): Finding[] {
  const out: Finding[] = [];
  for (const p of ctx.pages) {
    const bad = outAnchors(ctx, p.url).filter(pred);
    if (bad.length) out.push({ url: p.url, message: msg(bad.length), details: { targets: [...new Set(bad.map((l) => l.to))].slice(0, 10) } });
  }
  return out;
}

export const linkChecks: CheckDef[] = [
  def(
    { id: 'link-text-empty', severity: 'notice', category: 'links', title: 'Links with no anchor text',
      description: 'Links contain no readable text (or an image without alt text), so users and crawlers cannot tell where they go.',
      howToFix: 'Give each link descriptive text, or add alt text to the image inside it.' },
    (ctx) => aggregate(ctx, (l) => l.internal && !l.anchor, (n) => `${n} internal link(s) with empty anchor text`),
  ),
  def(
    { id: 'link-text-generic', severity: 'notice', category: 'links', title: 'Generic link text',
      description: 'Links use vague text such as "click here" or "read more" that says nothing about the destination.',
      howToFix: 'Replace generic phrases with text that describes the target page.' },
    (ctx) => aggregate(ctx, (l) => l.internal && GENERIC_ANCHORS.has(l.anchor.toLowerCase().replace(/[.!»›>…]+$/g, '').trim()), (n) => `${n} internal link(s) use generic anchor text`),
  ),
  def(
    { id: 'nofollow-internal-link', severity: 'notice', category: 'links', title: 'Internal links marked nofollow',
      description: 'Internal links carry rel=nofollow, which stops them passing link signals and may hide pages from crawlers.',
      howToFix: 'Remove nofollow from internal links unless there is a deliberate reason (e.g. login or faceted-filter links).' },
    (ctx) => aggregate(ctx, (l) => l.internal && l.nofollow, (n) => `${n} internal link(s) are nofollow`),
  ),
  def(
    { id: 'few-inlinks', severity: 'notice', category: 'links', title: 'Page has very few internal links pointing to it',
      description: 'Only a single other page links here, which limits discovery and authority flow.',
      howToFix: 'Link to this page from related content, navigation or hub pages.' },
    (ctx) => (ctx.complete ? perPage(ctx, (p) => isOkHtml(p) && p.indexable && p.depth !== 0 && p.uniqueInlinkSources === 1, (p) => 'Linked from only 1 page') : []),
  ),
  def(
    { id: 'orphan-page', severity: 'warning', category: 'site', title: 'Orphan page (in sitemap, no internal links)',
      description: 'The sitemap lists this URL but no crawled page links to it, so visitors and crawlers cannot reach it by navigation.',
      howToFix: 'Add internal links to the page from relevant pages, or remove it from the sitemap if it is obsolete.' },
    (ctx) => (ctx.complete ? perPage(ctx, (p) => p.inSitemap && p.depth === null && p.status > 0, () => 'In the sitemap but no internal page links to it') : []),
  ),
  def(
    { id: 'deep-page', severity: 'notice', category: 'links', title: 'Page is deep in the site',
      description: 'The page needs many clicks from the start page to be reached.',
      howToFix: 'Flatten the structure with hub pages, breadcrumbs and cross-links so important content is within about 3–4 clicks.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p) && p.depth !== null && p.depth > ctx.options.thresholds.deepPage, (p) => `Crawl depth ${p.depth} (limit ${ctx.options.thresholds.deepPage})`),
  ),
  def(
    { id: 'url-uppercase', severity: 'notice', category: 'url', title: 'URL contains uppercase characters',
      description: 'URL paths are case-sensitive; mixed case invites duplicate URLs.',
      howToFix: 'Use lowercase URLs and redirect uppercase variants.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p), (p) => (/[A-Z]/.test(new URL(p.url).pathname) ? 'Path contains uppercase letters' : null)),
  ),
  def(
    { id: 'url-underscore', severity: 'notice', category: 'url', title: 'URL contains underscores',
      description: 'Search engines treat hyphens, not underscores, as word separators.',
      howToFix: 'Use hyphens between words in URLs.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p), (p) => (new URL(p.url).pathname.includes('_') ? 'Path contains underscores' : null)),
  ),
  def(
    { id: 'url-parameters', severity: 'notice', category: 'url', title: 'URL has query parameters',
      description: 'Parameterised URLs often create duplicate variants of the same content.',
      howToFix: 'Prefer clean paths; canonicalise or block parameter variants that do not change content.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p), (p) => (new URL(p.url).search ? 'URL has a query string' : null)),
  ),
  def(
    { id: 'url-too-long', severity: 'notice', category: 'url', title: 'URL is very long',
      description: 'The URL is longer than the configured maximum (default 115 characters).',
      howToFix: 'Shorten the path and remove unnecessary folders or parameters.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p), (p) => (p.url.length > ctx.options.thresholds.urlMaxLength ? `URL is ${p.url.length} characters` : null)),
  ),
  def(
    { id: 'url-spaces', severity: 'notice', category: 'url', title: 'URL contains encoded spaces',
      description: 'Spaces (%20) in a URL are hard to read and share.',
      howToFix: 'Replace spaces with hyphens and redirect the old URL.' },
    (ctx) => perPage(ctx, (p) => p.status > 0, (p) => (/%20|\+/.test(new URL(p.url).pathname) ? 'Path contains an encoded space' : null)),
  ),
];
