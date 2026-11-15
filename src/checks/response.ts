import type { CheckDef, CheckContext, Finding, PageRecord } from '../types.js';
import { def, isOkHtml, perPage } from './helpers.js';
import { isSameSite } from '../util/url.js';

function linkedFrom(ctx: CheckContext, url: string): string[] {
  const s = new Set<string>();
  for (const l of ctx.inlinksByUrl.get(url) ?? []) s.add(l.from);
  return [...s].slice(0, 5);
}

/** Walk a redirect chain through crawled pages. */
export function redirectChain(ctx: CheckContext, start: PageRecord): { hops: string[]; loop: boolean; end: PageRecord | null } {
  const hops: string[] = [start.url];
  const seen = new Set<string>([start.url]);
  let cur: PageRecord | null = start;
  while (cur && cur.redirectTo) {
    const next: string = cur.redirectTo;
    if (seen.has(next)) {
      hops.push(next);
      return { hops, loop: true, end: null };
    }
    seen.add(next);
    hops.push(next);
    cur = ctx.pageByUrl.get(next) ?? null;
  }
  return { hops, loop: false, end: cur };
}

const isRedirect = (p: PageRecord) => p.redirectTo !== null && p.status >= 300 && p.status < 400;

export const responseChecks: CheckDef[] = [
  def(
    { id: 'status-4xx', severity: 'error', category: 'response', title: 'Page returns a client error (4xx)',
      description: 'The URL answered with an HTTP 4xx status, so visitors and search engines cannot read it.',
      howToFix: 'Restore the page, redirect it to the closest replacement with a 301, or remove the links that point to it.' },
    (ctx) => perPage(ctx, (p) => p.status >= 400 && p.status < 500, (p) => ({ message: `Returned HTTP ${p.status} ${p.statusText}`.trim(), details: { status: p.status, linkedFrom: linkedFrom(ctx, p.url) } })),
  ),
  def(
    { id: 'status-5xx', severity: 'error', category: 'response', title: 'Page returns a server error (5xx)',
      description: 'The server failed while handling the request.',
      howToFix: 'Check the server logs for the failing URL, fix the underlying exception or capacity problem, and re-crawl.' },
    (ctx) => perPage(ctx, (p) => p.status >= 500, (p) => ({ message: `Returned HTTP ${p.status} ${p.statusText}`.trim(), details: { status: p.status, linkedFrom: linkedFrom(ctx, p.url) } })),
  ),
  def(
    { id: 'fetch-failed', severity: 'error', category: 'response', title: 'Request failed (timeout, DNS or connection error)',
      description: 'No HTTP response was received for this URL.',
      howToFix: 'Verify the hostname resolves, the server is reachable and responds within the timeout; fix any malformed links.' },
    (ctx) => perPage(ctx, (p) => p.fetchError !== null, (p) => ({ message: `${p.fetchError!.code}: ${p.fetchError!.message}`, details: { code: p.fetchError!.code, linkedFrom: linkedFrom(ctx, p.url) } })),
  ),
  def(
    { id: 'redirect', severity: 'notice', category: 'response', title: 'URL redirects',
      description: 'The URL responds with a 3xx redirect to another location.',
      howToFix: 'Update internal links to point straight at the final URL, and use permanent (301/308) redirects for moved content.' },
    (ctx) => perPage(ctx, isRedirect, (p) => ({ message: `${p.status} redirect to ${p.redirectTo}`, details: { status: p.status, target: p.redirectTo, linkedFrom: linkedFrom(ctx, p.url) } })),
  ),
  def(
    { id: 'redirect-chain', severity: 'warning', category: 'response', title: 'Redirect chain',
      description: 'A URL passes through two or more redirects before reaching its destination, adding latency and diluting signals.',
      howToFix: 'Redirect the first URL directly to the final destination and update links to use the final URL.' },
    (ctx) => {
      const targets = new Set(ctx.pages.filter(isRedirect).map((p) => p.redirectTo));
      const out: Finding[] = [];
      for (const p of ctx.pages) {
        if (!isRedirect(p) || targets.has(p.url)) continue; // start from chain heads only
        const c = redirectChain(ctx, p);
        if (!c.loop && c.hops.length >= 3) out.push({ url: p.url, message: `Redirect chain of ${c.hops.length - 1} hops`, details: { chain: c.hops } });
      }
      return out;
    },
  ),
  def(
    { id: 'redirect-loop', severity: 'error', category: 'response', title: 'Redirect loop',
      description: 'Redirects point back to a URL already visited, so the page can never load.',
      howToFix: 'Break the cycle by making one redirect point at a real, non-redirecting page; check rewrite rules and CDN/app conflicts.' },
    (ctx) => {
      const out: Finding[] = [];
      for (const p of ctx.pages) {
        if (!isRedirect(p)) continue;
        const c = redirectChain(ctx, p);
        if (c.loop) out.push({ url: p.url, message: 'Redirects lead back to a URL already visited (loop)', details: { chain: c.hops } });
      }
      return out;
    },
  ),
  def(
    { id: 'redirect-cross-host', severity: 'notice', category: 'response', title: 'Redirect to a different site',
      description: 'The URL redirects to another host or domain.',
      howToFix: 'Confirm the move is intentional; if not, correct the redirect rule. Remove internal links to URLs that leave the site.' },
    (ctx) => perPage(ctx, (p) => isRedirect(p) && !!p.redirectTo && !isSameSite(p.redirectTo, ctx.seed, ctx.options.subdomains), (p) => `Redirects off-site to ${p.redirectTo}`),
  ),
  def(
    { id: 'mixed-content', severity: 'warning', category: 'security', title: 'HTTPS page loads insecure (http://) resources',
      description: 'Images, scripts, styles or frames are requested over plain HTTP from an HTTPS page; browsers may block them.',
      howToFix: 'Change the resource URLs to https:// (or protocol-relative paths) and make sure the resource host supports HTTPS.' },
    (ctx) => perPage(ctx, (p) => p.mixedContent.length > 0, (p) => ({ message: `${p.mixedContent.length} insecure resource(s), e.g. ${p.mixedContent[0]}`, details: { resources: p.mixedContent.slice(0, 10) } })),
  ),
  def(
    { id: 'slow-response', severity: 'warning', category: 'response', title: 'Slow response',
      description: 'The server took longer than the slow-response threshold to deliver this URL.',
      howToFix: 'Add caching, optimise database queries and server-side rendering, and consider a CDN.' },
    (ctx) => perPage(ctx, (p) => p.responseTimeMs !== null && p.responseTimeMs > ctx.options.thresholds.slowMs && p.responseTimeMs <= ctx.options.thresholds.verySlowMs && p.status > 0,
      (p) => `Response took ${p.responseTimeMs} ms (threshold ${ctx.options.thresholds.slowMs} ms)`),
  ),
  def(
    { id: 'very-slow-response', severity: 'error', category: 'response', title: 'Very slow response',
      description: 'The response time is far above acceptable levels and risks timeouts and crawl-budget loss.',
      howToFix: 'Profile the slow endpoint, cache its output, and reduce blocking work before the first byte.' },
    (ctx) => perPage(ctx, (p) => p.responseTimeMs !== null && p.responseTimeMs > ctx.options.thresholds.verySlowMs && p.status > 0,
      (p) => `Response took ${p.responseTimeMs} ms (threshold ${ctx.options.thresholds.verySlowMs} ms)`),
  ),
  def(
    { id: 'large-html', severity: 'notice', category: 'response', title: 'Very large HTML document',
      description: 'The HTML payload is larger than the configured limit, which slows parsing and may be truncated by crawlers.',
      howToFix: 'Paginate long listings, lazy-load secondary content and strip inline data/scripts from the HTML.' },
    (ctx) => perPage(ctx, (p) => p.isHtml && (p.sizeBytes ?? 0) > ctx.options.thresholds.largeHtmlBytes,
      (p) => `HTML is ${(p.sizeBytes! / 1024 / 1024).toFixed(2)} MB${p.bodyTruncated ? ' (truncated at the size cap)' : ''}`),
  ),
  def(
    { id: 'sitemap-url-non-200', severity: 'warning', category: 'site', title: 'Sitemap lists a URL that does not return 200',
      description: 'Sitemaps should only contain canonical, indexable URLs that respond with 200.',
      howToFix: 'Remove redirected, missing or erroring URLs from the sitemap, or fix the pages.' },
    (ctx) => perPage(ctx, (p) => p.inSitemap && !p.blockedByRobots && (p.status !== 200 || p.fetchError !== null), (p) => `Listed in the sitemap but ${p.fetchError ? p.fetchError.code : 'returned HTTP ' + p.status}`),
  ),
  def(
    { id: 'broken-internal-link', severity: 'error', category: 'links', title: 'Broken internal link',
      description: 'A page links to an internal URL that returns an error or cannot be fetched.',
      howToFix: 'Update the link to a working URL, or restore/redirect the missing target.' },
    (ctx) => {
      const out: Finding[] = [];
      for (const l of ctx.links) {
        if (l.type !== 'a' || !l.internal) continue;
        const t = ctx.pageByUrl.get(l.to);
        if (!t || t.blockedByRobots) continue;
        if (t.status >= 400 || t.fetchError) {
          out.push({ url: l.from, message: `Links to ${l.to} (${t.fetchError ? t.fetchError.code : 'HTTP ' + t.status})`, details: { target: l.to, status: t.status, anchor: l.anchor } });
        }
      }
      return out;
    },
  ),
  def(
    { id: 'broken-external-link', severity: 'warning', category: 'links', title: 'Broken external link',
      description: 'A page links to an external URL that returns an error (checked with HEAD, then GET).',
      howToFix: 'Replace the link with a working source or remove it. Only checked when --external-check is used.' },
    (ctx) => {
      const out: Finding[] = [];
      for (const e of ctx.externalLinks) {
        if (!e.error && (e.status ?? 0) < 400) continue;
        for (const from of e.linkedFrom) out.push({ url: from, message: `Links to ${e.url} (${e.error ?? 'HTTP ' + e.status})`, details: { target: e.url, status: e.status } });
      }
      return out;
    },
  ),
];

export { isOkHtml };
