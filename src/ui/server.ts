import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { readCrawl, pagesCsv, issuesCsv, linksCsv } from '../output.js';
import { renderReportHtml, renderDiffHtml } from '../report/html.js';
import { buildReportData, safeJson } from '../report/data.js';
import { diffCrawls } from '../diff.js';
import { webAsset } from '../web-assets.js';
import { VERSION } from '../fetcher.js';
import { JobError, JobManager } from './jobs.js';
import type { CrawlResult } from '../types.js';

export interface UiServerOptions {
  dataDir: string;
  /** 0 = ephemeral */
  port?: number;
  /** override the token (tests) */
  token?: string;
}
export interface UiServer {
  port: number;
  token: string;
  dataDir: string;
  jobs: JobManager;
  close(): Promise<void>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const ASSETS: Record<string, [string, string]> = {
  'theme.css': ['theme.css', 'text/css; charset=utf-8'], 'ui.css': ['ui.css', 'text/css; charset=utf-8'], 'common.js': ['common.js', 'text/javascript; charset=utf-8'],
  'viewer.js': ['viewer.js', 'text/javascript; charset=utf-8'], 'diff-viewer.js': ['diff-viewer.js', 'text/javascript; charset=utf-8'], 'ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
};
const EXPORTS: Record<string, string> = { 'report.html': 'text/html; charset=utf-8', 'crawl.json': 'application/json', 'pages.csv': 'text/csv; charset=utf-8', 'issues.csv': 'text/csv; charset=utf-8', 'links.csv': 'text/csv; charset=utf-8' };

interface CrawlInfo {
  name: string; id: string; seed: string; startedAt: string; durationMs: number; status: string; truncated: boolean;
  pages: number; healthScore: number; aiReadinessScore: number | null; issues: number; bySeverity: CrawlResult['summary']['bySeverity']; sizeBytes: number;
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const dataDir = resolve(opts.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const token = opts.token ?? randomBytes(24).toString('hex');
  const jobs = new JobManager(dataDir);
  let port = 0;

  // ---- crawl cache (keyed by mtime) ----
  const infoCache = new Map<string, { mtime: number; info: CrawlInfo }>();
  const dataCache = new Map<string, { mtime: number; result: CrawlResult }>();
  const crawlDir = (name: string) => (NAME_RE.test(name) ? join(dataDir, name) : null);
  function loadResult(name: string): CrawlResult | null {
    const dir = crawlDir(name);
    if (!dir || !existsSync(join(dir, 'crawl.json'))) return null;
    const mtime = statSync(join(dir, 'crawl.json')).mtimeMs;
    const hit = dataCache.get(name);
    if (hit && hit.mtime === mtime) return hit.result;
    const result = readCrawl(dir);
    dataCache.set(name, { mtime, result });
    while (dataCache.size > 3) dataCache.delete(dataCache.keys().next().value!);
    return result;
  }
  function listCrawls(): CrawlInfo[] {
    const out: CrawlInfo[] = [];
    for (const name of readdirSync(dataDir)) {
      const f = join(dataDir, name, 'crawl.json');
      if (!NAME_RE.test(name) || !existsSync(f)) continue;
      const st = statSync(f);
      let c = infoCache.get(name);
      if (!c || c.mtime !== st.mtimeMs) {
        try {
          const r = loadResult(name)!;
          c = { mtime: st.mtimeMs, info: { name, id: r.id, seed: r.seed, startedAt: r.startedAt, durationMs: r.durationMs, status: r.status, truncated: r.truncated, pages: r.summary.pagesCrawled, healthScore: r.summary.healthScore, aiReadinessScore: r.summary.aiReadinessScore, issues: r.summary.issuesTotal, bySeverity: r.summary.bySeverity, sizeBytes: st.size } };
          infoCache.set(name, c);
        } catch { continue; }
      }
      out.push(c.info);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // ---- SSE ----
  const sseClients = new Set<http.ServerResponse>();
  const sseSend = (event: string, data: unknown, only?: http.ServerResponse) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of only ? [only] : sseClients) c.write(msg);
  };
  jobs.on('state', (s) => sseSend('state', s));
  jobs.on('recent', (r) => sseSend('recent', r));
  jobs.on('log', (m) => sseSend('log', m));
  const heartbeat = setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 15000);
  heartbeat.unref();

  // ---- helpers ----
  const baseHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'x-frame-options': 'DENY' };
  const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
  const REPORT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'self'";
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...baseHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const text = (res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders, 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  const hostOk = (host: string | undefined) => {
    if (!host) return false;
    const m = /^(127\.0\.0\.1|localhost):(\d+)$/i.exec(host);
    return !!m && Number(m[2]) === port;
  };
  const tokenOk = (given: string | string[] | undefined) => {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new JobError('Content-Type must be application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const ch of req) {
      size += (ch as Buffer).length;
      if (size > 64 * 1024) throw new JobError('Request body too large');
      chunks.push(ch as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch { throw new JobError('Body must be a JSON object'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding defence: only answer to our own loopback host name
      if (!hostOk(req.headers.host)) return text(res, 403, 'Forbidden: unexpected Host header\n', 'text/plain');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (req.headers['sec-fetch-site'] === 'cross-site') return text(res, 403, 'Forbidden: cross-site request\n', 'text/plain');
      const mutating = method !== 'GET' && method !== 'HEAD';
      if (mutating) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: 'Forbidden: bad Origin' });
        if (!tokenOk(req.headers['x-crawlscope-token'])) return json(res, 403, { error: 'Missing or invalid session token' });
      }

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="cs-token" content="${token}"><title>crawlscope</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%230d7c76'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='white' stroke-width='2.4'/%3E%3C/svg%3E"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/ui.css"></head><body><div id="app"></div><script src="/assets/common.js"></script><script src="/assets/diff-viewer.js"></script><script src="/assets/viewer.js"></script><script src="/assets/ui.js"></script></body></html>`;
        return text(res, 200, page, 'text/html; charset=utf-8', { 'content-security-policy': UI_CSP });
      }
      const asset = /^\/assets\/([\w.-]+)$/.exec(path);
      if (method === 'GET' && asset) {
        const a = ASSETS[asset[1]];
        if (!a) return text(res, 404, 'Not found\n', 'text/plain');
        return text(res, 200, webAsset(a[0]), a[1]);
      }

      if (path === '/api/info' && method === 'GET') return json(res, 200, { version: VERSION, dataDir, running: jobs.running });
      if (path === '/api/crawls' && method === 'GET') return json(res, 200, { crawls: listCrawls(), job: jobs.current });
      if (path === '/api/crawls' && method === 'POST') {
        const body = await readBody(req);
        const job = jobs.start(body);
        return json(res, 202, { job });
      }
      if (path === '/api/job' && method === 'GET') return json(res, 200, { job: jobs.current });
      if (path === '/api/job/stop' && method === 'POST') return json(res, jobs.stop() ? 202 : 409, { job: jobs.current, stopped: jobs.running });
      if (path === '/api/events' && method === 'GET') {
        res.writeHead(200, { ...baseHeaders, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 2000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        sseSend('state', jobs.current, res);
        return;
      }

      const one = /^\/api\/crawls\/([^/]+)$/.exec(path);
      if (one && method === 'GET') {
        const r = loadResult(decodeURIComponent(one[1]));
        if (!r) return json(res, 404, { error: 'Crawl not found' });
        const body = safeJson(buildReportData(r));
        res.writeHead(200, { ...baseHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        return void res.end(body);
      }
      const exp = /^\/api\/crawls\/([^/]+)\/export\/([\w.-]+)$/.exec(path);
      if (exp && method === 'GET') {
        const name = decodeURIComponent(exp[1]), file = exp[2];
        const type = EXPORTS[file];
        const dir = crawlDir(name);
        if (!type || !dir) return json(res, 404, { error: 'Unknown export' });
        const disposition = url.searchParams.get('inline') === '1' && file === 'report.html' ? 'inline' : `attachment; filename="${name}-${file}"`;
        const extra: Record<string, string> = { 'content-disposition': disposition };
        if (file === 'report.html') extra['content-security-policy'] = REPORT_CSP;
        const fp = join(dir, file);
        if (existsSync(fp) && file !== 'report.html') {
          res.writeHead(200, { ...baseHeaders, 'content-type': type, 'cache-control': 'no-store', ...extra });
          return void createReadStream(fp).pipe(res);
        }
        const r = loadResult(name);
        if (!r) return json(res, 404, { error: 'Crawl not found' });
        const body = file === 'report.html' ? renderReportHtml(r) : file === 'pages.csv' ? pagesCsv(r.pages) : file === 'issues.csv' ? issuesCsv(r) : file === 'links.csv' ? linksCsv(r.links) : JSON.stringify(r);
        return text(res, 200, body, type, extra);
      }
      if ((path === '/api/diff' || path === '/api/diff/html') && method === 'GET') {
        const a = loadResult(url.searchParams.get('a') ?? ''), b = loadResult(url.searchParams.get('b') ?? '');
        if (!a || !b) return json(res, 404, { error: 'Both crawls must exist' });
        const d = diffCrawls(a, b);
        if (path === '/api/diff') return json(res, 200, d);
        return text(res, 200, renderDiffHtml(d), 'text/html; charset=utf-8', { 'content-security-policy': REPORT_CSP, 'content-disposition': 'inline' });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof JobError) return json(res, 400, { error: e.message });
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4173, '127.0.0.1', () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;

  return {
    port, token, dataDir, jobs,
    close: async () => {
      jobs.stop();
      clearInterval(heartbeat);
      for (const c of sseClients) c.end();
      sseClients.clear();
      await Promise.race([jobs.idle(), new Promise((r) => setTimeout(r, 5000))]);
      await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    },
  };
}
