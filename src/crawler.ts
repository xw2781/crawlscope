import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fetcher, VERSION, type FetchResult } from './fetcher.js';
import { extractHtml } from './extract.js';
import { parseRobots, robotsMatcher, type RobotsMatcher } from './robots.js';
import { discoverSitemaps } from './sitemap.js';
import { inspectLlmsFile } from './llms.js';
import { computeAiReadiness } from './ai-readiness.js';
import { ALL_CHECKS, checkMeta, runChecks } from './checks/index.js';
import { hostOf, isSameSite, normalizeUrl, originOf, pathAndQuery } from './util/url.js';
import { summarize } from './summary.js';
import { decodeBody } from './util/charset.js';
import { parseLinkHeader, xRobotsDirectives } from './util/headers.js';
import {
  SCHEMA_VERSION,
  type CheckContext, type CrawlOptions, type CrawlResult, type ExternalLinkResult, type LinkRecord, type PageRecord,
  type RobotsInfo, type SiteProbes, type SitemapFile, type SitemapUrl,
} from './types.js';

export type CrawlPhase = 'starting' | 'robots' | 'sitemaps' | 'crawling' | 'probes' | 'external' | 'analyzing' | 'done';

export interface CrawlProgress {
  crawled: number;
  queued: number;
  url: string;
  status: number;
  /** pages that failed or returned >= 400 so far */
  errors: number;
  /** requests currently in flight */
  active: number;
  responseTimeMs: number | null;
  depth: number | null;
  /** ms since the crawl started */
  elapsedMs: number;
}

export interface CrawlHooks {
  /** called after every page. Extra fields beyond crawled/queued/url/status are additive. */
  onProgress?(p: CrawlProgress): void;
  /** coarse phase transitions, useful for UIs and MCP progress notifications */
  onPhase?(phase: CrawlPhase): void;
  onLog?(msg: string): void;
  /** abort signal to stop gracefully (result.status = 'partial') */
  signal?: AbortSignal;
}

interface QueueItem {
  url: string;
  depth: number;
  via: PageRecord['discoveredVia'];
}

interface StoredLine {
  page: PageRecord;
  links: LinkRecord[];
}

const KEEP_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'cache-control', 'etag', 'last-modified', 'server', 'x-robots-tag', 'strict-transport-security', 'location', 'link', 'retry-after', 'x-powered-by', 'content-security-policy', 'content-security-policy-report-only'];

export const STATE_FILE = 'state.jsonl';
export const CRAWL_FILE = 'crawl.json';

const MAX_URL_LENGTH = 4096;

/** Path pattern used for trap detection: numeric/date segments collapse, query keys only. */
export function urlPattern(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split('/').map((s) => (/^\d+$/.test(s) || /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? '{n}' : s));
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  return `${u.host}${segs.join('/')}${keys.length ? '?' + keys.join('&') : ''}`;
}

const isHtmlType = (ct: string | undefined | null) => !!ct && /(text\/html|application\/xhtml\+xml)/i.test(ct);

export function blankPage(url: string, via: PageRecord['discoveredVia'], depth: number | null): PageRecord {
  return {
    url, finalUrl: url, status: 0, statusText: '', depth, discoveredVia: via, fetchedAt: new Date().toISOString(),
    blockedByRobots: false, fetchError: null, reusedFromCache: false, redirectTo: null, contentType: null, isHtml: false,
    responseTimeMs: null, sizeBytes: null, bodyTruncated: false, etag: null, lastModified: null, headers: {}, xRobotsTag: null,
    title: null, titleCount: 0, metaDescription: null, metaDescriptionCount: 0, metaRobots: null, canonicals: [], canonicalRelative: false,
    lang: null, viewport: null, headings: [], hreflang: [], images: [], og: {}, twitter: {}, structuredData: [],
    paginationNext: null, paginationPrev: null, faviconHref: null, mixedContent: [], wordCount: 0, textBytes: 0, textRatio: null,
    contentHash: null, simhash: null, indexable: false, indexabilityReason: 'not fetched', noindex: false, nofollow: false,
    metaRefresh: null, canonicalHeader: null, resources: { iframes: [], srcset: [] }, charset: null,
    inlinks: 0, uniqueInlinkSources: 0, outlinksInternal: 0, outlinksExternal: 0, inSitemap: false,
    ai: { hasMain: false, hasArticle: false, hasAuthor: false, hasDate: false, datePublished: null, dateModified: null, hasJsonLd: false,
      faqLike: false, summaryLike: false, jsShell: false, scriptCount: 0, snippetDirectives: [], articleLike: false },
  };
}

export class Crawler {
  private opts: CrawlOptions;
  private fetcher: Fetcher;
  private hooks: CrawlHooks;
  private seed: string;
  private effectiveSeed: string;
  private includeRe: RegExp[];
  private excludeRe: RegExp[];
  private queue: QueueItem[] = [];
  private sitemapQueue: QueueItem[] = [];
  private seen = new Set<string>();
  private pages = new Map<string, PageRecord>();
  private pageLinks = new Map<string, LinkRecord[]>();
  private robotsCache = new Map<string, Promise<{ info: RobotsInfo; matcher: RobotsMatcher | null }>>();
  private externalTargets = new Map<string, Set<string>>();
  private prior = new Map<string, StoredLine>();
  private priorMode: 'none' | 'resume' | 'incremental' = 'none';
  private fetchedCount = 0;
  private errorCount = 0;
  private activeCount = 0;
  private startedMs = Date.now();
  private truncated = false;
  private statePath: string | null = null;
  private sitemapUrlSet = new Set<string>();
  private patternCounts = new Map<string, number>();
  private traps = new Map<string, { pattern: string; skipped: number; example: string }>();

  constructor(options: CrawlOptions, hooks: CrawlHooks = {}) {
    this.opts = options;
    this.hooks = hooks;
    const seed = normalizeUrl(options.url);
    if (!seed) throw new Error(`Invalid start URL: ${options.url}`);
    this.seed = seed;
    this.effectiveSeed = seed;
    this.includeRe = options.include.map((p) => new RegExp(p));
    this.excludeRe = options.exclude.map((p) => new RegExp(p));
    this.fetcher = new Fetcher({
      userAgent: options.userAgent, delayMs: options.delayMs, timeoutMs: options.timeoutMs,
      maxBodyBytes: options.maxBodyBytes, maxRetries: options.maxRetries, maxRetryWaitMs: options.maxRetryWaitMs,
    });
  }

  private emitProgress(url: string, status: number, responseTimeMs: number | null, depth: number | null) {
    this.hooks.onProgress?.({
      crawled: this.fetchedCount, queued: this.queue.length + this.sitemapQueue.length, url, status, errors: this.errorCount,
      active: this.activeCount, responseTimeMs, depth, elapsedMs: Date.now() - this.startedMs,
    });
  }

  private phase(p: CrawlPhase) {
    this.hooks.onPhase?.(p);
  }

  private log(msg: string) {
    this.hooks.onLog?.(msg);
  }

  private inScope(url: string): boolean {
    return isSameSite(url, this.effectiveSeed, this.opts.subdomains);
  }

  private allowedByFilters(url: string): boolean {
    if (url === this.seed) return true;
    if (this.includeRe.length && !this.includeRe.some((r) => r.test(url))) return false;
    if (this.excludeRe.some((r) => r.test(url))) return false;
    return true;
  }

  private enqueue(url: string, depth: number, via: QueueItem['via']) {
    if (this.seen.has(url)) return;
    if (!this.inScope(url) || !this.allowedByFilters(url)) return;
    if (this.opts.maxDepth !== null && depth > this.opts.maxDepth) return;
    if (url.length > MAX_URL_LENGTH) {
      // never sent: recorded as a failed page so it shows up in reports
      this.seen.add(url);
      const p = blankPage(url, via, depth);
      p.fetchError = { code: 'URL_TOO_LONG', message: `URL is ${url.length} characters (limit ${MAX_URL_LENGTH}); not requested` };
      p.indexabilityReason = 'fetch failed (URL_TOO_LONG)';
      this.pages.set(url, p);
      this.pageLinks.set(url, []);
      return;
    }
    if (via !== 'sitemap' && via !== 'seed' && this.opts.maxUrlsPerPattern > 0) {
      const pattern = urlPattern(url);
      const n = this.patternCounts.get(pattern) ?? 0;
      if (n >= this.opts.maxUrlsPerPattern) {
        let t = this.traps.get(pattern);
        if (!t) {
          this.traps.set(pattern, (t = { pattern, skipped: 0, example: url }));
          this.log(`Possible crawl trap: more than ${this.opts.maxUrlsPerPattern} URLs match ${pattern}; skipping the rest (raise --max-urls-per-pattern to override)`);
        }
        t.skipped++;
        return;
      }
      this.patternCounts.set(pattern, n + 1);
    }
    this.seen.add(url);
    (via === 'sitemap' ? this.sitemapQueue : this.queue).push({ url, depth, via });
  }

  private getRobots(origin: string): Promise<{ info: RobotsInfo; matcher: RobotsMatcher | null }> {
    let p = this.robotsCache.get(origin);
    if (!p) {
      p = this.loadRobots(origin);
      this.robotsCache.set(origin, p);
    }
    return p;
  }

  private async loadRobots(origin: string): Promise<{ info: RobotsInfo; matcher: RobotsMatcher | null }> {
    const url = origin + '/robots.txt';
    const info: RobotsInfo = { url, status: null, present: false, fetchError: null, mode: 'allow-all', sizeBytes: null, parsed: null, raw: null };
    const res = await this.fetcher.request(url, { maxBodyBytes: 600 * 1024, readBody: (s) => s === 200 });
    if (res.error) {
      info.fetchError = res.error.message;
      info.mode = 'disallow-all';
    } else {
      info.status = res.status;
      if (res.status === 200 && res.body) {
        const text = res.body.toString('utf8');
        info.present = true;
        info.sizeBytes = res.bytes;
        info.raw = text.slice(0, 64 * 1024);
        info.parsed = parseRobots(text);
        info.mode = 'rules';
      } else if (res.status >= 500) info.mode = 'disallow-all';
      else info.mode = 'allow-all'; // 4xx (and redirects) => no restrictions (RFC 9309 §2.3.1.3)
    }
    let matcher: RobotsMatcher | null = null;
    if (info.mode === 'rules') matcher = robotsMatcher(info.parsed, this.opts.userAgent);
    return { info, matcher };
  }

  private async robotsDecision(url: string): Promise<{ allowed: boolean; delayMs: number }> {
    if (!this.opts.respectRobots) return { allowed: true, delayMs: 0 };
    const { info, matcher } = await this.getRobots(originOf(url));
    if (info.mode === 'disallow-all') return { allowed: false, delayMs: 0 };
    if (!matcher) return { allowed: true, delayMs: 0 };
    const delay = matcher.crawlDelay !== null ? Math.min(60, matcher.crawlDelay) * 1000 : 0;
    return { allowed: matcher.isAllowed(pathAndQuery(url)), delayMs: delay };
  }

  private loadPrior(outDir: string) {
    const statePath = join(outDir, STATE_FILE);
    if (!existsSync(statePath)) return;
    let complete = false;
    const crawlPath = join(outDir, CRAWL_FILE);
    if (existsSync(crawlPath)) {
      try {
        const prev = JSON.parse(readFileSync(crawlPath, 'utf8'));
        complete = prev.status === 'complete' && !prev.truncated;
      } catch {
        complete = false;
      }
    }
    for (const line of readFileSync(statePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as StoredLine;
        if (rec?.page?.url) this.prior.set(rec.page.url, rec);
      } catch {
        /* ignore a torn last line from an interrupted run */
      }
    }
    this.priorMode = this.prior.size ? (complete ? 'incremental' : 'resume') : 'none';
    this.log(`Loaded ${this.prior.size} stored pages (${this.priorMode} mode)`);
  }

  private persist(page: PageRecord, links: LinkRecord[]) {
    if (!this.statePath) return;
    appendFileSync(this.statePath, JSON.stringify({ page, links } satisfies StoredLine) + '\n');
  }

  async run(): Promise<CrawlResult> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const o = this.opts;
    this.startedMs = Date.now();
    this.phase('starting');
    if (o.outDir) {
      mkdirSync(o.outDir, { recursive: true });
      this.statePath = join(o.outDir, STATE_FILE);
      if (o.resume) this.loadPrior(o.outDir);
      else writeFileSync(this.statePath, '');
    }

    // robots for the seed origin
    this.phase('robots');
    const seedRobots = await this.getRobots(originOf(this.seed));
    if (seedRobots.info.mode === 'disallow-all' && o.respectRobots) this.log('robots.txt is unreachable or returned 5xx: treating the site as disallowed (RFC 9309)');

    // sitemaps
    this.phase('sitemaps');
    const robotsDelay = seedRobots.matcher?.crawlDelay ? Math.min(60, seedRobots.matcher.crawlDelay) * 1000 : 0;
    const sm = await discoverSitemaps(this.fetcher, originOf(this.seed), seedRobots.info.parsed?.sitemaps ?? [], o.sitemapUrls, robotsDelay);
    const sitemapUrls: SitemapUrl[] = sm.urls;
    for (const u of sitemapUrls) this.sitemapUrlSet.add(u.loc);

    this.enqueue(this.seed, 0, 'seed');
    // sitemap URLs are crawled after link-discovered ones
    for (const u of this.sitemapUrlSet) this.enqueue(u, 1, 'sitemap');

    this.phase('crawling');
    await this.runWorkers();

    const finishedAtMs = Date.now();
    const aborted = !!this.hooks.signal?.aborted;

    // ---- site probes ----
    this.phase('probes');
    const site = await this.runProbes(robotsDelay);
    if (this.traps.size) site.trapPatterns = [...this.traps.values()];

    // ---- AI readiness inputs ----
    const origin = originOf(this.effectiveSeed);
    const llmsTxt = await inspectLlmsFile(this.fetcher, origin + '/llms.txt', 'llms', { checkLinks: o.aiBotsCheck, hostDelayMs: robotsDelay });
    const llmsFull = await inspectLlmsFile(this.fetcher, origin + '/llms-full.txt', 'llms-full', { hostDelayMs: robotsDelay });

    // ---- external link check ----
    if (o.externalCheck) this.phase('external');
    const externalLinks = o.externalCheck && !aborted ? await this.checkExternal(robotsDelay) : [];

    // ---- finalise ----
    this.phase('analyzing');
    const pages = [...this.pages.values()];
    const links: LinkRecord[] = [];
    for (const p of pages) links.push(...(this.pageLinks.get(p.url) ?? []));
    this.finalizePages(pages, links);

    const complete = !this.truncated && !aborted;
    const aiReadiness = computeAiReadiness({
      pages, llmsTxt, llmsFullTxt: llmsFull, robotsParsed: seedRobots.info.parsed, robotsMode: seedRobots.info.mode,
      sitemaps: sm.files, sitemapUrls,
    });
    const ctx = buildContext(o, this.effectiveSeed, pages, links, seedRobots.info, sm.files, sitemapUrls, externalLinks, site, aiReadiness, complete);
    const issues = runChecks(ctx, ALL_CHECKS);
    const options = { ...o } as Partial<CrawlOptions>;
    delete options.outDir;
    const result: CrawlResult = {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'crawlscope', version: VERSION },
      id: `${hostOf(this.seed).replace(/[^a-z0-9.-]/gi, '_')}-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`,
      seed: this.seed,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Date.now() - started,
      status: aborted ? 'partial' : 'complete',
      truncated: this.truncated,
      options: options as CrawlResult['options'],
      summary: undefined as never,
      pages, links, issues,
      checks: checkMeta(),
      robots: seedRobots.info,
      sitemaps: sm.files,
      sitemapUrls,
      aiReadiness,
      externalLinks,
      site,
    };
    result.summary = summarize(result);
    this.phase('done');
    return result;
  }

  // -------------------------------------------------------------------------
  private async runWorkers() {
    const o = this.opts;
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = () => {
        for (;;) {
          if (this.hooks.signal?.aborted) {
            if (active === 0) return resolve();
            return;
          }
          const limitHit = o.maxPages !== null && this.fetchedCount + active >= o.maxPages;
          if (limitHit) {
            if (this.queue.length || this.sitemapQueue.length) this.truncated = true;
            if (active === 0) return resolve();
            return;
          }
          if (active >= o.concurrency) return;
          const item = this.queue.shift() ?? this.sitemapQueue.shift();
          if (!item) {
            if (active === 0) return resolve();
            return;
          }
          active++;
          this.activeCount = active;
          this.processItem(item)
            .catch((e) => this.log(`Error processing ${item.url}: ${(e as Error).message}`))
            .finally(() => {
              active--;
              this.activeCount = active;
              pump();
            });
        }
      };
      pump();
    });
  }

  private async processItem(item: QueueItem) {
    const { url, depth, via } = item;
    const decision = await this.robotsDecision(url);
    if (!decision.allowed) {
      const p = blankPage(url, via, depth);
      p.blockedByRobots = true;
      p.indexabilityReason = 'blocked by robots.txt';
      this.pages.set(url, p);
      this.pageLinks.set(url, []);
      this.emitProgress(url, 0, null, depth);
      return;
    }

    const prior = this.prior.get(url);
    let conditional: Record<string, string> = {};
    if (prior && this.priorMode === 'resume' && prior.page.status !== 0) {
      // interrupted crawl: reuse stored data without touching the network
      this.accept(prior.page, prior.links, depth, via, true);
      return;
    }
    if (prior && this.priorMode === 'incremental') {
      if (prior.page.etag) conditional['if-none-match'] = prior.page.etag;
      if (prior.page.lastModified) conditional['if-modified-since'] = prior.page.lastModified;
    }

    const res = await this.fetcher.request(url, {
      headers: conditional,
      hostDelayMs: decision.delayMs,
      readBody: (status, h) => status >= 200 && status < 300 && isHtmlType(h['content-type']),
    });

    if (res.status === 304 && prior) {
      const page = { ...prior.page, reusedFromCache: true, fetchedAt: new Date().toISOString(), responseTimeMs: res.timeMs };
      this.accept(page, prior.links, depth, via, false);
      return;
    }
    const { page, links } = this.buildPage(url, depth, via, res);
    this.accept(page, links, depth, via, false);
  }

  /** Register a finished page, store its links and enqueue new URLs. */
  private accept(page: PageRecord, links: LinkRecord[], depth: number, via: PageRecord['discoveredVia'], fromState: boolean) {
    page.depth = depth;
    page.discoveredVia = via;
    page.inSitemap = this.sitemapUrlSet.has(page.url);
    this.pages.set(page.url, page);
    this.pageLinks.set(page.url, links);
    this.fetchedCount++;
    if (!fromState) this.persist(page, links);
    const meta = (page.metaRobots ?? '') + ',' + (page.xRobotsTag ?? '');
    const pageNofollow = /nofollow|none/i.test(meta);
    for (const l of links) {
      if (l.internal) {
        if (l.type === 'a' && this.opts.respectNofollow && (l.nofollow || pageNofollow)) continue;
        // the seed may redirect to another host: adopt it as the site root
        this.enqueue(l.to, depth + (l.type === 'redirect' ? 0 : 1), l.type === 'redirect' ? 'redirect' : 'link');
      } else if (l.type === 'a') {
        let set = this.externalTargets.get(l.to);
        if (!set) this.externalTargets.set(l.to, (set = new Set()));
        set.add(l.from);
      }
    }
    if (page.status === 0 || page.status >= 400) this.errorCount++;
    this.emitProgress(page.url, page.status, page.responseTimeMs, depth);
  }

  private buildPage(url: string, depth: number, via: PageRecord['discoveredVia'], res: FetchResult): { page: PageRecord; links: LinkRecord[] } {
    const page = blankPage(url, via, depth);
    const links: LinkRecord[] = [];
    page.status = res.status;
    page.statusText = res.statusText;
    page.responseTimeMs = res.timeMs;
    page.fetchError = res.error;
    page.sizeBytes = res.bytes || null;
    page.bodyTruncated = res.truncated;
    for (const k of KEEP_HEADERS) if (res.headers[k] !== undefined) page.headers[k] = res.headers[k];
    page.contentType = res.headers['content-type'] ?? null;
    page.etag = res.headers['etag'] ?? null;
    page.lastModified = res.headers['last-modified'] ?? null;
    page.xRobotsTag = res.headers['x-robots-tag'] ?? null;
    page.isHtml = isHtmlType(page.contentType);

    if (res.error) {
      page.indexabilityReason = `fetch failed (${res.error.code})`;
      return { page, links };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers['location'];
      const target = loc ? normalizeUrl(loc, url) : null;
      page.redirectTo = target;
      page.indexabilityReason = 'redirect';
      if (target) {
        const internal = this.inScope(target);
        if (!internal && url === this.seed && !this.pages.size) {
          // seed redirects to another site (e.g. apex -> different domain): follow that site
          this.effectiveSeed = target;
        }
        links.push({ from: url, to: target, type: 'redirect', anchor: '', rel: [], nofollow: false, internal: this.inScope(target), imageOnly: false });
      }
      return { page, links };
    }
    if (res.status >= 200 && res.status < 300 && page.isHtml && res.body) {
      const dec = decodeBody(res.body, page.contentType);
      page.charset = dec.charset;
      if (dec.binary) {
        // binary data labelled as HTML: don't parse it
        page.isHtml = false;
        page.indexabilityReason = 'binary content served as HTML';
        return { page, links };
      }
      const html = dec.text;
      const x = extractHtml(html, url, page.xRobotsTag, this.effectiveSeed);
      const { links: raw, ai, cspMeta, ...rest } = x;
      Object.assign(page, rest);
      page.ai = ai;
      const cspHeader = !!res.headers['content-security-policy']?.trim();
      page.csp = {
        enforced: cspHeader || cspMeta,
        reportOnly: !!res.headers['content-security-policy-report-only']?.trim(),
        source: cspHeader && cspMeta ? 'both' : cspHeader ? 'header' : cspMeta ? 'meta' : null,
      };
      page.faviconHref = x.faviconHref;
      const directives = `${page.metaRobots ?? ''},${xRobotsDirectives(page.xRobotsTag).join(',')}`;
      page.noindex = /(^|[\s,])(noindex|none)([\s,]|$)/.test(directives);
      page.nofollow = /(^|[\s,])(nofollow|none)([\s,]|$)/.test(directives);
      if (page.metaRefresh?.url) {
        const t = normalizeUrl(page.metaRefresh.url, url);
        if (t) raw.push({ to: t, anchor: '', rel: ['meta-refresh'], imageOnly: false });
      }
      const seen = new Set<string>();
      for (const l of raw) {
        const key = `${l.to}|${l.anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          from: url, to: l.to, type: 'a', anchor: l.anchor, rel: l.rel, imageOnly: l.imageOnly,
          nofollow: l.rel.includes('nofollow') || l.rel.includes('ugc') || l.rel.includes('sponsored'), internal: this.inScope(l.to),
        });
      }
    } else if (res.status >= 200 && res.status < 300) {
      page.noindex = /(^|[\s,])(noindex|none)([\s,]|$)/.test(xRobotsDirectives(page.xRobotsTag).join(','));
    }
    // HTTP Link header: canonical and hreflang alternates (HTML and non-HTML responses)
    if (res.status >= 200 && res.status < 300) {
      for (const hl of parseLinkHeader(res.headers['link'])) {
        const t = normalizeUrl(hl.url, url);
        if (!t) continue;
        if (hl.rel.includes('canonical')) {
          page.canonicalHeader = t;
          if (!page.canonicals.includes(t)) page.canonicals.push(t);
        } else if (hl.rel.includes('alternate') && hl.hreflang) {
          page.hreflang.push({ lang: hl.hreflang, href: t, source: 'header' });
        }
      }
    }
    // indexability
    if (res.status !== 200) page.indexabilityReason = `HTTP ${res.status}`;
    else if (!page.isHtml) page.indexabilityReason = 'not HTML';
    else if (page.noindex) page.indexabilityReason = 'noindex';
    else if (page.canonicals.length === 1 && page.canonicals[0] !== url) page.indexabilityReason = 'canonicalised to another URL';
    else {
      page.indexable = true;
      page.indexabilityReason = 'indexable';
    }
    return { page, links };
  }

  private finalizePages(pages: PageRecord[], links: LinkRecord[]) {
    const byUrl = new Map(pages.map((p) => [p.url, p]));
    const adjacency = new Map<string, string[]>();
    const inSources = new Map<string, Set<string>>();
    const inCount = new Map<string, number>();
    for (const l of links) {
      if (!adjacency.has(l.from)) adjacency.set(l.from, []);
      adjacency.get(l.from)!.push(l.to);
      if (l.type === 'a' && l.internal && l.from !== l.to) {
        inCount.set(l.to, (inCount.get(l.to) ?? 0) + 1);
        let s = inSources.get(l.to);
        if (!s) inSources.set(l.to, (s = new Set()));
        s.add(l.from);
      }
    }
    const outBy = new Map<string, LinkRecord[]>();
    for (const l of links) if (l.type === 'a') (outBy.get(l.from) ?? outBy.set(l.from, []).get(l.from)!).push(l);
    for (const p of pages) {
      p.inlinks = inCount.get(p.url) ?? 0;
      p.uniqueInlinkSources = inSources.get(p.url)?.size ?? 0;
      const out = outBy.get(p.url) ?? [];
      p.outlinksInternal = out.filter((l) => l.internal).length;
      p.outlinksExternal = out.filter((l) => !l.internal).length;
      p.inSitemap = this.sitemapUrlSet.has(p.url);
      p.depth = null;
    }
    // BFS depth from the seed over links (shortest click distance)
    const root = byUrl.has(this.seed) ? this.seed : this.effectiveSeed;
    const q: string[] = [];
    const rootPage = byUrl.get(root);
    if (rootPage) {
      rootPage.depth = 0;
      q.push(root);
    }
    for (let i = 0; i < q.length; i++) {
      const cur = byUrl.get(q[i])!;
      for (const next of adjacency.get(cur.url) ?? []) {
        const t = byUrl.get(next);
        if (t && t.depth === null) {
          // redirects do not add a click
          const isRedirectHop = cur.redirectTo === next;
          t.depth = cur.depth! + (isRedirectHop ? 0 : 1);
          q.push(next);
        }
      }
    }
  }

  private async runProbes(robotsDelay: number): Promise<SiteProbes> {
    const origin = originOf(this.effectiveSeed);
    const seedPage = this.pages.get(this.effectiveSeed) ?? this.pages.get(this.seed);
    const isHttps = this.effectiveSeed.startsWith('https:');
    const probes: SiteProbes = { soft404: null, httpRedirect: null, favicon: null, hsts: seedPage?.headers['strict-transport-security'] ?? null, isHttps };
    const common = { hostDelayMs: robotsDelay, readBody: () => false };
    if (this.hooks.signal?.aborted) return probes;
    // soft-404 probe
    const probeUrl = `${origin}/crawlscope-probe-${randomBytes(6).toString('hex')}`;
    const r = await this.fetcher.request(probeUrl, common);
    probes.soft404 = { url: probeUrl, status: r.error ? null : r.status };
    // http -> https
    const u = new URL(this.effectiveSeed);
    const local = u.port !== '' || u.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname);
    if (isHttps && !local) {
      const httpUrl = 'http://' + u.host + '/';
      const hr = await this.fetcher.request(httpUrl, common);
      const loc = hr.headers['location'] ?? null;
      probes.httpRedirect = { tested: true, startUrl: httpUrl, status: hr.error ? null : hr.status, location: loc, redirectsToHttps: hr.status >= 300 && hr.status < 400 && !!loc && loc.startsWith('https:') };
    } else probes.httpRedirect = { tested: false, startUrl: this.effectiveSeed, status: null, location: null, redirectsToHttps: isHttps };
    // favicon
    const declared = seedPage?.faviconHref ?? null;
    const favUrl = declared ?? origin + '/favicon.ico';
    let fr = await this.fetcher.request(favUrl, { ...common, method: 'HEAD' });
    if (fr.error || fr.status === 405 || fr.status === 501) fr = await this.fetcher.request(favUrl, common);
    probes.favicon = { url: favUrl, status: fr.error ? null : fr.status, declaredInHtml: !!declared };
    return probes;
  }

  private async checkExternal(robotsDelay: number): Promise<ExternalLinkResult[]> {
    const targets = [...this.externalTargets.entries()].slice(0, 500);
    const results: ExternalLinkResult[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        if (this.hooks.signal?.aborted) return;
        const [url, froms] = targets[idx++];
        let r = await this.fetcher.request(url, { method: 'HEAD', hostDelayMs: robotsDelay });
        let method: 'HEAD' | 'GET' = 'HEAD';
        if (r.error || r.status >= 400) {
          r = await this.fetcher.request(url, { hostDelayMs: robotsDelay, readBody: () => false });
          method = 'GET';
        }
        results.push({ url, status: r.error ? null : r.status, error: r.error ? `${r.error.code}: ${r.error.message}` : null, method, linkedFrom: [...froms].slice(0, 20) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, targets.length) }, worker));
    return results.sort((a, b) => a.url.localeCompare(b.url));
  }
}

export function buildContext(
  options: CrawlOptions, seed: string, pages: PageRecord[], links: LinkRecord[], robots: RobotsInfo, sitemaps: SitemapFile[],
  sitemapUrls: SitemapUrl[], externalLinks: ExternalLinkResult[], site: SiteProbes, aiReadiness: CheckContext['aiReadiness'], complete: boolean,
): CheckContext {
  const inlinksByUrl = new Map<string, LinkRecord[]>();
  const outlinksByUrl = new Map<string, LinkRecord[]>();
  for (const l of links) {
    (outlinksByUrl.get(l.from) ?? outlinksByUrl.set(l.from, []).get(l.from)!).push(l);
    (inlinksByUrl.get(l.to) ?? inlinksByUrl.set(l.to, []).get(l.to)!).push(l);
  }
  return {
    options, seed, pages, pageByUrl: new Map(pages.map((p) => [p.url, p])), links, inlinksByUrl, outlinksByUrl, robots, sitemaps, sitemapUrls,
    sitemapUrlSet: new Set(sitemapUrls.map((u) => u.loc)), externalLinks, site, aiReadiness, complete,
  };
}

export async function crawl(options: CrawlOptions, hooks: CrawlHooks = {}): Promise<CrawlResult> {
  return new Crawler(options, hooks).run();
}

/** Re-run checks over an existing result (used by report/diff/MCP later). */
export function recheck(result: CrawlResult, options: CrawlOptions): CrawlResult {
  const ctx = buildContext(options, result.seed, result.pages, result.links, result.robots, result.sitemaps, result.sitemapUrls, result.externalLinks, result.site, result.aiReadiness, !result.truncated && result.status === 'complete');
  const issues = runChecks(ctx);
  const next = { ...result, issues };
  next.summary = summarize(next);
  return next;
}
