import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCrawl } from '../output.js';
import { hostOf } from '../util/url.js';
import type { CrawlResult } from '../types.js';

export class ToolError extends Error {}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export function defaultDataDir(): string {
  return resolve(process.env.CRAWLSCOPE_DATA_DIR || join(homedir(), '.crawlscope'));
}

export interface CrawlEntry {
  name: string;
  dir: string;
  id: string;
  seed: string;
  startedAt: string;
  status: string;
  truncated: boolean;
  pages: number;
  healthScore: number;
  aiReadinessScore: number | null;
  issues: number;
}

/** Crawl directories under the data dir, with a small mtime-keyed cache so list/lookup stay cheap. */
export class CrawlStore {
  private infos = new Map<string, { mtime: number; entry: CrawlEntry }>();
  private results = new Map<string, { mtime: number; result: CrawlResult }>();

  constructor(public readonly dataDir: string) {}

  ensure(): void {
    mkdirSync(this.dataDir, { recursive: true });
  }

  /** a fresh, unused directory name for a crawl of `url` */
  newName(url: string): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const base = `${hostOf(url).replace(/[^a-z0-9.-]/gi, '_')}-${stamp}`;
    let name = base;
    for (let i = 2; existsSync(join(this.dataDir, name)); i++) name = `${base}-${i}`;
    return name;
  }

  load(name: string): CrawlResult {
    const f = join(this.dataDir, name, 'crawl.json');
    const mtime = statSync(f).mtimeMs;
    const hit = this.results.get(name);
    if (hit && hit.mtime === mtime) return hit.result;
    const result = readCrawl(join(this.dataDir, name));
    this.results.set(name, { mtime, result });
    while (this.results.size > 3) this.results.delete(this.results.keys().next().value!);
    return result;
  }

  list(): CrawlEntry[] {
    if (!existsSync(this.dataDir)) return [];
    const out: CrawlEntry[] = [];
    for (const name of readdirSync(this.dataDir)) {
      const f = join(this.dataDir, name, 'crawl.json');
      if (!NAME_RE.test(name) || !existsSync(f)) continue;
      let st;
      try { st = statSync(f); } catch { continue; }
      let c = this.infos.get(name);
      if (!c || c.mtime !== st.mtimeMs) {
        try {
          const r = this.load(name);
          c = {
            mtime: st.mtimeMs,
            entry: { name, dir: join(this.dataDir, name), id: r.id, seed: r.seed, startedAt: r.startedAt, status: r.status, truncated: r.truncated, pages: r.summary.pagesCrawled, healthScore: r.summary.healthScore, aiReadinessScore: r.summary.aiReadinessScore, issues: r.summary.issuesTotal },
          };
          this.infos.set(name, c);
        } catch { continue; }
      }
      out.push(c.entry);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Resolve a user-supplied reference: omitted/"latest", a crawl name or id, or a host / seed URL (latest crawl of it). */
  resolveRef(ref?: string | null): CrawlEntry {
    const all = this.list();
    if (!all.length) throw new ToolError(`No crawls found in ${this.dataDir}. Run crawl_site first.`);
    const r = (ref ?? '').trim();
    if (!r || r === 'latest') return all[0];
    const exact = all.find((e) => e.name === r || e.id === r);
    if (exact) return exact;
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(r) ? r : `https://${r}`).host.toLowerCase(); } catch { /* not a URL */ }
    const byHost = host ? all.find((e) => hostOf(e.seed) === host) : undefined;
    if (byHost) return byHost;
    const prefix = all.find((e) => e.name.startsWith(r));
    if (prefix) return prefix;
    throw new ToolError(`Unknown crawl "${r}". Available (newest first): ${all.slice(0, 8).map((e) => e.name).join(', ')}. Use list_crawls to see all.`);
  }

  get(ref?: string | null): { entry: CrawlEntry; result: CrawlResult } {
    const entry = this.resolveRef(ref);
    return { entry, result: this.load(entry.name) };
  }
}
