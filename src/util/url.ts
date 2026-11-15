const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.tr', 'com.sg', 'com.hk', 'co.kr',
]);

function fixPercent(s: string): string {
  return s.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const ch = String.fromCharCode(parseInt(m.slice(1), 16));
    // decode unreserved characters, uppercase the rest
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m.toUpperCase();
  });
}

export interface NormalizeOptions {
  /** drop common tracking params (utm_*, gclid, fbclid ...) */
  stripTracking?: boolean;
}

/**
 * Normalise a URL for de-duplication: http(s) only, no fragment, lowercase host,
 * no default port, "/" for empty path, dot segments resolved, percent-encoding normalised.
 * Query order is preserved. Returns null for non-http(s) or unparsable input.
 */
export function normalizeUrl(input: string, base?: string, opts: NormalizeOptions = {}): string | null {
  let u: URL;
  try {
    u = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
  if (opts.stripTracking) {
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|mc_|pk_)/i.test(k) || ['gclid', 'fbclid', 'msclkid', 'yclid'].includes(k.toLowerCase())) {
        u.searchParams.delete(k);
      }
    }
  }
  let path = fixPercent(u.pathname);
  if (path === '') path = '/';
  let search = u.search === '?' ? '' : fixPercent(u.search);
  return `${u.protocol}//${u.host}${path}${search}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Approximate registrable domain (small multi-part suffix list; no full PSL). */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/:\d+$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const parts = h.split('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

function stripWww(h: string): string {
  return h.startsWith('www.') ? h.slice(4) : h;
}

/** Is `url` part of the same site as `seed`? www/non-www are treated as equal; subdomains optionally. */
export function isSameSite(url: string, seed: string, subdomains: boolean): boolean {
  let a: URL, b: URL;
  try {
    a = new URL(url);
    b = new URL(seed);
  } catch {
    return false;
  }
  const ha = a.hostname.toLowerCase();
  const hb = b.hostname.toLowerCase();
  if (stripWww(ha) === stripWww(hb)) return true;
  if (subdomains) return registrableDomain(ha) === registrableDomain(hb);
  return false;
}

/** Path + query as used for robots.txt matching. */
export function pathAndQuery(url: string): string {
  const u = new URL(url);
  return (u.pathname || '/') + u.search;
}

export function compileRegexList(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p));
}

export function resolveUrl(href: string, base: string): string | null {
  return normalizeUrl(href, base);
}
