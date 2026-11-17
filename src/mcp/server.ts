import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { crawl } from '../crawler.js';
import { resolveOptions } from '../options.js';
import { writeCrawlDir } from '../output.js';
import { diffCrawls } from '../diff.js';
import { DEFAULT_UA, Fetcher, VERSION } from '../fetcher.js';
import { parseRobots, robotsMatcher } from '../robots.js';
import { hostOf, normalizeUrl, originOf, pathAndQuery } from '../util/url.js';
import type { CrawlResult, Issue, PageRecord, Severity } from '../types.js';
import { CrawlStore, ToolError, defaultDataDir } from './store.js';

/** Hard ceiling for any single tool response (characters of JSON). */
const MAX_CHARS = 24_000;
const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> };

function result(obj: unknown): CallToolResult {
  let text = JSON.stringify(obj);
  if (text.length > MAX_CHARS) {
    text = JSON.stringify({ truncated: true, note: `Output exceeded ${MAX_CHARS} characters and was cut; narrow the query (filters, smaller limit).`, partial: text.slice(0, MAX_CHARS - 300) });
  }
  return { content: [{ type: 'text', text }] };
}
const fail = (msg: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] });

function httpUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  const n = normalizeUrl(withScheme);
  if (!n) throw new ToolError(`"${input}" is not a valid http(s) URL.`);
  return n;
}

const page = (p: PageRecord) => ({
  url: p.url, status: p.status, title: p.title, indexable: p.indexable, indexability: p.indexabilityReason, depth: p.depth,
  words: p.isHtml ? p.wordCount : null, ms: p.responseTimeMs, inlinks: p.inlinks, ...(p.redirectTo ? { redirectTo: p.redirectTo } : {}),
});

function issueRow(i: Issue) {
  return { severity: i.severity, check: i.checkId, url: i.url, message: i.message };
}

function summaryOf(r: CrawlResult, name: string, topN = 10) {
  const titles = new Map(r.checks.map((c) => [c.id, c.title]));
  const s = r.summary;
  return {
    crawl_id: name, seed: r.seed, status: r.status, truncated: r.truncated, startedAt: r.startedAt, durationMs: r.durationMs,
    pages: s.pagesCrawled, htmlPages: s.htmlPages, indexable: s.indexablePages, healthScore: s.healthScore, aiReadinessScore: s.aiReadinessScore,
    issues: { total: s.issuesTotal, ...s.bySeverity }, statusCodes: s.statusCodes, avgResponseTimeMs: s.avgResponseTimeMs, maxDepth: s.maxDepth,
    ...(s.thirdPartyScripts ? { thirdParty: { hosts: s.thirdPartyScripts.hosts.length, scripts: s.thirdPartyScripts.thirdPartyScripts, withSri: s.thirdPartyScripts.thirdPartyWithSri } } : {}),
    topIssueTypes: s.byCheck.slice(0, topN).map((c) => ({ check: c.checkId, severity: c.severity, count: c.count, title: titles.get(c.checkId) })),
    ...(s.byCheck.length > topN ? { moreIssueTypes: s.byCheck.length - topN } : {}),
  };
}

export interface McpOptions {
  dataDir?: string;
}

export function createMcpServer(opts: McpOptions = {}): { server: McpServer; store: CrawlStore } {
  const store = new CrawlStore(opts.dataDir ?? defaultDataDir());
  let running: string | null = null;

  const server = new McpServer(
    { name: 'crawlscope', version: VERSION },
    {
      instructions:
        'crawlscope is a local SEO / GEO-AEO crawler. Typical flow: crawl_site (saves a crawl) -> get_crawl_summary -> list_issues / find_pages -> get_page for detail; run crawl_site again later and diff_crawls to verify fixes. ' +
        'audit_url, check_ai_readiness and check_robots_url need no saved crawl. Outputs are compact JSON and are truncated with counts; use limit/offset and filters to page through. Only crawl sites you own or are permitted to crawl.',
    },
  );

  /** Register a tool whose handler may throw; errors become MCP tool errors instead of crashing the server. */
  function tool<S extends z.ZodRawShape>(
    name: string, title: string, description: string, shape: S, readOnly: boolean,
    handler: (args: z.infer<z.ZodObject<S>>, extra: Extra) => Promise<unknown> | unknown, openWorld = false,
  ) {
    server.registerTool(
      name,
      { title, description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: openWorld } },
      (async (args: z.infer<z.ZodObject<S>>, extra: Extra) => {
        try {
          return result(await handler(args, extra));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      }) as never,
    );
  }

  const crawlRef = z.string().max(300).optional().describe('Crawl to use: crawl_id from crawl_site/list_crawls, a host/URL (latest crawl of it) or "latest". Default: latest crawl.');
  const limit = (def: number, max = 200) => z.number().int().min(1).max(max).default(def).describe(`Max rows to return (default ${def}, max ${max}).`);
  const offset = z.number().int().min(0).max(1_000_000).default(0).describe('Rows to skip (for paging).');

  // ---------------------------------------------------------------- crawl_site
  tool(
    'crawl_site', 'Crawl a website',
    'Crawl a site starting at `url` (same-site pages only, obeys robots.txt, polite delay) and save the result locally. Runs ~190 checks (broken links, redirects, titles, canonicals, indexability, structured data, AI/GEO readiness...). ' +
      'Capped at max_pages (default 200) so it stays agent-sized; raise it deliberately. Returns a compact summary and a crawl_id for the other tools. Sends progress notifications. Only crawl sites you are allowed to crawl.',
    {
      url: z.string().min(3).max(2000).describe('Start URL, e.g. https://example.com (https:// is assumed if omitted).'),
      max_pages: z.number().int().min(1).max(100_000).default(200).describe('Stop after this many pages (default 200).'),
      max_depth: z.number().int().min(0).max(100).optional().describe('Maximum link depth from the start URL.'),
      include: z.array(z.string().max(500)).max(20).optional().describe('Only crawl URLs matching one of these regular expressions.'),
      exclude: z.array(z.string().max(500)).max(20).optional().describe('Skip URLs matching any of these regular expressions.'),
      subdomains: z.boolean().default(false).describe('Also crawl subdomains of the start host.'),
      external_check: z.boolean().default(false).describe('HEAD-check outbound links (they are never crawled).'),
      check_llms_links: z.boolean().default(false).describe('Also verify that URLs listed in llms.txt resolve.'),
      delay_ms: z.number().int().min(50).max(60_000).default(250).describe('Minimum delay between requests to the host (default 250 ms).'),
      concurrency: z.number().int().min(1).max(8).default(4).describe('Parallel requests (default 4).'),
      max_urls_per_pattern: z.number().int().min(0).max(1_000_000).default(1000).describe('Crawl-trap guard: stop following URLs of one path pattern after N (0 = unlimited).'),
      time_limit_s: z.number().int().min(5).max(3600).default(600).describe('Stop gracefully after this many seconds and keep the partial result.'),
    },
    false,
    async (a, extra) => {
      if (running) throw new ToolError(`A crawl of ${running} is already running in this server. Wait for it to finish.`);
      const url = httpUrl(a.url);
      for (const p of [...(a.include ?? []), ...(a.exclude ?? [])]) {
        try { new RegExp(p); } catch { throw new ToolError(`Invalid regular expression: ${p}`); }
      }
      store.ensure();
      const name = store.newName(url);
      const outDir = join(store.dataDir, name);
      const o = resolveOptions({
        url, maxPages: a.max_pages, maxDepth: a.max_depth ?? null, include: a.include ?? [], exclude: a.exclude ?? [], subdomains: a.subdomains,
        externalCheck: a.external_check, aiBotsCheck: a.check_llms_links, delayMs: a.delay_ms, concurrency: a.concurrency, maxUrlsPerPattern: a.max_urls_per_pattern, outDir,
      });
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      extra.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ac.abort(), a.time_limit_s * 1000);
      const token = extra._meta?.progressToken;
      let last = 0;
      const logs: string[] = [];
      running = url;
      try {
        const r = await crawl(o, {
          signal: ac.signal,
          onLog: (m) => { if (logs.length < 10) logs.push(m); },
          onProgress: (p) => {
            const now = Date.now();
            if (token === undefined || now - last < 500) return;
            last = now;
            void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: p.crawled, total: a.max_pages, message: `crawled ${p.crawled}, queued ${p.queued}: ${p.url}` } } as never).catch(() => undefined);
          },
        });
        const files = writeCrawlDir(outDir, r, ['json', 'csv', 'html']);
        const hints: string[] = [];
        if (r.truncated) hints.push(`Stopped at max_pages=${a.max_pages}; more pages exist. Re-run with a higher max_pages for full coverage.`);
        if (r.status === 'partial') hints.push(`Crawl was stopped early (${extra.signal.aborted ? 'cancelled' : `time_limit_s=${a.time_limit_s}`}); results are partial.`);
        if (r.robots.mode === 'disallow-all') hints.push('robots.txt was unreachable or returned 5xx, so crawlers must treat the site as disallowed; nothing was crawled.');
        if (r.site.trapPatterns?.length) hints.push(`Possible crawl trap(s): ${r.site.trapPatterns.map((t) => t.pattern).join(', ')}.`);
        hints.push(`Next: list_issues {crawl_id:"${name}", severity:"error"} or find_pages. Report: ${join(outDir, 'report.html')}`);
        return { ...summaryOf(r, name), dir: outDir, files: files.map((f) => f.slice(outDir.length + 1)), ...(logs.length ? { notes: logs } : {}), hints };
      } finally {
        clearTimeout(timer);
        extra.signal.removeEventListener('abort', onAbort);
        running = null;
      }
    },
    true,
  );

  // ------------------------------------------------------- get_crawl_summary
  tool(
    'get_crawl_summary', 'Summarise a saved crawl',
    'Health score, AI-readiness score, issue counts by severity and the most frequent issue types for a saved crawl. Start here after crawl_site.',
    { crawl_id: crawlRef, top: z.number().int().min(1).max(60).default(15).describe('How many issue types to list (default 15).') },
    true,
    ({ crawl_id, top }) => {
      const { entry, result: r } = store.get(crawl_id);
      const ai = r.aiReadiness;
      return {
        ...summaryOf(r, entry.name, top),
        robots: { mode: r.robots.mode, status: r.robots.status },
        ...(ai ? { ai: { score: ai.score, llmsTxt: ai.llmsTxt.present, llmsFullTxt: ai.llmsFullTxt.present, blockedAiBots: ai.bots.filter((b) => !b.allowed).map((b) => b.bot) } } : {}),
        slowestPages: r.summary.slowestPages,
        ...(r.summary.thirdPartyScripts ? { thirdPartyScripts: { ...r.summary.thirdPartyScripts, hosts: r.summary.thirdPartyScripts.hosts.slice(0, top) } } : {}),
        hints: ['list_issues to drill into a check_id; get_page for one URL; diff_crawls to compare with an earlier crawl.'],
      };
    },
  );

  // -------------------------------------------------------------- list_crawls
  tool(
    'list_crawls', 'List saved crawls',
    'Lists crawls saved in the data directory (newest first) with their crawl_id, seed URL, page count and scores.',
    { host: z.string().max(300).optional().describe('Only crawls whose seed host contains this text.'), limit: limit(20, 100) },
    true,
    ({ host, limit: n }) => {
      let all = store.list();
      if (host) all = all.filter((e) => hostOf(e.seed).includes(host.toLowerCase()));
      return {
        dataDir: store.dataDir, total: all.length,
        crawls: all.slice(0, n).map((e) => ({ crawl_id: e.name, seed: e.seed, startedAt: e.startedAt, status: e.status, truncated: e.truncated, pages: e.pages, healthScore: e.healthScore, aiReadinessScore: e.aiReadinessScore, issues: e.issues })),
        ...(all.length > n ? { hint: `${all.length - n} more; raise limit or filter with host.` } : {}),
      };
    },
  );

  // -------------------------------------------------------------- list_issues
  tool(
    'list_issues', 'List issues found in a crawl',
    'Lists issues (most severe first) with optional filters. Also returns counts per check for the filtered set. Use check_id values from get_crawl_summary.',
    {
      crawl_id: crawlRef,
      severity: z.enum(['error', 'warning', 'notice']).optional().describe('Only this severity.'),
      check_id: z.string().max(100).optional().describe('Only this check, e.g. "title-missing", "broken-internal-link".'),
      category: z.string().max(50).optional().describe('Only this category, e.g. "ai-readiness", "indexability", "links".'),
      url_contains: z.string().max(300).optional().describe('Only issues whose URL contains this text.'),
      limit: limit(25), offset,
    },
    true,
    (a) => {
      const { entry, result: r } = store.get(a.crawl_id);
      if (a.check_id && !r.checks.some((c) => c.id === a.check_id)) throw new ToolError(`Unknown check_id "${a.check_id}". Use get_crawl_summary to see check ids present.`);
      const needle = a.url_contains?.toLowerCase();
      const rows = r.issues.filter((i) => (!a.severity || i.severity === a.severity) && (!a.check_id || i.checkId === a.check_id) && (!a.category || i.category === a.category) && (!needle || i.url.toLowerCase().includes(needle)));
      rows.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
      const titles = new Map(r.checks.map((c) => [c.id, c]));
      const counts = new Map<string, number>();
      for (const i of rows) counts.set(i.checkId, (counts.get(i.checkId) ?? 0) + 1);
      const shown = rows.slice(a.offset, a.offset + a.limit);
      const checks = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([id, n]) => ({ check: id, count: n, title: titles.get(id)?.title, howToFix: a.check_id ? titles.get(id)?.howToFix : undefined }));
      return {
        crawl_id: entry.name, total: rows.length, returned: shown.length, offset: a.offset, checks, issues: shown.map(issueRow),
        ...(a.offset + shown.length < rows.length ? { hint: `${rows.length - a.offset - shown.length} more; use offset=${a.offset + shown.length} or add filters (check_id, severity, url_contains).` } : {}),
      };
    },
  );

  // ----------------------------------------------------------------- get_page
  tool(
    'get_page', 'Get everything known about one URL',
    'Full record for one crawled URL: status, indexability, title/description/headings, canonical, hreflang, structured data, issues on it, and its inbound/outbound links (capped).',
    {
      crawl_id: crawlRef, url: z.string().min(1).max(4000).describe('Absolute URL, or a path like "/about" relative to the crawl seed.'),
      link_limit: z.number().int().min(0).max(100).default(15).describe('Max inbound and outbound links to list (default 15).'),
    },
    true,
    ({ crawl_id, url, link_limit }) => {
      const { entry, result: r } = store.get(crawl_id);
      const target = url.startsWith('/') ? new URL(url, r.seed).href : /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const n = normalizeUrl(target);
      const cands = n ? [n, n.endsWith('/') ? n.slice(0, -1) : n + '/'] : [];
      const p = r.pages.find((x) => cands.includes(x.url)) ?? r.pages.find((x) => x.finalUrl === n);
      if (!p) throw new ToolError(`URL not found in crawl ${entry.name}${r.truncated ? ' (the crawl was truncated, so the page may simply not have been reached)' : ''}. Try find_pages with url_contains.`);
      const issues = r.issues.filter((i) => i.url === p.url);
      const out = r.links.filter((l) => l.from === p.url && l.type === 'a');
      const inn = r.links.filter((l) => l.to === p.url && l.type === 'a');
      const titles = new Map(r.checks.map((c) => [c.id, c.howToFix]));
      return {
        crawl_id: entry.name, url: p.url, status: p.status, statusText: p.statusText, redirectTo: p.redirectTo, fetchError: p.fetchError, blockedByRobots: p.blockedByRobots,
        contentType: p.contentType, responseTimeMs: p.responseTimeMs, sizeBytes: p.sizeBytes, depth: p.depth, discoveredVia: p.discoveredVia,
        indexable: p.indexable, indexability: p.indexabilityReason, metaRobots: p.metaRobots, xRobotsTag: p.xRobotsTag, canonicals: p.canonicals, inSitemap: p.inSitemap,
        title: p.title, metaDescription: p.metaDescription, lang: p.lang, wordCount: p.wordCount,
        headings: p.headings.slice(0, 30).map((h) => `h${h.level}: ${h.text.slice(0, 100)}`),
        hreflang: p.hreflang.slice(0, 20),
        images: { total: p.images.length, missingAlt: p.images.filter((i) => i.alt === null).map((i) => i.src).slice(0, 10) },
        structuredData: p.structuredData.map((s) => ({ format: s.format, types: s.types, ...(s.parseError ? { parseError: s.parseError } : {}) })),
        ai: p.ai, ...(p.metaRefresh ? { metaRefresh: p.metaRefresh } : {}),
        issues: issues.slice(0, 40).map((i) => ({ severity: i.severity, check: i.checkId, message: i.message, fix: titles.get(i.checkId) })),
        inlinks: { total: inn.length, sample: inn.slice(0, link_limit).map((l) => ({ from: l.from, anchor: l.anchor.slice(0, 60) })) },
        outlinks: { total: out.length, internal: p.outlinksInternal, external: p.outlinksExternal, sample: out.slice(0, link_limit).map((l) => ({ to: l.to, anchor: l.anchor.slice(0, 60), internal: l.internal, nofollow: l.nofollow })) },
      };
    },
  );

  // --------------------------------------------------------------- find_pages
  tool(
    'find_pages', 'Find pages matching filters',
    'Filter crawled pages (status, indexability, missing title/description/H1/canonical, depth, speed, word count, URL/title text) and sort them. Returns compact rows.',
    {
      crawl_id: crawlRef,
      status: z.number().int().min(0).max(599).optional().describe('Exact HTTP status (0 = failed / blocked).'),
      status_class: z.enum(['2xx', '3xx', '4xx', '5xx', 'failed']).optional(),
      indexable: z.boolean().optional(),
      url_contains: z.string().max(300).optional(),
      title_contains: z.string().max(300).optional(),
      missing: z.enum(['title', 'meta_description', 'h1', 'canonical', 'structured_data']).optional().describe('HTML pages lacking this element.'),
      in_sitemap: z.boolean().optional(),
      min_depth: z.number().int().min(0).optional(), max_depth: z.number().int().min(0).optional(),
      min_response_ms: z.number().int().min(0).optional(), max_word_count: z.number().int().min(0).optional(),
      sort_by: z.enum(['url', 'status', 'depth', 'response_time', 'word_count', 'inlinks']).default('url'),
      order: z.enum(['asc', 'desc']).default('asc'),
      limit: limit(25), offset,
    },
    true,
    (a) => {
      const { entry, result: r } = store.get(a.crawl_id);
      const u = a.url_contains?.toLowerCase(), t = a.title_contains?.toLowerCase();
      const html = (p: PageRecord) => p.isHtml && p.status === 200;
      let rows = r.pages.filter((p) => {
        if (a.status !== undefined && p.status !== a.status) return false;
        if (a.status_class) {
          const c = a.status_class === 'failed' ? p.status === 0 : Math.floor(p.status / 100) === Number(a.status_class[0]);
          if (!c) return false;
        }
        if (a.indexable !== undefined && p.indexable !== a.indexable) return false;
        if (u && !p.url.toLowerCase().includes(u)) return false;
        if (t && !(p.title ?? '').toLowerCase().includes(t)) return false;
        if (a.missing) {
          if (!html(p)) return false;
          const miss = { title: !p.title, meta_description: !p.metaDescription, h1: !p.headings.some((h) => h.level === 1), canonical: !p.canonicals.length, structured_data: !p.structuredData.length }[a.missing];
          if (!miss) return false;
        }
        if (a.in_sitemap !== undefined && p.inSitemap !== a.in_sitemap) return false;
        if (a.min_depth !== undefined && (p.depth ?? -1) < a.min_depth) return false;
        if (a.max_depth !== undefined && (p.depth === null || p.depth > a.max_depth)) return false;
        if (a.min_response_ms !== undefined && (p.responseTimeMs ?? -1) < a.min_response_ms) return false;
        if (a.max_word_count !== undefined && (!html(p) || p.wordCount > a.max_word_count)) return false;
        return true;
      });
      const key: Record<string, (p: PageRecord) => string | number> = {
        url: (p) => p.url, status: (p) => p.status, depth: (p) => p.depth ?? 1e9, response_time: (p) => p.responseTimeMs ?? -1, word_count: (p) => p.wordCount, inlinks: (p) => p.inlinks,
      };
      const f = key[a.sort_by], dir = a.order === 'desc' ? -1 : 1;
      rows = rows.sort((x, y) => (f(x) < f(y) ? -dir : f(x) > f(y) ? dir : 0));
      const shown = rows.slice(a.offset, a.offset + a.limit);
      return {
        crawl_id: entry.name, total: rows.length, returned: shown.length, offset: a.offset, pages: shown.map(page),
        ...(a.offset + shown.length < rows.length ? { hint: `${rows.length - a.offset - shown.length} more; use offset=${a.offset + shown.length} or narrow the filters.` } : {}),
      };
    },
  );

  // ---------------------------------------------------------------- audit_url
  tool(
    'audit_url', 'Audit a single URL',
    'Fetches one URL (no site crawl, nothing saved) and returns its on-page SEO / indexability / structured-data findings with fixes. Site-wide checks (duplicates, orphans, broken-link targets) need crawl_site.',
    { url: z.string().min(3).max(2000).describe('The page to audit.') },
    true,
    async ({ url }) => {
      const u = httpUrl(url);
      const r = await crawl(resolveOptions({ url: u, maxPages: 1, maxDepth: 0, concurrency: 1, delayMs: 0 }));
      const p = r.pages.find((x) => x.url === u) ?? r.pages[0];
      if (!p) throw new ToolError('No response recorded for that URL.');
      const fixes = new Map(r.checks.map((c) => [c.id, c.howToFix]));
      const issues = r.issues.filter((i) => i.url === p.url).sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
      return {
        url: p.url, status: p.status, redirectTo: p.redirectTo, fetchError: p.fetchError, blockedByRobots: p.blockedByRobots, indexable: p.indexable, indexability: p.indexabilityReason,
        responseTimeMs: p.responseTimeMs, title: p.title, metaDescription: p.metaDescription, canonicals: p.canonicals, metaRobots: p.metaRobots, xRobotsTag: p.xRobotsTag,
        h1: p.headings.filter((h) => h.level === 1).map((h) => h.text), wordCount: p.wordCount, structuredDataTypes: p.structuredData.flatMap((s) => s.types), ai: p.ai,
        issues: issues.slice(0, 50).map((i) => ({ severity: i.severity, check: i.checkId, message: i.message, fix: fixes.get(i.checkId) })),
        ...(issues.length > 50 ? { hint: `${issues.length - 50} more issues omitted.` } : {}),
      };
    },
    true,
  );

  // -------------------------------------------------------- check_ai_readiness
  tool(
    'check_ai_readiness', 'Check a site\'s AI / GEO readiness',
    'Samples a few pages of a site and scores its AI-readiness: llms.txt / llms-full.txt, per-AI-bot robots.txt access (training vs search), structured data, authorship/dates, semantic HTML, JS-only shells. The score mixes hard checks with heuristics. Nothing is saved.',
    { url: z.string().min(3).max(2000).describe('Site URL (the home page is a good choice).'), sample_pages: z.number().int().min(1).max(50).default(10).describe('Pages to sample (default 10).') },
    true,
    async ({ url, sample_pages }) => {
      const u = httpUrl(url);
      const r = await crawl(resolveOptions({ url: u, maxPages: sample_pages, maxDepth: 2, aiBotsCheck: true, delayMs: 250 }));
      const ai = r.aiReadiness;
      if (!ai) throw new ToolError('AI-readiness could not be computed (site unreachable or blocked by robots.txt).');
      const llms = (f: typeof ai.llmsTxt) => ({ present: f.present, valid: f.valid, status: f.status, problems: f.problems.slice(0, 8), links: f.linkCount, brokenLinks: f.brokenLinks.slice(0, 8) });
      const issues = r.issues.filter((i) => i.category === 'ai-readiness');
      return {
        site: r.seed, pagesSampled: r.pages.length, score: ai.score, components: ai.components.map((c) => ({ id: c.id, score: `${c.score}/${c.max}`, note: c.note })),
        llmsTxt: llms(ai.llmsTxt), llmsFullTxt: llms(ai.llmsFullTxt),
        bots: ai.bots.map((b) => ({ bot: b.bot, purpose: b.purpose, access: b.allowed ? (b.partial ? 'partial' : 'allowed') : 'blocked' })),
        stats: ai.stats, issues: issues.slice(0, 30).map(issueRow), ...(issues.length > 30 ? { hint: `${issues.length - 30} more issues omitted.` } : {}), disclaimer: ai.disclaimer,
      };
    },
    true,
  );

  // ---------------------------------------------------------- check_robots_url
  tool(
    'check_robots_url', 'Is this URL allowed by robots.txt?',
    'Fetches the site\'s robots.txt and says whether a URL may be crawled by a given user agent (RFC 9309 longest-match rules), with the deciding rule, crawl-delay and sitemaps.',
    { url: z.string().min(3).max(4000).describe('URL to test.'), user_agent: z.string().max(300).optional().describe('User agent or product token, e.g. "Googlebot", "GPTBot" (default: crawlscope).') },
    true,
    async ({ url, user_agent }) => {
      const u = httpUrl(url);
      const ua = user_agent?.trim() || DEFAULT_UA;
      const robotsUrl = originOf(u) + '/robots.txt';
      const f = new Fetcher({ userAgent: ua, delayMs: 0, timeoutMs: 15000, maxBodyBytes: 600 * 1024, maxRetries: 1, maxRetryWaitMs: 5000 });
      const res = await f.request(robotsUrl, { readBody: (s) => s === 200 });
      const base = { url: u, userAgent: ua, robotsUrl };
      if (res.error) return { ...base, allowed: false, mode: 'disallow-all', reason: `robots.txt unreachable (${res.error.code}); RFC 9309 says to treat the site as disallowed.` };
      if (res.status >= 500) return { ...base, status: res.status, allowed: false, mode: 'disallow-all', reason: `robots.txt returned ${res.status}; treated as disallow-all.` };
      if (res.status !== 200 || !res.body) return { ...base, status: res.status, allowed: true, mode: 'allow-all', reason: `robots.txt returned ${res.status} (not found): no restrictions.` };
      const parsed = parseRobots(res.body.toString('utf8'));
      const m = robotsMatcher(parsed, ua);
      const rule = m.matchingRule(pathAndQuery(u));
      return {
        ...base, status: 200, allowed: m.isAllowed(pathAndQuery(u)), mode: 'rules', groupMatchedBy: m.matchedBy, decidingRule: rule ? `${rule.type}: ${rule.path}` : 'none (default allow)',
        crawlDelaySeconds: m.crawlDelay, sitemaps: parsed.sitemaps.slice(0, 10), syntaxWarnings: parsed.warnings.slice(0, 5),
      };
    },
    true,
  );

  // ------------------------------------------------------------- diff_crawls
  tool(
    'diff_crawls', 'Compare two crawls',
    'Compares an older and a newer crawl: pages added/removed/changed, issues new/resolved/persisting, per-check deltas and score changes. Defaults: crawl_b = latest crawl, crawl_a = the previous crawl of the same site.',
    {
      crawl_a: z.string().max(300).optional().describe('Baseline (older) crawl_id.'), crawl_b: z.string().max(300).optional().describe('Newer crawl_id (default latest).'),
      limit: z.number().int().min(1).max(100).default(15).describe('Max items per list (default 15).'),
    },
    true,
    ({ crawl_a, crawl_b, limit: n }) => {
      const b = store.resolveRef(crawl_b);
      let aName = crawl_a;
      if (!aName) {
        const prev = store.list().find((e) => e.name !== b.name && hostOf(e.seed) === hostOf(b.seed) && e.startedAt <= b.startedAt);
        if (!prev) throw new ToolError(`No earlier crawl of ${hostOf(b.seed)} to compare with. Pass crawl_a explicitly or run crawl_site again first.`);
        aName = prev.name;
      }
      const a = store.resolveRef(aName);
      if (a.name === b.name) throw new ToolError('crawl_a and crawl_b are the same crawl.');
      const d = diffCrawls(store.load(a.name), store.load(b.name));
      const slim = (i: { checkId: string; severity: string; url: string; message: string }) => ({ severity: i.severity, check: i.checkId, url: i.url, message: i.message });
      return {
        a: { crawl_id: a.name, seed: d.a.seed, pages: d.a.pages, healthScore: d.a.healthScore, issues: d.a.issues }, b: { crawl_id: b.name, seed: d.b.seed, pages: d.b.pages, healthScore: d.b.healthScore, issues: d.b.issues },
        deltas: d.deltas, totals: d.totals, fieldCounts: d.fieldCounts,
        checksChanged: d.byCheck.filter((c) => c.added || c.resolved).sort((x, y) => y.added + y.resolved - (x.added + x.resolved)).slice(0, n).map((c) => ({ check: c.checkId, severity: c.severity, before: c.before, after: c.after, added: c.added, resolved: c.resolved })),
        pagesAdded: d.pages.added.slice(0, n), pagesRemoved: d.pages.removed.slice(0, n),
        pagesChanged: d.pages.changed.slice(0, n).map((c) => ({ url: c.url, changes: c.changes.map((x) => `${x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`.slice(0, 160)) })),
        issuesAdded: d.issues.added.slice(0, n).map(slim), issuesResolved: d.issues.resolved.slice(0, n).map(slim),
        hint: 'Lists are capped by `limit`; totals show full counts. Use list_issues on crawl_b for details.',
      };
    },
  );

  // ------------------------------------------------------------ export_report
  tool(
    'export_report', 'Write a report / CSV files for a crawl',
    'Writes (or refreshes) report files inside the crawl directory and returns their absolute paths: "html" = self-contained report.html to open in a browser, "csv" = pages.csv, issues.csv, links.csv, "json" = crawl.json.',
    { crawl_id: crawlRef, format: z.enum(['html', 'csv', 'json']).default('html') },
    false,
    ({ crawl_id, format }) => {
      const { entry, result: r } = store.get(crawl_id);
      if (format !== 'json') writeCrawlDir(entry.dir, r, [format]);
      const names = format === 'html' ? ['report.html'] : format === 'csv' ? ['pages.csv', 'issues.csv', 'links.csv'] : ['crawl.json'];
      return { crawl_id: entry.name, files: names.map((n) => join(entry.dir, n)).filter((f) => existsSync(f)).map((f) => ({ path: f, bytes: statSync(f).size })) };
    },
  );

  // --------------------------------------------------------------- resources
  const summaryResource = (name: string) => JSON.stringify(summaryOf(store.load(name), name, 20), null, 1);
  server.registerResource(
    'latest-crawl-summary', 'crawlscope://crawls/latest/summary',
    { title: 'Latest crawl summary', description: 'Summary of the most recent saved crawl.', mimeType: 'application/json' },
    (uri) => {
      const e = store.resolveRef('latest');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: summaryResource(e.name) }] };
    },
  );
  server.registerResource(
    'crawl-summary', new ResourceTemplate('crawlscope://crawls/{id}/summary', {
      list: () => ({ resources: store.list().slice(0, 50).map((e) => ({ uri: `crawlscope://crawls/${e.name}/summary`, name: `${e.name} summary`, mimeType: 'application/json' })) }),
    }),
    { title: 'Crawl summary', description: 'Summary of a saved crawl by crawl_id.', mimeType: 'application/json' },
    (uri, vars) => {
      const e = store.resolveRef(String(vars.id));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: summaryResource(e.name) }] };
    },
  );

  return { server, store };
}
