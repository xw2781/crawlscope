import type { FetchErrorInfo } from './types.js';

declare const __VERSION__: string;
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';
export const DEFAULT_UA = `crawlscope/${VERSION} (+https://github.com/xw2781/crawlscope)`;

export interface FetcherOptions {
  userAgent: string;
  delayMs: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxRetries: number;
  maxRetryWaitMs: number;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** decide whether to read the body based on response headers */
  readBody?: (status: number, headers: Record<string, string>) => boolean;
  maxBodyBytes?: number;
  /** extra minimum delay for this host (e.g. robots Crawl-delay), ms */
  hostDelayMs?: number;
  /** skip per-host throttling (never used for crawling) */
  noThrottle?: boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer | null;
  bytes: number;
  truncated: boolean;
  timeMs: number;
  error: FetchErrorInfo | null;
  attempts: number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function parseRetryAfter(value: string | undefined | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export function classifyError(err: unknown): FetchErrorInfo {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT') {
    return { code: 'TIMEOUT', message: 'Request timed out' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'DNS', message: `DNS lookup failed (${code})` };
  if (code === 'ECONNREFUSED') return { code: 'ECONNREFUSED', message: 'Connection refused' };
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return { code: 'ECONNRESET', message: 'Connection reset' };
  if (typeof code === 'string' && /CERT|TLS|SSL|ERR_SSL/.test(code)) return { code: 'TLS', message: `TLS error (${code})` };
  return { code: 'UNKNOWN', message: e?.cause?.message ?? e?.message ?? String(err) };
}

export class Fetcher {
  private nextSlot = new Map<string, number>();
  constructor(public opts: FetcherOptions) {}

  /** Reserve the next request slot for a host, returning ms to wait. Synchronous reservation keeps concurrent workers polite. */
  private reserve(host: string, delayMs: number): number {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + delayMs);
    return slot - now;
  }

  /** Push the host's next slot out (used for Retry-After). */
  delayHost(host: string, ms: number): void {
    const t = Date.now() + ms;
    if ((this.nextSlot.get(host) ?? 0) < t) this.nextSlot.set(host, t);
  }

  async request(url: string, ro: RequestOptions = {}): Promise<FetchResult> {
    const host = new URL(url).host;
    const delay = Math.max(this.opts.delayMs, ro.hostDelayMs ?? 0);
    let attempts = 0;
    let last!: FetchResult;
    const maxAttempts = this.opts.maxRetries + 1;
    while (attempts < maxAttempts) {
      attempts++;
      if (!ro.noThrottle) {
        const wait = this.reserve(host, delay);
        if (wait > 0) await sleep(wait);
      }
      last = await this.once(url, ro);
      last.attempts = attempts;
      const retryable = last.error ? ['TIMEOUT', 'ECONNRESET'].includes(last.error.code) : last.status === 429 || last.status === 503;
      if (!retryable || attempts >= maxAttempts) break;
      const ra = parseRetryAfter(last.headers['retry-after']);
      const backoff = Math.min(this.opts.maxRetryWaitMs, ra ?? 500 * 2 ** (attempts - 1));
      if (!ro.noThrottle) this.delayHost(host, backoff);
      else await sleep(backoff);
    }
    return last;
  }

  private async once(url: string, ro: RequestOptions): Promise<FetchResult> {
    const started = Date.now();
    const cap = ro.maxBodyBytes ?? this.opts.maxBodyBytes;
    const result: FetchResult = {
      url, status: 0, statusText: '', headers: {}, body: null, bytes: 0, truncated: false, timeMs: 0, error: null, attempts: 1,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), this.opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: ro.method ?? 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'user-agent': this.opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          ...ro.headers,
        },
      });
      result.status = res.status;
      result.statusText = res.statusText;
      res.headers.forEach((v, k) => (result.headers[k.toLowerCase()] = v));
      // time to first byte (headers received)
      result.timeMs = Date.now() - started;
      const wantBody = (ro.method ?? 'GET') !== 'HEAD' && (ro.readBody ? ro.readBody(res.status, result.headers) : true);
      if (wantBody && res.body) {
        const chunks: Buffer[] = [];
        let total = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cap) {
            const keep = value.byteLength - (total - cap);
            if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
            result.truncated = true;
            total = cap;
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(Buffer.from(value));
        }
        result.body = Buffer.concat(chunks);
        result.bytes = total;
      } else {
        await res.body?.cancel().catch(() => undefined);
        const cl = Number(result.headers['content-length']);
        result.bytes = Number.isFinite(cl) ? cl : 0;
      }
      result.timeMs = Date.now() - started;
    } catch (err) {
      result.error = classifyError(err);
      result.timeMs = Date.now() - started;
    } finally {
      clearTimeout(timer);
    }
    return result;
  }
}
