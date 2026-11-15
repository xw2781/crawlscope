import * as cheerio from 'cheerio';
import { gunzipSync } from 'node:zlib';
import type { Fetcher } from './fetcher.js';
import type { SitemapFile, SitemapUrl } from './types.js';
import { normalizeUrl } from './util/url.js';

export interface ParsedSitemap {
  kind: 'urlset' | 'index' | 'unknown';
  urls: { loc: string; lastmod: string | null }[];
  children: string[];
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('sitemapindex').length) {
    const children = $('sitemapindex > sitemap > loc').map((_, e) => $(e).text().trim()).get().filter(Boolean);
    return { kind: 'index', urls: [], children };
  }
  if ($('urlset').length) {
    const urls = $('urlset > url')
      .map((_, e) => ({ loc: $(e).children('loc').first().text().trim(), lastmod: $(e).children('lastmod').first().text().trim() || null }))
      .get()
      .filter((u) => u.loc);
    return { kind: 'urlset', urls, children: [] };
  }
  return { kind: 'unknown', urls: [], children: [] };
}

export function decodeSitemapBody(body: Buffer): { text: string; gzip: boolean } {
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    return { text: gunzipSync(body, { maxOutputLength: 100 * 1024 * 1024 }).toString('utf8'), gzip: true };
  }
  return { text: body.toString('utf8'), gzip: false };
}

export interface SitemapDiscovery {
  files: SitemapFile[];
  urls: SitemapUrl[];
}

const MAX_FILES = 60;
const MAX_URLS = 250_000;

export async function discoverSitemaps(
  fetcher: Fetcher,
  origin: string,
  robotsSitemaps: string[],
  extra: string[],
  hostDelayMs = 0,
): Promise<SitemapDiscovery> {
  const files: SitemapFile[] = [];
  const urls: SitemapUrl[] = [];
  const seen = new Set<string>();
  type Src = SitemapFile['source'];
  const queue: { url: string; source: Src; depth: number }[] = [];
  for (const u of extra) queue.push({ url: u, source: 'option', depth: 0 });
  for (const u of robotsSitemaps) queue.push({ url: u, source: 'robots', depth: 0 });
  if (!queue.length) queue.push({ url: origin + '/sitemap.xml', source: 'default', depth: 0 });

  while (queue.length && files.length < MAX_FILES) {
    const item = queue.shift()!;
    const norm = normalizeUrl(item.url, origin);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const file: SitemapFile = { url: norm, source: item.source, kind: 'unknown', status: null, gzip: false, urlCount: 0, lastmodCount: 0, children: [], error: null };
    files.push(file);
    const res = await fetcher.request(norm, { maxBodyBytes: 60 * 1024 * 1024, hostDelayMs, headers: { accept: 'application/xml,text/xml,*/*' } });
    if (res.error) {
      file.error = res.error.message;
      continue;
    }
    file.status = res.status;
    if (res.status !== 200 || !res.body) {
      file.error = `HTTP ${res.status}`;
      continue;
    }
    try {
      const { text, gzip } = decodeSitemapBody(res.body);
      file.gzip = gzip;
      const parsed = parseSitemapXml(text);
      file.kind = parsed.kind;
      if (parsed.kind === 'unknown') file.error = 'Not a valid sitemap (no <urlset> or <sitemapindex>)';
      file.children = parsed.children;
      for (const c of parsed.children) if (item.depth < 3) queue.push({ url: c, source: 'index', depth: item.depth + 1 });
      for (const u of parsed.urls) {
        if (urls.length >= MAX_URLS) break;
        const loc = normalizeUrl(u.loc, norm);
        if (!loc) continue;
        urls.push({ loc, lastmod: u.lastmod, sitemap: norm });
        file.urlCount++;
        if (u.lastmod) file.lastmodCount++;
      }
    } catch (e) {
      file.error = `Could not decode sitemap: ${(e as Error).message}`;
    }
  }
  return { files, urls };
}
