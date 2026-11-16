#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { crawl } from './crawler.js';
import { resolveOptions } from './options.js';
import { VERSION } from './fetcher.js';
import { writeCrawlDir, readCrawl, type OutputFormat } from './output.js';
import { diffDirs, formatDiff } from './diff.js';
import { renderDiffHtml } from './report/html.js';
import { formatAiReport, formatSummary } from './format.js';
import { hostOf, normalizeUrl } from './util/url.js';
import type { CrawlOptions, CrawlResult, Severity } from './types.js';

const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Expected a non-negative integer.');
  return n;
};
const collect = (v: string, prev: string[] = []) => [...prev, v];
const err = (m: string) => process.stderr.write(m + '\n');

function fail(msg: string, code = 2): never {
  err(`crawlscope: ${msg}`);
  process.exit(code);
}

function toUrl(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const n = normalizeUrl(withScheme);
  if (!n) fail(`"${input}" is not a valid URL`);
  return n;
}

function latestDirFor(base: string, host: string): string | null {
  if (!existsSync(base)) return null;
  const prefix = host.replace(/[^a-z0-9.-]/gi, '_') + '-';
  const dirs = readdirSync(base).filter((d) => d.startsWith(prefix) && statSync(join(base, d)).isDirectory()).sort();
  return dirs.length ? join(base, dirs[dirs.length - 1]) : null;
}

function makeProgress(enabled: boolean) {
  if (!enabled) return undefined;
  return (p: { crawled: number; queued: number; url: string; status: number }) => {
    const line = `  crawled ${p.crawled}  queued ${p.queued}  ${p.url}`;
    process.stderr.write('\r\u001b[K' + line.slice(0, Math.max(20, (process.stderr.columns ?? 100) - 2)));
  };
}

const SEV_RANK: Record<Severity, number> = { error: 3, warning: 2, notice: 1 };

const program = new Command();
program.name('crawlscope').description('Free, local SEO crawler with GEO/AEO (AI-readiness) checks and an agent-friendly JSON interface.').version(VERSION);

program
  .command('crawl')
  .description('Crawl a site and write crawl.json, CSV exports and a console summary')
  .argument('<url>', 'start URL')
  .option('-o, --out <dir>', 'output directory (default ./crawlscope-data/<host>-<timestamp>)')
  .option('--max-pages <n>', 'stop after N pages (default unlimited)', int)
  .option('--max-depth <n>', 'maximum link depth from the start URL', int)
  .option('--concurrency <n>', 'parallel requests', int, 4)
  .option('--delay <ms>', 'minimum delay between requests to the same host', int, 250)
  .option('--include <regex>', 'only crawl URLs matching this regex (repeatable)', collect)
  .option('--exclude <regex>', 'skip URLs matching this regex (repeatable)', collect)
  .option('--user-agent <string>', 'User-Agent header (robots.txt matching uses its product token)')
  .option('--no-robots', 'ignore robots.txt (requires --i-own-this-site)')
  .option('--i-own-this-site', 'confirm you own/are authorised to crawl the site (needed for --no-robots)')
  .option('--respect-nofollow', 'do not follow rel=nofollow links or pages with nofollow')
  .option('--subdomains', 'also crawl subdomains of the start host')
  .option('--external-check', 'HEAD-check outbound links (never crawls them)')
  .option('--max-urls-per-pattern <n>', 'stop following URLs of one path pattern after N (calendar/filter trap guard; 0 = unlimited)', int, 1000)
  .option('--timeout <ms>', 'per-request timeout', int, 15000)
  .option('--sitemap <url>', 'additional sitemap URL (repeatable)', collect)
  .option('--slow-ms <ms>', 'slow-response threshold (warning)', int)
  .option('--very-slow-ms <ms>', 'very-slow threshold (error)', int)
  .option('--json', 'print a machine-readable JSON summary to stdout (logs go to stderr)')
  .option('--format <list>', 'outputs: html,json,csv', 'html,json,csv')
  .option('--resume', 'resume an interrupted crawl or re-crawl incrementally using stored ETag/Last-Modified')
  .option('--ai-bots-check', 'also verify that URLs listed in llms.txt resolve')
  .option('--fail-on <level>', 'exit with code 1 if issues of this severity or worse exist (error|warning)')
  .action(async (urlArg: string, o) => {
    if (o.robots === false && !o.iOwnThisSite) fail('--no-robots requires --i-own-this-site (only ignore robots.txt on sites you own or have permission to crawl).');
    if (o.failOn && !['error', 'warning'].includes(o.failOn)) fail('--fail-on must be "error" or "warning"');
    const url = toUrl(urlArg);
    const formats = String(o.format).split(',').map((s) => s.trim()).filter(Boolean) as OutputFormat[];
    for (const f of formats) if (!['html', 'json', 'csv'].includes(f)) fail(`unknown format "${f}"`);
    const base = resolve('crawlscope-data');
    let outDir: string = o.out ? resolve(o.out) : '';
    if (!outDir && o.resume) outDir = latestDirFor(base, hostOf(url)) ?? '';
    if (!outDir) outDir = join(base, `${hostOf(url).replace(/[^a-z0-9.-]/gi, '_')}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`);
    const opts: CrawlOptions = resolveOptions({
      url, maxPages: o.maxPages ?? null, maxDepth: o.maxDepth ?? null, concurrency: Math.max(1, o.concurrency), delayMs: o.delay,
      include: o.include ?? [], exclude: o.exclude ?? [], respectRobots: o.robots !== false, respectNofollow: !!o.respectNofollow,
      maxUrlsPerPattern: o.maxUrlsPerPattern, subdomains: !!o.subdomains, externalCheck: !!o.externalCheck, timeoutMs: o.timeout, sitemapUrls: o.sitemap ?? [],
      aiBotsCheck: !!o.aiBotsCheck, resume: !!o.resume, outDir,
      ...(o.userAgent ? { userAgent: o.userAgent } : {}),
      thresholds: { ...(o.slowMs !== undefined ? { slowMs: o.slowMs } : {}), ...(o.verySlowMs !== undefined ? { verySlowMs: o.verySlowMs } : {}) } as CrawlOptions['thresholds'],
    });
    for (const p of [...opts.include, ...opts.exclude]) {
      try { new RegExp(p); } catch { fail(`invalid regular expression: ${p}`); }
    }
    if (!opts.respectRobots) err('warning: robots.txt is being ignored. Be sure you are allowed to crawl this site.');

    const ac = new AbortController();
    let interrupted = false;
    process.on('SIGINT', () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      err('\nInterrupted: finishing in-flight requests and saving partial results (press Ctrl+C again to quit)…');
      ac.abort();
    });
    const showProgress = !o.json && !!process.stderr.isTTY;
    let result: CrawlResult;
    try {
      result = await crawl(opts, { signal: ac.signal, onProgress: makeProgress(showProgress), onLog: (m) => err(m) });
    } catch (e) {
      fail((e as Error).message);
    }
    if (showProgress) process.stderr.write('\r\u001b[K');
    const files = writeCrawlDir(outDir, result, formats);
    if (o.json) {
      const s = result.summary;
      process.stdout.write(JSON.stringify({
        id: result.id, seed: result.seed, status: result.status, truncated: result.truncated, outDir, files, durationMs: result.durationMs,
        summary: { pagesCrawled: s.pagesCrawled, healthScore: s.healthScore, aiReadinessScore: s.aiReadinessScore, issuesTotal: s.issuesTotal, bySeverity: s.bySeverity, statusCodes: s.statusCodes },
        topIssues: s.byCheck.slice(0, 10),
      }, null, 2) + '\n');
    } else {
      process.stdout.write(formatSummary(result, outDir));
    }
    if (o.failOn) {
      const min = SEV_RANK[o.failOn as Severity];
      const bad = result.issues.filter((i) => SEV_RANK[i.severity] >= min).length;
      if (bad > 0) {
        err(`crawlscope: ${bad} issue(s) at or above "${o.failOn}" severity (--fail-on)`);
        process.exit(1);
      }
    }
    if (interrupted) process.exit(130);
  });

const aiAction = async (urlArg: string, o: { json?: boolean; maxPages: number; out?: string; deep?: boolean }) => {
  const url = toUrl(urlArg);
  const opts = resolveOptions({ url, maxPages: o.maxPages, maxDepth: 2, aiBotsCheck: o.deep !== false, outDir: o.out ? resolve(o.out) : null });
  const result = await crawl(opts, { onLog: (m) => err(m) });
  if (o.out) writeCrawlDir(resolve(o.out), result, ['json']);
  const ai = result.aiReadiness!;
  if (o.json) {
    const aiIssues = result.issues.filter((i) => i.category === 'ai-readiness');
    process.stdout.write(JSON.stringify({ site: result.seed, pagesSampled: result.pages.length, aiReadiness: ai, issues: aiIssues }, null, 2) + '\n');
  } else {
    process.stdout.write(formatAiReport(ai, result.seed) + `  (sampled ${result.summary.pagesCrawled} page(s); run \`crawlscope crawl\` for the whole site)\n\n`);
  }
};
for (const name of ['llms', 'ai-readiness']) {
  program
    .command(name)
    .description('Quick GEO/AEO check: llms.txt, AI-bot rules in robots.txt, structured data and page signals')
    .argument('<url>', 'site URL')
    .option('--json', 'machine-readable output')
    .option('--max-pages <n>', 'pages to sample', int, 10)
    .option('-o, --out <dir>', 'also write crawl.json here')
    .option('--no-deep', 'skip resolving links listed in llms.txt')
    .action(aiAction);
}

program
  .command('report')
  .description('Regenerate report.html and CSV exports from a crawl directory')
  .argument('<crawl-dir>', 'directory containing crawl.json')
  .option('--open', 'open report.html in the default browser')
  .option('--format <list>', 'outputs: html,csv', 'html,csv')
  .action(async (dirArg: string, o) => {
    const dir = resolve(dirArg);
    let result: CrawlResult;
    try { result = readCrawl(dir); } catch (e) { fail(`cannot read ${join(dir, 'crawl.json')}: ${(e as Error).message}`); }
    const formats = String(o.format).split(',').map((x) => x.trim()).filter(Boolean) as OutputFormat[];
    const files = writeCrawlDir(dir, result, formats.filter((f) => f !== 'json'));
    for (const f of files) process.stdout.write(f + '\n');
    if (o.open) openPath(join(dir, 'report.html'));
  });

program
  .command('diff')
  .description('Compare two crawls: new/removed pages, changed fields, issues added/resolved/persisting')
  .argument('<crawlA>', 'baseline crawl directory (or crawl.json)')
  .argument('<crawlB>', 'newer crawl directory (or crawl.json)')
  .option('--json', 'print the diff as JSON')
  .option('--html <file>', 'write a standalone HTML diff report')
  .action((a: string, b: string, o) => {
    const dir = (p: string) => (p.endsWith('.json') ? resolve(p, '..') : resolve(p));
    let d;
    try { d = diffDirs(dir(a), dir(b)); } catch (e) { fail((e as Error).message); }
    if (o.html) { writeFileSync(resolve(o.html), renderDiffHtml(d)); err(`wrote ${resolve(o.html)}`); }
    process.stdout.write(o.json ? JSON.stringify(d, null, 2) + '\n' : formatDiff(d));
  });

program
  .command('ui')
  .description('Local web UI (127.0.0.1 only): start crawls, watch progress, browse and compare results')
  .argument('[dir]', 'workspace directory holding crawls (default ./crawlscope-data)')
  .option('--port <n>', 'port to listen on', int, 4173)
  .option('--no-open', 'do not open the browser')
  .action(async (dirArg: string | undefined, o) => {
    const { startUiServer } = await import('./ui/server.js');
    const dir = resolve(dirArg ?? 'crawlscope-data');
    let srv;
    try { srv = await startUiServer({ dataDir: dir, port: o.port }); } catch (e) { fail(`cannot start UI: ${(e as Error).message}`); }
    const url = `http://127.0.0.1:${srv.port}/`;
    process.stdout.write(`crawlscope UI running at ${url}\nWorkspace: ${dir}\nPress Ctrl+C to stop.\n`);
    if (o.open !== false) openPath(url);
    process.on('SIGINT', () => { void srv.close().then(() => process.exit(0)); });
  });

program
  .command('mcp')
  .description('MCP server over stdio (coming in milestone 3)')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .helpOption(false)
  .action(() => {
    process.stderr.write('crawlscope mcp: coming in a later milestone\n');
    process.exit(0);
  });

function openPath(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => err(`could not open a browser; open ${target} manually`)).unref(); } catch { /* ignore */ }
}

program.parseAsync(process.argv).catch((e) => fail((e as Error).message));
