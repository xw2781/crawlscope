import type { CheckDef, Finding, PageRecord } from '../types.js';
import { def } from './helpers.js';

/** Response headers that commonly reveal server-side software, in report order (lowercase names, display names). */
export const DISCLOSURE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['server', 'Server'],
  ['x-powered-by', 'X-Powered-By'],
  ['x-aspnet-version', 'X-AspNet-Version'],
  ['x-aspnetmvc-version', 'X-AspNetMvc-Version'],
];

/** Headers whose whole value is a version number (e.g. "4.0.30319"). */
const BARE_VERSION_HEADERS = new Set(['x-aspnet-version', 'x-aspnetmvc-version']);

// "nginx/1.25.3", "Apache/2.4.57 (Ubuntu)", "PHP/8.1.2", "Microsoft-IIS/10.0", "openresty/1.21.4.1"
const SLASH_VERSION = /(?:^|[\s(,;])([A-Za-z][\w.+-]*)\/v?(\d+\.\d+[\w.+-]*)/g;
// "Phusion Passenger 6.0.4", "Servlet 3.1" (product followed by a dotted version)
const SPACE_VERSION = /(?:^|[\s(,;])([A-Za-z][\w+-]*) v?(\d+\.\d+[\w.+-]*)/g;
const BARE_VERSION = /^\s*v?(\d+(?:\.\d+)*)\b/;

/**
 * Returns the "product/version" tokens in a header value that expose a specific version,
 * or an empty list when the header only names the software ("nginx", "cloudflare", "Express").
 */
export function versionTokens(header: string, value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  if (BARE_VERSION_HEADERS.has(header)) {
    const m = BARE_VERSION.exec(v);
    return m ? [m[1]] : [];
  }
  const out: string[] = [];
  for (const re of [SLASH_VERSION, SPACE_VERSION]) {
    for (const m of v.matchAll(re)) {
      if (/^https?$/i.test(m[1])) continue; // protocol versions, not software
      const sep = re === SLASH_VERSION ? '/' : ' ';
      const tok = `${m[1]}${sep}${m[2]}`;
      if (!out.includes(tok)) out.push(tok);
    }
  }
  return out;
}

function hostOf(p: PageRecord): string | null {
  try { return new URL(p.finalUrl || p.url).host.toLowerCase(); } catch { return null; }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const disclosureChecks: CheckDef[] = [
  def(
    { id: 'server-version-disclosure', severity: 'warning', category: 'security', title: 'Server software version disclosed in response headers',
      description: 'A response header (Server, X-Powered-By, X-AspNet-Version or X-AspNetMvc-Version) reveals the exact version of the web server, language runtime or framework, for example "nginx/1.25.3" or "PHP/8.1.2". This lets attackers match your stack against known CVEs (such as recent nginx HTTP/2 issues) without any probing. crawlscope does not check whether the version is actually vulnerable; it only reports that the version is visible. Passive: uses headers from pages already crawled. One finding per host.',
      howToFix: 'Hide version numbers in response headers. nginx: server_tokens off; Apache: ServerTokens Prod and ServerSignature Off; PHP: expose_php = Off in php.ini; IIS/ASP.NET: <httpRuntime enableVersionHeader="false" />, MvcHandler.DisableMvcResponseHeader = true, and remove X-Powered-By under <customHeaders>; Express: app.disable("x-powered-by"). Hiding the version is defence in depth, not a fix: keep the software patched.' },
    (ctx) => {
      const byHost = new Map<string, { first: string; pages: Set<string>; headers: Map<string, Set<string>>; tokens: Set<string> }>();
      for (const p of ctx.pages) {
        if (p.fetchError || !p.status) continue;
        const host = hostOf(p);
        if (!host) continue;
        for (const [name] of DISCLOSURE_HEADERS) {
          const value = p.headers?.[name];
          if (!value) continue;
          const toks = versionTokens(name, value);
          if (!toks.length) continue;
          let e = byHost.get(host);
          if (!e) byHost.set(host, (e = { first: p.url, pages: new Set(), headers: new Map(), tokens: new Set() }));
          e.pages.add(p.url);
          let vals = e.headers.get(name);
          if (!vals) e.headers.set(name, (vals = new Set()));
          if (vals.size < 5) vals.add(value.trim().slice(0, 200));
          for (const t of toks) e.tokens.add(t);
        }
      }
      const out: Finding[] = [];
      for (const [host, e] of byHost) {
        const shown = DISCLOSURE_HEADERS.filter(([n]) => e.headers.has(n)).map(([n, display]) => `${display}: ${[...e.headers.get(n)!].join(' | ')}`);
        out.push({
          url: e.first,
          message: `${host} discloses software versions (${[...e.tokens].slice(0, 6).join(', ')}) in response headers on ${plural(e.pages.size, 'page')} — ${shown.join('; ')}. ` +
            'Version details help attackers target known CVEs; hide them (e.g. nginx server_tokens off).',
          details: {
            host,
            headers: Object.fromEntries([...e.headers].map(([n, v]) => [n, [...v]])),
            versions: [...e.tokens],
            pages: e.pages.size,
            examplePages: [...e.pages].slice(0, 5),
          },
        });
      }
      return out.sort((a, b) => a.url.localeCompare(b.url));
    },
  ),
];
