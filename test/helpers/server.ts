import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

const WORDS = 'harbor lantern meadow quartz velvet copper orchid timber saffron glacier ember willow cobalt marble thistle compass anchor ribbon pepper sparrow ledger tundra mosaic fennel quiver prism basalt cinder nectar tapestry bramble kettle summit lagoon pigment thimble'.split(' ');
function words(seed: number, n: number): string {
  let x = seed * 2654435761 + 12345;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(WORDS[x % WORDS.length]);
  }
  return out.join(' ');
}
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'site');

export interface FixtureServer {
  /** http://127.0.0.1:PORT */
  origin: string;
  /** a different hostname (localhost) serving the same app: used as the "external" site */
  external: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; method: string }[];
  close(): Promise<void>;
}

export interface FixtureOptions {
  /** answer unknown URLs with 200 instead of 404 */
  soft404?: boolean;
  /** extra delay for every response (ms) */
  latency?: number;
  /** answer /robots.txt with this status and no rules */
  robotsStatus?: number;
  /** replace robots.txt content */
  robotsText?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.js': 'application/javascript',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

export async function startFixtureServer(opts: FixtureOptions = {}): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  let port = 0;
  const origin = () => `http://127.0.0.1:${port}`;
  const external = () => `http://localhost:${port}`;
  const fill = (s: string) => s.replaceAll('{{ORIGIN}}', origin()).replaceAll('{{EXTERNAL}}', external());

  const redirect = (res: http.ServerResponse, status: number, location: string) => {
    res.writeHead(status, { location, 'content-type': 'text/plain' });
    res.end(`Redirecting to ${location}`);
  };
  const send = (req: http.IncomingMessage, res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const etag = '"' + createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
    if (status === 200 && extra['x-etag'] !== 'off' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }
    delete extra['x-etag'];
    res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...(status === 200 ? { etag } : {}), ...extra });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', origin());
    const path = u.pathname;
    requests.push({ path: path + u.search, headers: req.headers, method: req.method ?? 'GET' });
    if (opts.latency) await new Promise((r) => setTimeout(r, opts.latency));

    if (path === '/robots.txt' && opts.robotsStatus) return send(req, res, opts.robotsStatus, 'text/plain', 'x');
    if (path === '/robots.txt' && opts.robotsText !== undefined) return send(req, res, 200, 'text/plain', opts.robotsText);
    if (path === '/redirect-start') return redirect(res, 301, '/redirect-mid');
    if (path === '/redirect-mid') return redirect(res, 302, '/redirect-end');
    if (path === '/old-page') return redirect(res, 301, '/about');
    if (path === '/loop-a') return redirect(res, 302, '/loop-b');
    if (path === '/loop-b') return redirect(res, 302, '/loop-a');
    if (path === '/to-external') return redirect(res, 301, external() + '/ext-ok');
    if (path === '/server-error') return send(req, res, 500, 'text/html', '<h1>Internal error</h1>');
    if (path === '/ext-ok') return send(req, res, 200, 'text/html', '<html><head><title>External</title></head><body>ok</body></html>');
    if (path === '/ext-missing') return send(req, res, 404, 'text/html', 'nope');
    if (path === '/flaky') {
      const n = requests.filter((r) => r.path === '/flaky').length;
      if (n === 1) {
        res.writeHead(429, { 'retry-after': '1' });
        return res.end();
      }
      return send(req, res, 200, 'text/html', '<html><head><title>Flaky page that recovered after a retry</title></head><body><h1>ok</h1></body></html>');
    }
    if (path === '/slow') await new Promise((r) => setTimeout(r, 500));
    if (path === '/big') {
      const filler = '<p>' + 'lorem ipsum dolor sit amet '.repeat(40) + '</p>\n';
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A Very Large HTML Document For Size Check Tests</title><meta name="description" content="This page is intentionally larger than one megabyte of HTML to trigger the large document check."><meta name="viewport" content="width=device-width"><link rel="canonical" href="${origin()}/big"><meta property="og:title" content="d"><meta property="og:description" content="d"><meta property="og:image" content="d"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"></head><body><main><h1>Big</h1>${filler.repeat(1100)}</main></body></html>`;
      return send(req, res, 200, TYPES['.html'], html);
    }
    const deep = /^\/deep\/(\d+)$/.exec(path);
    if (deep) {
      const n = Number(deep[1]);
      if (n <= 6) {
        const next = n < 6 ? `<a href="/deep/${n + 1}">Go deeper (${n + 1})</a>` : '<p>Bottom reached.</p>';
        return send(req, res, 200, TYPES['.html'], `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Depth ${n} Of A Deliberately Deep Link Chain Page</title><meta name="description" content="This page sits ${n} clicks from the home page and links to the next level of the deep chain of pages."><meta name="viewport" content="width=device-width"><link rel="canonical" href="${origin()}/deep/${n}"><meta property="og:title" content="d"><meta property="og:description" content="d"><meta property="og:image" content="d"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"></head><body><main><h1>Depth ${n}</h1><p>${words(n, 230)}.</p>${next}</main></body></html>`);
      }
    }

    if (path === '/sitemap-extra.xml.gz') {
      const src = fill(readFileSync(join(SITE, 'sitemap-extra.xml'), 'utf8'));
      return send(req, res, 200, 'application/gzip', gzipSync(src), { 'x-etag': 'off' });
    }

    // static file mapping
    let rel = path === '/' ? 'index.html' : path.slice(1);
    const candidates = [rel, rel + '.html'];
    for (const c of candidates) {
      if (c.includes('..')) break;
      const fp = join(SITE, c);
      if (existsSync(fp) && statSync(fp).isFile() && c !== 'sitemap-extra.xml') {
        const type = TYPES[extname(fp)] ?? 'application/octet-stream';
        const extra: Record<string, string> = {};
        if (c === 'Upper_Case.html' && u.search !== '?x=1') break;
        return send(req, res, 200, type, ['.js', '.svg', '.pdf'].includes(extname(fp)) ? readFileSync(fp) : fill(readFileSync(fp, 'utf8')), extra);
      }
    }
    if (opts.soft404) return send(req, res, 200, TYPES['.html'], '<html><head><title>Not found</title></head><body><h1>Sorry, nothing here</h1></body></html>');
    return send(req, res, 404, TYPES['.html'], '<html><head><title>Not Found</title></head><body><h1>404</h1></body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: origin(),
    external: external(),
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
