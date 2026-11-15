import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { crawl, type CrawlPhase } from '../crawler.js';
import { resolveOptions } from '../options.js';
import { writeCrawlDir } from '../output.js';
import { hostOf, normalizeUrl } from '../util/url.js';
import type { CrawlOptions } from '../types.js';

export interface RecentPage { url: string; status: number; ms: number | null }
export interface JobState {
  id: string;
  name: string;
  url: string;
  status: 'running' | 'stopping' | 'done' | 'stopped' | 'error';
  phase: CrawlPhase;
  startedAt: string;
  crawled: number;
  queued: number;
  errors: number;
  active: number;
  rate: number;
  elapsedMs: number;
  maxPages: number | null;
  lastUrl: string;
  error?: string;
  /** crawl directory name once finished */
  result?: string;
}

export class JobError extends Error {}

const num = (v: unknown, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || x > max) throw new JobError(`value ${String(v)} out of range ${min}..${max}`);
  return Math.floor(x);
};
const strList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []).map((s) => String(s).trim()).filter(Boolean);

/** Validate a UI/API start request into CrawlOptions. Throws JobError with a user-facing message. */
export function optionsFromRequest(body: Record<string, unknown>, outDir: string | null): CrawlOptions {
  const raw = String(body.url ?? '').trim();
  const url = normalizeUrl(/^https?:\/\//i.test(raw) ? raw : raw ? `https://${raw}` : '');
  if (!url) throw new JobError('Enter a valid http(s) URL.');
  const include = strList(body.include), exclude = strList(body.exclude);
  for (const p of [...include, ...exclude]) {
    try { new RegExp(p); } catch { throw new JobError(`Invalid regular expression: ${p}`); }
  }
  const sitemapUrls = strList(body.sitemapUrls);
  for (const s of sitemapUrls) if (!normalizeUrl(s)) throw new JobError(`Invalid sitemap URL: ${s}`);
  const ignoreRobots = body.respectRobots === false;
  if (ignoreRobots && body.iOwnThisSite !== true) throw new JobError('Ignoring robots.txt requires confirming that you own this site.');
  const thresholds: Record<string, number> = {};
  const slow = num(body.slowMs, 1, 600000), vslow = num(body.verySlowMs, 1, 600000);
  if (slow !== undefined) thresholds.slowMs = slow;
  if (vslow !== undefined) thresholds.verySlowMs = vslow;
  return resolveOptions({
    url,
    maxPages: num(body.maxPages, 1, 10_000_000) ?? null,
    maxDepth: num(body.maxDepth, 0, 1000) ?? null,
    concurrency: num(body.concurrency, 1, 32) ?? 4,
    delayMs: num(body.delayMs, 0, 60000) ?? 250,
    timeoutMs: num(body.timeoutMs, 500, 120000) ?? 15000,
    include, exclude, sitemapUrls,
    respectRobots: !ignoreRobots,
    respectNofollow: body.respectNofollow === true,
    subdomains: body.subdomains === true,
    externalCheck: body.externalCheck === true,
    aiBotsCheck: body.aiBotsCheck === true,
    ...(typeof body.userAgent === 'string' && body.userAgent.trim() ? { userAgent: body.userAgent.trim().slice(0, 300) } : {}),
    thresholds: thresholds as unknown as CrawlOptions['thresholds'],
    outDir,
  });
}

/** One crawl at a time; emits 'state', 'recent' and 'log' events for SSE fan-out. */
export class JobManager extends EventEmitter {
  current: JobState | null = null;
  private ac: AbortController | null = null;
  private recent: RecentPage[] = [];
  private samples: [number, number][] = [];
  private lastEmit = 0;

  constructor(private dataDir: string) { super(); }

  get running() { return !!this.current && (this.current.status === 'running' || this.current.status === 'stopping'); }

  start(body: Record<string, unknown>): JobState {
    if (this.running) throw new JobError('A crawl is already running. Stop it first.');
    const probe = optionsFromRequest(body, null);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const name = `${hostOf(probe.url).replace(/[^a-z0-9.-]/gi, '_')}-${stamp}`;
    const outDir = join(this.dataDir, name);
    const opts = { ...probe, outDir };
    const job: JobState = {
      id: name, name, url: opts.url, status: 'running', phase: 'starting', startedAt: new Date().toISOString(), crawled: 0, queued: 0, errors: 0, active: 0,
      rate: 0, elapsedMs: 0, maxPages: opts.maxPages, lastUrl: '',
    };
    this.current = job;
    this.recent = []; this.samples = []; this.lastEmit = 0;
    this.ac = new AbortController();
    void this.run(job, opts);
    this.emit('state', job);
    return job;
  }

  stop(): boolean {
    if (!this.running || !this.ac) return false;
    this.current!.status = 'stopping';
    this.ac.abort();
    this.emit('state', this.current);
    return true;
  }

  private async run(job: JobState, opts: CrawlOptions) {
    try {
      const result = await crawl(opts, {
        signal: this.ac!.signal,
        onPhase: (phase) => { job.phase = phase; this.emit('state', job); },
        onLog: (msg) => this.emit('log', msg),
        onProgress: (p) => {
          job.crawled = p.crawled; job.queued = p.queued; job.errors = p.errors; job.active = p.active; job.elapsedMs = p.elapsedMs; job.lastUrl = p.url;
          this.recent.push({ url: p.url, status: p.status, ms: p.responseTimeMs });
          if (this.recent.length > 40) this.recent.shift();
          this.samples.push([p.elapsedMs, p.crawled]);
          while (this.samples.length > 2 && p.elapsedMs - this.samples[0][0] > 5000) this.samples.shift();
          const first = this.samples[0];
          job.rate = p.elapsedMs > first[0] ? Math.round(((p.crawled - first[1]) / ((p.elapsedMs - first[0]) / 1000)) * 10) / 10 : 0;
          const now = Date.now();
          if (now - this.lastEmit >= 200) { this.lastEmit = now; this.emit('state', job); this.emit('recent', this.recent.slice(-12)); }
        },
      });
      writeCrawlDir(opts.outDir!, result, ['json', 'csv', 'html']);
      job.status = result.status === 'partial' ? 'stopped' : 'done';
      job.phase = 'done';
      job.result = job.name;
      job.crawled = result.summary.pagesCrawled;
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message;
    }
    this.emit('state', job);
    this.emit('recent', this.recent.slice(-12));
  }

  /** wait for the running crawl (used by tests and shutdown) */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }
}
