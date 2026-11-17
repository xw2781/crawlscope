import type { CheckDef, Finding } from '../types.js';
import { def, isOkHtml, perPage } from './helpers.js';
import { isDynamicSnippetHost, knownHost } from '../third-party.js';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const thirdPartyChecks: CheckDef[] = [
  def(
    { id: 'third-party-script-no-sri', severity: 'notice', category: 'security', title: 'Third-party script loaded without Subresource Integrity',
      description: 'A script from another site is loaded without an integrity attribute, so if that host is compromised (as happened to Optimizely Web snippets on cdn.optimizely.com in November 2026) the malicious code runs on your pages. One finding per host, listing how many pages load it.',
      howToFix: 'For versioned, static files (jQuery, libraries on a CDN) add integrity="sha384-…" and crossorigin="anonymous". SRI cannot be used for dynamic snippets such as Optimizely, Google Tag Manager or consent/analytics loaders, because their content changes without notice; for those, restrict script-src with a Content-Security-Policy, minimise who can publish to the tag, and review third-party scripts regularly.' },
    (ctx) => {
      const byHost = new Map<string, { pages: Set<string>; first: string; example: string }>();
      for (const p of ctx.pages) {
        if (!isOkHtml(p)) continue;
        for (const s of p.scripts ?? []) {
          if (!s.thirdParty || s.sri) continue;
          const e = byHost.get(s.host) ?? { pages: new Set<string>(), first: p.url, example: s.url };
          e.pages.add(p.url);
          byHost.set(s.host, e);
        }
      }
      const out: Finding[] = [];
      for (const [host, e] of byHost) {
        const dyn = isDynamicSnippetHost(host);
        const cat = knownHost(host)?.category;
        out.push({
          url: e.first,
          message: `${host}${cat ? ` (${cat})` : ''} script has no integrity attribute on ${plural(e.pages.size, 'page')}, e.g. ${e.example}` +
            (dyn ? ' — SRI cannot be used for dynamic snippets like this; rely on CSP and vendor access controls instead.' : '.'),
          details: { host, category: cat ?? null, pages: e.pages.size, dynamicSnippet: dyn, example: e.example, examplePages: [...e.pages].slice(0, 5) },
        });
      }
      return out.sort((a, b) => (b.details!.pages as number) - (a.details!.pages as number) || a.url.localeCompare(b.url));
    },
  ),
  def(
    { id: 'insecure-script', severity: 'error', category: 'security', title: 'HTTPS page loads a script over http://',
      description: 'A <script src> on an HTTPS page uses http://. Browsers block it, and any network attacker can swap its content.',
      howToFix: 'Load the script over https:// (or serve it from your own origin).' },
    (ctx) => perPage(ctx, (p) => p.url.startsWith('https:') && (p.scripts ?? []).some((s) => s.url.startsWith('http:')), (p) => {
      const bad = p.scripts!.filter((s) => s.url.startsWith('http:'));
      return { message: `${plural(bad.length, 'script')} loaded over http://, e.g. ${bad[0].url}`, details: { scripts: bad.slice(0, 10).map((s) => s.url) } };
    }),
  ),
  def(
    { id: 'csp-missing', severity: 'notice', category: 'security', title: 'No Content-Security-Policy',
      description: 'HTML pages are served without a Content-Security-Policy header or meta tag. A CSP limits which hosts may run scripts, which reduces the damage from a compromised third-party snippet. Reported once per site.',
      howToFix: 'Send a Content-Security-Policy header with at least script-src listing the hosts you trust. Start with Content-Security-Policy-Report-Only to see what would break.' },
    (ctx) => {
      const pages = ctx.pages.filter((p) => isOkHtml(p) && p.csp && !p.csp.enforced && !p.csp.reportOnly);
      if (!pages.length) return [];
      return [{ url: pages[0].url, message: `${plural(pages.length, 'HTML page')} without a Content-Security-Policy, e.g. ${pages[0].url}`, details: { pages: pages.length, examples: pages.slice(0, 5).map((p) => p.url) } }];
    },
  ),
  def(
    { id: 'csp-report-only', severity: 'notice', category: 'security', title: 'Content-Security-Policy is report-only',
      description: 'Pages send Content-Security-Policy-Report-Only but no enforcing policy, so violations are reported but nothing is blocked. Reported once per site.',
      howToFix: 'Once the reports are clean, switch the header to Content-Security-Policy to enforce it.' },
    (ctx) => {
      const pages = ctx.pages.filter((p) => isOkHtml(p) && p.csp && !p.csp.enforced && p.csp.reportOnly);
      if (!pages.length) return [];
      return [{ url: pages[0].url, message: `${plural(pages.length, 'HTML page')} with only a report-only Content-Security-Policy`, details: { pages: pages.length, examples: pages.slice(0, 5).map((p) => p.url) } }];
    },
  ),
];
