import type { CheckDef, Finding } from '../types.js';
import { def, isIndexableHtml } from './helpers.js';

export const siteChecks: CheckDef[] = [
  def(
    { id: 'robots-missing', severity: 'notice', category: 'site', title: 'No robots.txt',
      description: 'robots.txt was not found. Crawlers will assume everything may be crawled.',
      howToFix: 'Publish /robots.txt, at minimum with a Sitemap line (and rules for any paths you want kept out).' },
    (ctx) => (!ctx.robots.present && ctx.robots.mode === 'allow-all' ? [{ url: ctx.robots.url, message: `robots.txt returned HTTP ${ctx.robots.status}` }] : []),
  ),
  def(
    { id: 'robots-unreachable', severity: 'warning', category: 'site', title: 'robots.txt could not be fetched',
      description: 'robots.txt returned a server error or could not be loaded. Per RFC 9309 crawlers should then assume the whole site is disallowed.',
      howToFix: 'Fix the server error so /robots.txt reliably returns 200 (or 404 if you have none).' },
    (ctx) => (ctx.robots.mode === 'disallow-all' ? [{ url: ctx.robots.url, message: ctx.robots.fetchError ?? `robots.txt returned HTTP ${ctx.robots.status}` }] : []),
  ),
  def(
    { id: 'robots-syntax', severity: 'warning', category: 'site', title: 'robots.txt syntax problems',
      description: 'Lines in robots.txt are malformed, unknown, or misplaced and will be ignored by crawlers.',
      howToFix: 'Fix the listed lines: each rule needs a path starting with "/" or "*" and must follow a User-agent line.' },
    (ctx) => {
      const w = ctx.robots.parsed?.warnings ?? [];
      return w.length ? [{ url: ctx.robots.url, message: `${w.length} syntax warning(s); first: line ${w[0].line}: ${w[0].message}`, details: { warnings: w.slice(0, 20) } }] : [];
    },
  ),
  def(
    { id: 'sitemap-missing', severity: 'warning', category: 'site', title: 'No sitemap found',
      description: 'No valid XML sitemap was found via robots.txt or /sitemap.xml.',
      howToFix: 'Generate an XML sitemap of canonical, indexable URLs and reference it from robots.txt.' },
    (ctx) => (ctx.sitemaps.some((s) => s.kind !== 'unknown' && s.status === 200) ? [] : [{ url: ctx.seed, message: 'No usable sitemap discovered' }]),
  ),
  def(
    { id: 'sitemap-invalid', severity: 'error', category: 'site', title: 'Sitemap file is broken',
      description: 'A sitemap that was declared (robots.txt, option or index) failed to load or parse.',
      howToFix: 'Make sure the sitemap URL returns 200 and valid sitemap XML (optionally gzip-compressed).' },
    (ctx) => ctx.sitemaps.filter((s) => s.error && s.source !== 'default').map((s): Finding => ({ url: s.url, message: s.error! })),
  ),
  def(
    { id: 'indexable-not-in-sitemap', severity: 'notice', category: 'site', title: 'Indexable page missing from sitemap',
      description: 'The page is crawlable and indexable but not listed in the sitemap.',
      howToFix: 'Add all canonical, indexable pages to the sitemap.' },
    (ctx) => {
      if (!ctx.complete || !ctx.sitemapUrls.length) return [];
      return ctx.pages.filter((p) => isIndexableHtml(p) && !p.inSitemap && (p.canonicals.length === 0 || p.canonicals[0] === p.url))
        .map((p): Finding => ({ url: p.url, message: 'Indexable but not in the sitemap' }));
    },
  ),
  def(
    { id: 'not-https', severity: 'warning', category: 'security', title: 'Site is not served over HTTPS',
      description: 'The start URL uses plain HTTP. Browsers flag it as insecure and search engines prefer HTTPS.',
      howToFix: 'Install a TLS certificate and redirect all HTTP traffic to HTTPS.' },
    (ctx) => (ctx.site.isHttps ? [] : [{ url: ctx.seed, message: 'Start URL uses http://' }]),
  ),
  def(
    { id: 'hsts-missing', severity: 'notice', category: 'security', title: 'No HSTS header',
      description: 'The HTTPS site does not send Strict-Transport-Security.',
      howToFix: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains once HTTPS works everywhere.' },
    (ctx) => (ctx.site.isHttps && !ctx.site.hsts ? [{ url: ctx.seed, message: 'Strict-Transport-Security header missing on the start page' }] : []),
  ),
  def(
    { id: 'http-not-redirected', severity: 'warning', category: 'security', title: 'HTTP version does not redirect to HTTPS',
      description: 'The http:// address of the site stays on HTTP instead of redirecting to HTTPS.',
      howToFix: 'Add a site-wide 301 redirect from http:// to https://.' },
    (ctx) => (ctx.site.httpRedirect && ctx.site.httpRedirect.tested && !ctx.site.httpRedirect.redirectsToHttps
      ? [{ url: ctx.site.httpRedirect.startUrl, message: `http:// start URL returned HTTP ${ctx.site.httpRedirect.status ?? 'error'} without redirecting to https` }]
      : []),
  ),
  def(
    { id: 'favicon-missing', severity: 'notice', category: 'site', title: 'No favicon',
      description: 'Neither a <link rel="icon"> nor /favicon.ico resolved.',
      howToFix: 'Add a favicon and reference it with <link rel="icon">.' },
    (ctx) => (ctx.site.favicon && (ctx.site.favicon.status ?? 0) >= 400 ? [{ url: ctx.seed, message: `Favicon ${ctx.site.favicon.url} returned HTTP ${ctx.site.favicon.status}` }] : []),
  ),
  def(
    { id: 'soft-404', severity: 'error', category: 'site', title: 'Missing pages return 200 (soft 404)',
      description: 'A request for a made-up URL returned 200 instead of 404, so search engines may index error pages.',
      howToFix: 'Make the "not found" template send a real 404 status code.' },
    (ctx) => (ctx.site.soft404 && ctx.site.soft404.status === 200 ? [{ url: ctx.site.soft404.url, message: 'Random non-existent URL returned HTTP 200' }] : []),
  ),
];
