import type { CheckDef, Finding, PageRecord } from '../types.js';
import { def, isIndexableHtml, isOkHtml, perPage } from './helpers.js';

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/;

export const isValidHreflang = (code: string): boolean => code.toLowerCase() === 'x-default' || LANG_RE.test(code);

const hasEntryTo = (p: PageRecord, url: string) => p.hreflang.some((h) => h.href === url);

export const indexabilityChecks: CheckDef[] = [
  def(
    { id: 'noindex-page', severity: 'notice', category: 'indexability', title: 'Page is set to noindex',
      description: 'A meta robots tag or X-Robots-Tag header tells search engines not to index this page.',
      howToFix: 'If the page should appear in search, remove the noindex directive; otherwise make sure it is not linked as important or listed in the sitemap.' },
    (ctx) => perPage(ctx, (p) => p.noindex && p.status === 200, (p) => `noindex via ${/noindex/i.test(p.xRobotsTag ?? '') ? 'X-Robots-Tag header' : 'meta robots'}`),
  ),
  def(
    { id: 'nofollow-page', severity: 'notice', category: 'indexability', title: 'Page is set to nofollow',
      description: 'A robots directive asks crawlers not to follow any links on this page.',
      howToFix: 'Remove nofollow from the page-level directive unless you really want to hide its links.' },
    (ctx) => perPage(ctx, (p) => p.nofollow && p.status === 200, () => 'Page-level nofollow directive'),
  ),
  def(
    { id: 'noindex-in-sitemap', severity: 'warning', category: 'indexability', title: 'Noindex page listed in sitemap',
      description: 'The sitemap advertises a URL that carries a noindex directive: a contradictory signal.',
      howToFix: 'Remove the URL from the sitemap or drop the noindex directive.' },
    (ctx) => perPage(ctx, (p) => p.inSitemap && p.noindex && p.status === 200, () => 'Listed in the sitemap but marked noindex'),
  ),
  def(
    { id: 'blocked-by-robots', severity: 'warning', category: 'indexability', title: 'Linked URL blocked by robots.txt',
      description: 'Internal pages link to or the sitemap lists a URL that robots.txt forbids crawling. It was not fetched.',
      howToFix: 'Allow the URL in robots.txt if it should be crawled, or stop linking to / listing it. Note that blocked URLs can still be indexed without content.' },
    (ctx) => perPage(ctx, (p) => p.blockedByRobots, (p) => ({ message: 'Disallowed by robots.txt (not fetched)', details: { inSitemap: p.inSitemap, inlinks: p.inlinks } })),
  ),
  def(
    { id: 'canonical-missing', severity: 'notice', category: 'indexability', title: 'Missing canonical URL',
      description: 'The page does not declare a canonical URL, leaving duplicate-URL resolution to the search engine.',
      howToFix: 'Add <link rel="canonical" href="…"> pointing at the preferred absolute URL (usually itself).' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.canonicals.length === 0 ? 'No canonical link' : null)),
  ),
  def(
    { id: 'canonical-multiple', severity: 'error', category: 'indexability', title: 'Multiple conflicting canonicals',
      description: 'More than one canonical link points to different URLs; search engines will ignore them.',
      howToFix: 'Keep a single rel=canonical on the page (check templates and plugins that both inject one).' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (new Set(p.canonicals).size > 1 ? { message: `${new Set(p.canonicals).size} different canonical URLs`, details: { canonicals: [...new Set(p.canonicals)] } } : null)),
  ),
  def(
    { id: 'canonical-to-other', severity: 'notice', category: 'indexability', title: 'Canonicalised to another URL',
      description: 'The canonical URL differs from the page URL, so this page asks not to be indexed in favour of the other.',
      howToFix: 'Verify this is intended. If the page should rank on its own, make the canonical self-referencing.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (p.canonicals.length === 1 && p.canonicals[0] !== p.url ? { message: `Canonical points to ${p.canonicals[0]}`, details: { canonical: p.canonicals[0] } } : null)),
  ),
  def(
    { id: 'canonical-non-200', severity: 'error', category: 'indexability', title: 'Canonical points to a URL that is not 200',
      description: 'The canonical target redirects, errors or is missing.',
      howToFix: 'Point the canonical at a live 200 URL (the final destination, not a redirect).' },
    (ctx) => perPage(ctx, isOkHtml, (p) => {
      const c = p.canonicals[0];
      if (!c || c === p.url) return null;
      const t = ctx.pageByUrl.get(c);
      if (t && !t.blockedByRobots && (t.status !== 200 || t.fetchError)) return { message: `Canonical ${c} returned ${t.fetchError ? t.fetchError.code : 'HTTP ' + t.status}`, details: { canonical: c, status: t.status } };
      return null;
    }),
  ),
  def(
    { id: 'canonical-relative', severity: 'notice', category: 'indexability', title: 'Canonical uses a relative URL',
      description: 'The canonical href is relative. It works, but absolute URLs are less error-prone.',
      howToFix: 'Use a fully qualified canonical URL including scheme and host.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (p.canonicalRelative ? 'Canonical href is relative' : null)),
  ),
  def(
    { id: 'hreflang-invalid-code', severity: 'error', category: 'international', title: 'Invalid hreflang code',
      description: 'An hreflang value is not a valid language (and optional region/script) code or x-default.',
      howToFix: 'Use ISO 639-1 language codes, optionally followed by an ISO 3166-1 region, e.g. en, en-GB, zh-Hant, or x-default.' },
    (ctx) => perPage(ctx, (p) => p.hreflang.length > 0, (p) => {
      const bad = p.hreflang.filter((h) => !isValidHreflang(h.lang));
      return bad.length ? { message: `Invalid hreflang code(s): ${bad.map((b) => b.lang || '(empty)').join(', ')}`, details: { codes: bad.map((b) => b.lang) } } : null;
    }),
  ),
  def(
    { id: 'hreflang-missing-self', severity: 'warning', category: 'international', title: 'hreflang set lacks a self-reference',
      description: 'A page declares alternates but does not include itself in the set.',
      howToFix: 'Add an hreflang entry for the page’s own language/region pointing at its own URL.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p) && p.hreflang.length > 0, (p) => (hasEntryTo(p, p.url) || (p.canonicals[0] && hasEntryTo(p, p.canonicals[0])) ? null : 'No hreflang entry points to the page itself')),
  ),
  def(
    { id: 'hreflang-missing-return', severity: 'error', category: 'international', title: 'hreflang lacks return link',
      description: 'Page A lists page B as an alternate, but B does not list A back. Both annotations may be ignored.',
      howToFix: 'Make every alternate reference all others (including itself).' },
    (ctx) => {
      const out: Finding[] = [];
      for (const p of ctx.pages) {
        if (!isOkHtml(p)) continue;
        for (const h of p.hreflang) {
          if (h.href === p.url) continue;
          const t = ctx.pageByUrl.get(h.href);
          if (!t || !isOkHtml(t)) continue;
          if (!hasEntryTo(t, p.url)) out.push({ url: p.url, message: `${h.href} (${h.lang}) does not link back`, details: { target: h.href, lang: h.lang } });
        }
      }
      return out;
    },
  ),
  def(
    { id: 'hreflang-non-200', severity: 'error', category: 'international', title: 'hreflang points to a non-200 URL',
      description: 'An alternate-language URL redirects, errors or cannot be fetched.',
      howToFix: 'Point hreflang at live 200 URLs only.' },
    (ctx) => {
      const out: Finding[] = [];
      for (const p of ctx.pages) for (const h of p.hreflang) {
        const t = ctx.pageByUrl.get(h.href);
        if (t && !t.blockedByRobots && (t.status !== 200 || t.fetchError)) out.push({ url: p.url, message: `hreflang ${h.lang} → ${h.href} returned ${t.fetchError ? t.fetchError.code : 'HTTP ' + t.status}`, details: { target: h.href, status: t.status } });
      }
      return out;
    },
  ),
  def(
    { id: 'hreflang-noindex', severity: 'warning', category: 'international', title: 'hreflang points to a noindex page',
      description: 'An alternate-language URL is set to noindex, contradicting the annotation.',
      howToFix: 'Remove noindex from the alternate or drop it from the hreflang set.' },
    (ctx) => {
      const out: Finding[] = [];
      for (const p of ctx.pages) for (const h of p.hreflang) {
        const t = ctx.pageByUrl.get(h.href);
        if (t && t.status === 200 && t.noindex) out.push({ url: p.url, message: `hreflang ${h.lang} → ${h.href} is noindex`, details: { target: h.href } });
      }
      return out;
    },
  ),
  def(
    { id: 'hreflang-no-x-default', severity: 'notice', category: 'international', title: 'hreflang has no x-default',
      description: 'The set declares no x-default fallback for users whose language is not covered.',
      howToFix: 'Add an hreflang="x-default" entry pointing at your language selector or default version.' },
    (ctx) => perPage(ctx, (p) => isOkHtml(p) && p.hreflang.length > 0, (p) => (p.hreflang.some((h) => h.lang.toLowerCase() === 'x-default') ? null : 'No x-default entry')),
  ),
];
