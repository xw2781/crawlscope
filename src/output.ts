import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CrawlResult, LinkRecord, PageRecord } from './types.js';
import { CRAWL_FILE, STATE_FILE } from './crawler.js';

/** RFC 4180 CSV field with a guard against spreadsheet formula injection. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+@\t\r]/.test(s)) s = "'" + s;
  else if (typeof v === 'string' && /^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\r\n') + '\r\n';
}

export const PAGE_COLUMNS: [string, (p: PageRecord) => unknown][] = [
  ['url', (p) => p.url], ['status', (p) => p.status], ['status_text', (p) => p.statusText], ['indexable', (p) => p.indexable],
  ['indexability_reason', (p) => p.indexabilityReason], ['depth', (p) => p.depth], ['content_type', (p) => p.contentType],
  ['response_time_ms', (p) => p.responseTimeMs], ['size_bytes', (p) => p.sizeBytes], ['redirect_to', (p) => p.redirectTo],
  ['title', (p) => p.title], ['title_length', (p) => p.title?.length ?? ''], ['meta_description', (p) => p.metaDescription],
  ['meta_description_length', (p) => p.metaDescription?.length ?? ''],
  ['h1', (p) => p.headings.find((h) => h.level === 1)?.text ?? ''], ['h1_count', (p) => p.headings.filter((h) => h.level === 1).length],
  ['canonical', (p) => p.canonicals[0] ?? ''], ['meta_robots', (p) => p.metaRobots], ['x_robots_tag', (p) => p.xRobotsTag],
  ['lang', (p) => p.lang], ['word_count', (p) => p.wordCount], ['inlinks', (p) => p.inlinks], ['outlinks_internal', (p) => p.outlinksInternal],
  ['outlinks_external', (p) => p.outlinksExternal], ['in_sitemap', (p) => p.inSitemap], ['content_hash', (p) => p.contentHash],
  ['structured_data_types', (p) => p.structuredData.flatMap((s) => s.types).join(' | ')], ['blocked_by_robots', (p) => p.blockedByRobots],
  ['error', (p) => (p.fetchError ? `${p.fetchError.code}: ${p.fetchError.message}` : '')],
];

export function pagesCsv(pages: PageRecord[]): string {
  return toCsv(PAGE_COLUMNS.map(([h]) => h), pages.map((p) => PAGE_COLUMNS.map(([, f]) => f(p))));
}

export function issuesCsv(r: CrawlResult): string {
  const titles = new Map(r.checks.map((c) => [c.id, c]));
  return toCsv(
    ['severity', 'check_id', 'category', 'title', 'url', 'message', 'how_to_fix'],
    r.issues.map((i) => [i.severity, i.checkId, i.category, titles.get(i.checkId)?.title ?? '', i.url, i.message, titles.get(i.checkId)?.howToFix ?? '']),
  );
}

export function linksCsv(links: LinkRecord[]): string {
  return toCsv(
    ['from', 'to', 'type', 'anchor', 'rel', 'nofollow', 'internal'],
    links.map((l) => [l.from, l.to, l.type, l.anchor, l.rel.join(' '), l.nofollow, l.internal]),
  );
}

export type OutputFormat = 'json' | 'csv' | 'html';

export function writeCrawlDir(dir: string, result: CrawlResult, formats: OutputFormat[] = ['json', 'csv']): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, data: string) => {
    const tmp = join(dir, name + '.tmp');
    writeFileSync(tmp, data);
    renameSync(tmp, join(dir, name));
    written.push(join(dir, name));
  };
  if (formats.includes('json')) put(CRAWL_FILE, JSON.stringify(result, null, 1));
  if (formats.includes('csv')) {
    put('pages.csv', pagesCsv(result.pages));
    put('issues.csv', issuesCsv(result));
    put('links.csv', linksCsv(result.links));
  }
  // compact the incremental state so it holds exactly one line per page
  if (existsSync(join(dir, STATE_FILE))) {
    const byUrl = new Map(result.pages.map((p) => [p.url, p]));
    const linksBy = new Map<string, LinkRecord[]>();
    for (const l of result.links) (linksBy.get(l.from) ?? linksBy.set(l.from, []).get(l.from)!).push(l);
    put(STATE_FILE, [...byUrl.values()].map((page) => JSON.stringify({ page, links: linksBy.get(page.url) ?? [] })).join('\n') + '\n');
  }
  return written;
}

export function readCrawl(dir: string): CrawlResult {
  const data = JSON.parse(readFileSync(join(dir, CRAWL_FILE), 'utf8')) as CrawlResult;
  if (data.schemaVersion !== 1) throw new Error(`Unsupported crawl.json schemaVersion ${data.schemaVersion}`);
  return data;
}
