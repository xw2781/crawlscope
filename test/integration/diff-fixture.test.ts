import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { crawl } from '../../src/crawler.js';
import { resolveOptions } from '../../src/options.js';
import { writeCrawlDir } from '../../src/output.js';
import { diffDirs } from '../../src/diff.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let sa: FixtureServer, sb: FixtureServer, tmp: string;
const dirs = { a: '', b: '' };

beforeAll(async () => {
  sa = await startFixtureServer();
  sb = await startFixtureServer({ variant: 'b' });
  tmp = mkdtempSync(join(tmpdir(), 'crawlscope-diff-'));
  for (const [k, s] of [['a', sa], ['b', sb]] as const) {
    dirs[k] = join(tmp, k);
    const r = await crawl(resolveOptions({ url: s.origin + '/', delayMs: 0, outDir: dirs[k] }));
    writeCrawlDir(dirs[k], r, ['json', 'csv', 'html']);
  }
}, 60000);
afterAll(async () => { await sa.close(); await sb.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('crawl dir writes report.html', () => {
  it('writes a self-contained report', () => {
    const f = join(dirs.a, 'report.html');
    expect(existsSync(f)).toBe(true);
    const html = readFileSync(f, 'utf8');
    expect(html).toContain('cs-data');
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=["']https?:/i);
  });
});

describe('diff of two fixture crawls', () => {
  it('detects the mutated variant', () => {
    const d = diffDirs(dirs.a, dirs.b);
    expect(d.pages.added.map((u) => new URL(u).pathname)).toEqual(['/new-page']);
    expect(d.pages.removed.map((u) => new URL(u).pathname)).toContain('/careers');
    const about = d.pages.changed.find((c) => new URL(c.url).pathname === '/about')!;
    expect(about.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['title', 'metaDescription']));
    expect(d.issues.added.some((i) => i.checkId === 'meta-description-missing' && i.url.endsWith('/about'))).toBe(true);
    expect(d.issues.persisting.length).toBeGreaterThan(50);
    expect(d.totals.issuesAdded + d.totals.issuesResolved).toBeGreaterThan(0);
  });

  it('CLI: diff --json and --html, and report regenerates', () => {
    const cli = (args: string[]) => execFileSync('npx', ['tsx', join(process.cwd(), 'src/cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const j = JSON.parse(cli(['diff', dirs.a, dirs.b, '--json']));
    expect(j.schemaVersion).toBe(1);
    expect(j.totals.added).toBe(1);
    const out = join(tmp, 'diff.html');
    const text = cli(['diff', dirs.a, dirs.b, '--html', out]);
    expect(text).toContain('Pages');
    expect(existsSync(out)).toBe(true);
    rmSync(join(dirs.a, 'report.html'));
    cli(['report', dirs.a]);
    expect(existsSync(join(dirs.a, 'report.html'))).toBe(true);
  }, 60000);
});
