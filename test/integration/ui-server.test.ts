import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiServer, type UiServer } from '../../src/ui/server.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let ui: UiServer, fx: FixtureServer, fxB: FixtureServer, tmp: string, base: string;
const H = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-crawlscope-token': ui.token, ...extra });
const post = (path: string, body: unknown, headers = H()) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

/** raw request so we can set an arbitrary Host header (fetch forbids it) */
function rawGet(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ui.port, path, headers: { host } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function crawlVia(url: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/crawls', { url, concurrency: 4, delayMs: 0, ...extra });
  expect(r.status).toBe(202);
  const { job } = await r.json();
  await ui.jobs.idle();
  return job.name as string;
}

beforeAll(async () => {
  fx = await startFixtureServer();
  fxB = await startFixtureServer({ variant: 'b' });
  tmp = mkdtempSync(join(tmpdir(), 'crawlscope-ui-'));
  ui = await startUiServer({ dataDir: tmp, port: 0 });
  base = `http://127.0.0.1:${ui.port}`;
}, 30000);
afterAll(async () => { await ui.close(); await fx.close(); await fxB.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('security', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.example.com', `evil.example.com:${ui.port}`, `127.0.0.1.evil.com:${ui.port}`, '127.0.0.1:1', 'localhost']) {
      const r = await rawGet('/api/crawls', host);
      expect(r.status, host).toBe(403);
    }
    expect((await rawGet('/api/crawls', `localhost:${ui.port}`)).status).toBe(200);
    expect((await rawGet('/', `127.0.0.1:${ui.port}`)).status).toBe(200);
  });
  it('requires the session token for state-changing endpoints', async () => {
    const noTok = await fetch(base + '/api/crawls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: fx.origin }) });
    expect(noTok.status).toBe(403);
    const bad = await post('/api/crawls', { url: fx.origin }, H({ 'x-crawlscope-token': 'nope' }));
    expect(bad.status).toBe(403);
    expect((await fetch(base + '/api/job/stop', { method: 'POST' })).status).toBe(403);
    expect(ui.jobs.current).toBeNull();
  });
  it('rejects cross-origin browsers even with a token', async () => {
    const r = await post('/api/crawls', { url: fx.origin }, H({ origin: 'https://evil.example.com' }));
    expect(r.status).toBe(403);
    const cs = await fetch(base + '/api/crawls', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cs.status).toBe(403);
  });
  it('serves the app shell with the token, CSP and no third-party refs', async () => {
    const r = await fetch(base + '/');
    const html = await r.text();
    expect(html).toContain(ui.token);
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    for (const f of ['theme.css', 'ui.css', 'common.js', 'viewer.js', 'diff-viewer.js', 'ui.js']) expect((await fetch(`${base}/assets/${f}`)).status, f).toBe(200);
    expect((await fetch(`${base}/assets/..%2fserver.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets/secret.js`)).status).toBe(404);
  });
  it('validates start requests and path parameters', async () => {
    expect((await post('/api/crawls', { url: '' })).status).toBe(400);
    expect((await post('/api/crawls', { url: fx.origin, include: ['('] })).status).toBe(400);
    expect((await post('/api/crawls', { url: fx.origin, respectRobots: false })).status).toBe(400);
    expect((await post('/api/crawls', { url: fx.origin, concurrency: 9999 })).status).toBe(400);
    expect((await fetch(`${base}/api/crawls/..%2f..%2fetc`)).status).toBe(404);
    expect((await fetch(`${base}/api/crawls/nope/export/report.html`)).status).toBe(404);
    const notJson = await fetch(base + '/api/crawls', { method: 'POST', headers: { 'x-crawlscope-token': ui.token, 'content-type': 'text/plain' }, body: '{}' });
    expect(notJson.status).toBe(400);
  });
});

describe('crawl lifecycle with SSE progress', () => {
  let nameA = '';
  it('streams state events for a fixture crawl and writes the crawl dir', async () => {
    const events: { event: string; data: any }[] = [];
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/events', { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();

    const r = await post('/api/crawls', { url: fx.origin, maxPages: 25, delayMs: 0, concurrency: 3 });
    expect(r.status).toBe(202);
    const { job } = await r.json();
    nameA = job.name;
    // a second crawl while one runs is refused
    expect((await post('/api/crawls', { url: fx.origin })).status).toBe(400);
    await ui.jobs.idle();
    await new Promise((r2) => setTimeout(r2, 300));
    ctrl.abort(); await pump;

    const states = events.filter((e) => e.event === 'state' && e.data).map((e) => e.data);
    expect(states.length).toBeGreaterThan(2);
    expect(states.some((s) => s.status === 'running' && s.crawled > 0)).toBe(true);
    expect(states.some((s) => s.phase === 'crawling')).toBe(true);
    const last = states[states.length - 1];
    expect(last.status).toBe('done');
    expect(last.result).toBe(nameA);
    expect(last.crawled).toBeGreaterThan(5);
    expect(events.some((e) => e.event === 'recent' && e.data.length > 0 && typeof e.data[0].url === 'string')).toBe(true);
    for (const f of ['crawl.json', 'report.html', 'pages.csv']) expect(existsSync(join(tmp, nameA, f)), f).toBe(true);
  }, 30000);

  it('lists crawls and serves compact data and exports', async () => {
    const list = await (await fetch(base + '/api/crawls')).json();
    expect(list.crawls.map((c: any) => c.name)).toContain(nameA);
    expect(list.crawls[0].healthScore).toBeGreaterThanOrEqual(0);
    const data = await (await fetch(`${base}/api/crawls/${nameA}`)).json();
    expect(data.v).toBe(1);
    expect(data.pages.n).toBeGreaterThan(5);
    const rep = await fetch(`${base}/api/crawls/${nameA}/export/report.html?inline=1`);
    expect(rep.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(rep.headers.get('content-disposition')).toBe('inline');
    expect(await rep.text()).toContain('cs-data');
    const csv = await fetch(`${base}/api/crawls/${nameA}/export/issues.csv`);
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    expect((await csv.text()).startsWith('severity,check_id')).toBe(true);
    expect((await fetch(`${base}/api/crawls/${nameA}/export/evil.sh`)).status).toBe(404);
  });

  it('stops a running crawl and keeps a partial result', async () => {
    const slow = await startFixtureServer({ latency: 150 });
    try {
      const r = await post('/api/crawls', { url: slow.origin, concurrency: 1, delayMs: 0 });
      expect(r.status).toBe(202);
      await new Promise((r2) => setTimeout(r2, 700));
      const st = await post('/api/job/stop', {});
      expect(st.status).toBe(202);
      await ui.jobs.idle();
      expect(ui.jobs.current?.status).toBe('stopped');
      const again = await post('/api/job/stop', {});
      expect(again.status).toBe(409);
    } finally { await slow.close(); }
  }, 30000);

  it('diffs two crawls through the API', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp-based dir names
    const nameB = await crawlVia(fxB.origin, { maxPages: 80 });
    const d = await (await fetch(`${base}/api/diff?a=${nameA}&b=${nameB}`)).json();
    expect(d.schemaVersion).toBe(1);
    expect(d.pages.added.length + d.pages.removed.length).toBeGreaterThanOrEqual(0);
    const html = await fetch(`${base}/api/diff/html?a=${nameA}&b=${nameB}`);
    expect(await html.text()).toContain('cs-data');
    expect((await fetch(`${base}/api/diff?a=${nameA}&b=missing`)).status).toBe(404);
  }, 30000);
});
