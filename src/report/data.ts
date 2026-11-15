import type { CrawlResult, PageRecord, Severity } from '../types.js';

/**
 * Compact, columnar payload embedded in report.html and served by the UI.
 * Strings live in `urls`/`str` tables; pages are parallel arrays so that a 50k-page crawl
 * stays small and sorts/filters quickly in the browser.
 */
export interface ReportData {
  v: 1;
  meta: {
    id: string; seed: string; startedAt: string; finishedAt: string; durationMs: number; status: string; truncated: boolean;
    tool: string; generatedAt: string; options: Record<string, unknown>;
  };
  summary: CrawlResult['summary'];
  checks: { id: string; sev: Severity; cat: string; title: string; desc: string; fix: string }[];
  /** page URLs first (index = page index), then other URLs referenced by issues/sitemap */
  urls: string[];
  str: string[];
  pages: {
    n: number;
    status: number[]; depth: number[]; flags: number[]; rt: number[]; size: number[]; inl: number[]; outi: number[]; oute: number[];
    words: number[]; title: number[]; ct: number[]; h1: number[]; sd: number[]; why: number[]; issues: number[]; sev: number[];
  };
  detail: string[];
  issues: { c: number[]; u: number[]; m: string[] };
  /** links among pages: [from, to, anchorStrIdx+1 | 0, flags(1=nofollow,2=internal,4=redirect)] */
  links: number[];
  linksTruncated: boolean;
  linkTotals: { internal: number; external: number };
  sitemap: {
    files: { url: string; kind: string; status: number | null; urlCount: number; error: string | null; gzip: boolean }[];
    total: number; lastmodCount: number;
    notCrawled: number[]; notInSitemap: number[]; nonOk: number[]; orphans: number[]; noindex: number[];
  };
  sd: { types: { type: string; pages: number; items: number }[]; formats: Record<string, number>; invalid: number[]; pagesWith: number; htmlPages: number };
  ai: CrawlResult['aiReadiness'];
  robots: { present: boolean; status: number | null; mode: string; raw: string | null; warnings: { line: number; message: string }[] };
  site: CrawlResult['site'];
  external: { url: string; status: number | null; error: string | null; linkedFrom: number }[];
  diff?: unknown;
}

export const F = { INDEXABLE: 1, HTML: 2, NOINDEX: 4, NOFOLLOW: 8, BLOCKED: 16, SITEMAP: 32, REDIRECT: 64, ERROR: 128, CACHED: 256 };
const MAX_LINKS = 400_000;
const sevRank: Record<Severity, number> = { error: 3, warning: 2, notice: 1 };

class Table {
  list: string[] = [];
  private map = new Map<string, number>();
  add(s: string | null | undefined): number {
    if (s === null || s === undefined || s === '') return -1;
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.map.set(s, i); }
    return i;
  }
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function detailOf(p: PageRecord): string {
  const d: Record<string, unknown> = {};
  const h = p.headers;
  const hs: Record<string, string> = {};
  for (const k of ['content-type', 'server', 'cache-control', 'etag', 'last-modified', 'content-encoding', 'x-robots-tag', 'strict-transport-security', 'location']) if (h[k]) hs[k] = trunc(h[k], 200);
  if (Object.keys(hs).length) d.headers = hs;
  if (p.finalUrl !== p.url) d.finalUrl = p.finalUrl;
  if (p.redirectTo) d.redirectTo = p.redirectTo;
  if (p.fetchError) d.error = `${p.fetchError.code}: ${p.fetchError.message}`;
  if (p.statusText) d.statusText = p.statusText;
  if (p.metaDescription) d.desc = trunc(p.metaDescription, 400);
  if (p.metaRobots) d.metaRobots = p.metaRobots;
  if (p.canonicals.length) d.canonicals = p.canonicals.slice(0, 3);
  if (p.lang) d.lang = p.lang;
  if (p.indexabilityReason) d.indexability = p.indexabilityReason;
  if (p.headings.length) d.headings = p.headings.slice(0, 40).map((x) => [x.level, trunc(x.text, 100)]);
  if (p.hreflang.length) d.hreflang = p.hreflang.slice(0, 20).map((x) => [x.lang, x.href]);
  if (p.images.length) d.images = { total: p.images.length, noAlt: p.images.filter((i) => i.alt === null).length, emptyAlt: p.images.filter((i) => i.alt === '').length };
  if (Object.keys(p.og).length) d.og = Object.fromEntries(Object.entries(p.og).slice(0, 8).map(([k, v]) => [k, trunc(String(v), 120)]));
  if (p.structuredData.length) {
    d.sd = p.structuredData.slice(0, 10).map((s) => ({ format: s.format, types: s.types, error: s.parseError, json: trunc(JSON.stringify(s.data), 1200) }));
  }
  if (p.mixedContent.length) d.mixed = p.mixedContent.slice(0, 5);
  d.stats = [p.wordCount, p.textRatio === null ? null : Math.round(p.textRatio * 100), p.uniqueInlinkSources];
  if (p.paginationNext || p.paginationPrev) d.pagination = [p.paginationPrev, p.paginationNext];
  const ai = p.ai;
  d.ai = [ai.hasMain, ai.hasArticle, ai.hasAuthor, ai.hasDate, ai.hasJsonLd, ai.faqLike, ai.summaryLike, ai.jsShell];
  return JSON.stringify(d);
}

export function buildReportData(r: CrawlResult): ReportData {
  const urls: string[] = r.pages.map((p) => p.url);
  const urlIdx = new Map<string, number>();
  urls.forEach((u, i) => urlIdx.set(u, i));
  const addUrl = (u: string) => {
    let i = urlIdx.get(u);
    if (i === undefined) { i = urls.length; urls.push(u); urlIdx.set(u, i); }
    return i;
  };
  const str = new Table();
  const n = r.pages.length;
  const cols = {
    n, status: [] as number[], depth: [] as number[], flags: [] as number[], rt: [] as number[], size: [] as number[], inl: [] as number[], outi: [] as number[],
    oute: [] as number[], words: [] as number[], title: [] as number[], ct: [] as number[], h1: [] as number[], sd: [] as number[], why: [] as number[],
    issues: new Array<number>(n).fill(0), sev: new Array<number>(n).fill(0),
  };
  const sdTypeCount = new Map<string, { pages: Set<number>; items: number }>();
  const formats: Record<string, number> = {};
  const invalid: number[] = [];
  let pagesWith = 0;
  const detail: string[] = [];
  r.pages.forEach((p, i) => {
    cols.status.push(p.status);
    cols.depth.push(p.depth ?? -1);
    cols.flags.push(
      (p.indexable ? F.INDEXABLE : 0) | (p.isHtml ? F.HTML : 0) | (p.noindex ? F.NOINDEX : 0) | (p.nofollow ? F.NOFOLLOW : 0) | (p.blockedByRobots ? F.BLOCKED : 0) |
      (p.inSitemap ? F.SITEMAP : 0) | (p.redirectTo ? F.REDIRECT : 0) | (p.fetchError ? F.ERROR : 0) | (p.reusedFromCache ? F.CACHED : 0),
    );
    cols.rt.push(p.responseTimeMs ?? -1);
    cols.size.push(p.sizeBytes ?? -1);
    cols.inl.push(p.inlinks);
    cols.outi.push(p.outlinksInternal);
    cols.oute.push(p.outlinksExternal);
    cols.words.push(p.isHtml ? p.wordCount : -1);
    cols.title.push(str.add(p.title));
    cols.ct.push(str.add(p.contentType?.split(';')[0].trim().toLowerCase()));
    cols.h1.push(str.add(p.headings.find((h) => h.level === 1)?.text));
    const types = [...new Set(p.structuredData.flatMap((s) => s.types))];
    cols.sd.push(str.add(types.join(' | ')));
    cols.why.push(str.add(p.indexabilityReason));
    if (p.structuredData.length) {
      pagesWith++;
      let bad = false;
      for (const s of p.structuredData) {
        formats[s.format] = (formats[s.format] ?? 0) + 1;
        if (s.parseError) bad = true;
        for (const t of s.types.length ? s.types : ['(untyped)']) {
          let e = sdTypeCount.get(t);
          if (!e) sdTypeCount.set(t, (e = { pages: new Set(), items: 0 }));
          e.pages.add(i);
          e.items++;
        }
      }
      if (bad) invalid.push(i);
    }
    detail.push(detailOf(p));
  });

  const checkIdx = new Map(r.checks.map((c, i) => [c.id, i]));
  const iss = { c: [] as number[], u: [] as number[], m: [] as string[] };
  for (const i of r.issues) {
    iss.c.push(checkIdx.get(i.checkId) ?? 0);
    const ui = addUrl(i.url);
    iss.u.push(ui);
    iss.m.push(trunc(i.message, 300));
    if (ui < n) {
      cols.issues[ui]++;
      cols.sev[ui] = Math.max(cols.sev[ui], sevRank[i.severity]);
    }
  }

  // links
  const links: number[] = [];
  let linksTruncated = false;
  let count = 0;
  for (const l of r.links) {
    const f = urlIdx.get(l.from);
    const t = urlIdx.get(l.to);
    if (f === undefined || t === undefined || t >= n) continue; // only links between crawled pages
    if (++count > MAX_LINKS) { linksTruncated = true; break; }
    links.push(f, t, l.type === 'a' ? str.add(l.anchor ? trunc(l.anchor, 80) : l.imageOnly ? '[image]' : '') + 1 : 0, (l.nofollow ? 1 : 0) | (l.internal ? 2 : 0) | (l.type === 'redirect' ? 4 : 0));
  }

  // sitemap comparison
  const crawled = new Set(r.pages.filter((p) => !p.blockedByRobots).map((p) => p.url));
  const smSet = new Set(r.sitemapUrls.map((u) => u.loc));
  const notCrawled = [...smSet].filter((u) => !crawled.has(u)).map(addUrl);
  const notInSitemap: number[] = [], nonOk: number[] = [], orphans: number[] = [], noindexIn: number[] = [];
  r.pages.forEach((p, i) => {
    if (p.indexable && !p.inSitemap && smSet.size) notInSitemap.push(i);
    if (p.inSitemap) {
      if (p.status !== 200) nonOk.push(i);
      if (p.noindex) noindexIn.push(i);
      if (p.inlinks === 0) orphans.push(i);
    }
  });

  const ai = r.aiReadiness;
  return {
    v: 1,
    meta: {
      id: r.id, seed: r.seed, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, status: r.status, truncated: r.truncated,
      tool: `${r.tool.name} ${r.tool.version}`, generatedAt: new Date().toISOString(),
      options: { maxPages: r.options.maxPages, maxDepth: r.options.maxDepth, concurrency: r.options.concurrency, delayMs: r.options.delayMs, respectRobots: r.options.respectRobots, userAgent: r.options.userAgent, subdomains: r.options.subdomains, externalCheck: r.options.externalCheck },
    },
    summary: r.summary,
    checks: r.checks.map((c) => ({ id: c.id, sev: c.severity, cat: c.category, title: c.title, desc: c.description, fix: c.howToFix })),
    urls, str: str.list, pages: cols, detail, issues: iss, links, linksTruncated,
    linkTotals: { internal: r.summary.internalLinks, external: r.summary.externalLinks },
    sitemap: {
      files: r.sitemaps.map((s) => ({ url: s.url, kind: s.kind, status: s.status, urlCount: s.urlCount, error: s.error, gzip: s.gzip })),
      total: smSet.size, lastmodCount: r.sitemapUrls.filter((u) => u.lastmod).length, notCrawled, notInSitemap, nonOk, orphans, noindex: noindexIn,
    },
    sd: { types: [...sdTypeCount].map(([type, e]) => ({ type, pages: e.pages.size, items: e.items })).sort((a, b) => b.pages - a.pages), formats, invalid, pagesWith, htmlPages: r.summary.htmlPages },
    ai,
    robots: { present: r.robots.present, status: r.robots.status, mode: r.robots.mode, raw: r.robots.raw ? trunc(r.robots.raw, 8000) : null, warnings: r.robots.parsed?.warnings ?? [] },
    site: r.site,
    external: r.externalLinks.map((e) => ({ url: e.url, status: e.status, error: e.error, linkedFrom: e.linkedFrom.length })),
  };
}

/** JSON that is safe inside <script type="application/json"> (no </script>, <!--, or line-separator surprises). */
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
