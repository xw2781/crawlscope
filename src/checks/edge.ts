import type { CheckDef, Finding, PageRecord } from '../types.js';
import { def, isOkHtml, perPage } from './helpers.js';

/** Key that collapses trailing slash, index documents and host case so equivalent URLs group together. */
export function variantKey(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/').replace(/\/+$/, '') || '/';
  return `${u.host}${path}${u.search}`;
}

export const edgeChecks: CheckDef[] = [
  def(
    { id: 'meta-refresh', severity: 'warning', category: 'response', title: 'Page redirects with a meta refresh',
      description: 'A <meta http-equiv="refresh"> tag sends visitors to another URL. It is slower than an HTTP redirect and search engines may treat it inconsistently.',
      howToFix: 'Replace the meta refresh with a server-side 301/308 redirect.' },
    (ctx) => perPage(ctx, (p) => !!p.metaRefresh && p.status === 200, (p) => ({
      message: p.metaRefresh!.url ? `Meta refresh after ${p.metaRefresh!.delay}s to ${p.metaRefresh!.url}` : `Meta refresh reloads the page every ${p.metaRefresh!.delay}s`,
      details: { delay: p.metaRefresh!.delay, target: p.metaRefresh!.url },
    })),
  ),
  def(
    { id: 'url-duplicate-variant', severity: 'notice', category: 'url', title: 'Same page reachable at trailing-slash / index-file variants',
      description: 'Both /path and /path/ (or /path/index.html) return content, creating duplicate URLs unless they share one canonical or redirect.',
      howToFix: 'Pick one form, 301-redirect the others to it and point rel=canonical at the chosen URL.' },
    (ctx) => {
      const groups = new Map<string, PageRecord[]>();
      for (const p of ctx.pages) {
        if (!isOkHtml(p)) continue;
        const k = variantKey(p.url);
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
      }
      const out: Finding[] = [];
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const targets = new Set(members.map((p) => p.canonicals[0] ?? p.url));
        if (targets.size === 1 && members.every((p) => p.canonicals.length === 1)) continue; // all canonicalised to one URL
        const sorted = [...members].sort((a, b) => b.inlinks - a.inlinks || a.url.length - b.url.length);
        for (const p of sorted.slice(1)) out.push({ url: p.url, message: `Duplicates ${sorted[0].url} (trailing slash / index file variant)`, details: { preferred: sorted[0].url } });
      }
      return out;
    },
  ),
  def(
    { id: 'crawl-trap-suspected', severity: 'warning', category: 'site', title: 'Possible crawl trap (endless URL pattern)',
      description: 'A very large number of URLs share one path pattern (calendars, session ids, filter combinations), so crawlscope stopped following them.',
      howToFix: 'Add nofollow/robots rules or canonicals for the endless section, or raise --max-urls-per-pattern if the pages are genuine.' },
    (ctx) => (ctx.site.trapPatterns ?? []).map((t) => ({ url: t.example, message: `${t.skipped} further URLs matching ${t.pattern} were not crawled`, details: { pattern: t.pattern, skipped: t.skipped } })),
  ),
  def(
    { id: 'body-truncated', severity: 'warning', category: 'response', title: 'Response larger than the analysis limit',
      description: 'The body exceeded the size cap, so on-page results use only the first part of the document.',
      howToFix: 'Reduce the HTML size (pagination, lazy-loading); crawlscope analysed only the first 5 MB.' },
    (ctx) => perPage(ctx, (p) => p.bodyTruncated && p.isHtml, (p) => 'Body cut off at the size cap'),
  ),
];
