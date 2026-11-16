import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let server: FixtureServer;
let out: string;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Async spawn: the fixture server lives in this process, so the event loop must stay free. */
function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  server = await startFixtureServer();
  out = mkdtempSync(join(tmpdir(), 'crawlscope-cli-'));
});
afterAll(async () => {
  await server.close();
  rmSync(out, { recursive: true, force: true });
});

describe('cli', () => {
  it('--json prints only JSON on stdout and writes the crawl directory', async () => {
    const dir = join(out, 'a');
    const r = await cli(['crawl', server.origin, '--out', dir, '--delay', '0', '--json', '--max-pages', '12']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.status).toBe('complete');
    expect(j.summary.pagesCrawled).toBe(12);
    expect(j.summary.bySeverity).toHaveProperty('error');
    for (const f of ['crawl.json', 'pages.csv', 'issues.csv', 'links.csv', 'state.jsonl']) expect(existsSync(join(dir, f))).toBe(true);
    const crawl = JSON.parse(readFileSync(join(dir, 'crawl.json'), 'utf8'));
    expect(crawl.schemaVersion).toBe(1);
  });
  it('prints a human summary by default', async () => {
    const r = await cli(['crawl', server.origin, '--out', join(out, 'b'), '--delay', '0', '--max-pages', '8']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Health score');
    expect(r.stdout).toContain('Status codes');
    expect(r.stdout).toContain('AI readiness');
  });
  it('--fail-on error exits 1 when errors exist, 0 otherwise', async () => {
    const bad = await cli(['crawl', server.origin, '--out', join(out, 'c'), '--delay', '0', '--json', '--fail-on', 'error']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/--fail-on/);
    const ok = await cli(['crawl', server.origin + '/redirect-end', '--out', join(out, 'd'), '--delay', '0', '--json', '--max-pages', '1', '--fail-on', 'error']);
    expect(ok.code).toBe(0);
  });
  it('--no-robots requires --i-own-this-site', async () => {
    const r = await cli(['crawl', server.origin, '--no-robots', '--out', join(out, 'e')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/i-own-this-site/);
    const ok = await cli(['crawl', server.origin, '--no-robots', '--i-own-this-site', '--out', join(out, 'f'), '--delay', '0', '--json', '--max-pages', '3']);
    expect(ok.code).toBe(0);
  });
  it('llms / ai-readiness commands report bots and score', async () => {
    const r = await cli(['llms', server.origin, '--json', '--max-pages', '3']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.aiReadiness.bots.find((b: { bot: string }) => b.bot === 'GPTBot').allowed).toBe(false);
    expect(j.aiReadiness.llmsTxt.present).toBe(true);
    const text = await cli(['ai-readiness', server.origin, '--max-pages', '3']);
    expect(text.stdout).toContain('AI crawlers in robots.txt');
    expect(text.stdout).toContain('GPTBot');
  });
  it('--resume continues from the latest crawl dir for the host', async () => {
    const dir = join(out, 'g');
    await cli(['crawl', server.origin, '--out', dir, '--delay', '0', '--json', '--max-pages', '4']);
    const r = await cli(['crawl', server.origin, '--out', dir, '--delay', '0', '--json', '--resume']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).summary.pagesCrawled).toBeGreaterThan(30);
  });
  it('mcp is documented in --help', async () => {
    const r = await cli(['mcp', '--help']);
    expect(r.stdout).toContain('MCP server over stdio');
    expect(r.code).toBe(0);
  });
  it('report and diff validate their arguments', async () => {
    expect((await cli(['report'])).code).not.toBe(0);
    expect((await cli(['report', join(out, 'does-not-exist')])).code).toBe(2);
    expect((await cli(['diff', join(out, 'x'), join(out, 'y')])).code).toBe(2);
  });
  it('rejects bad input', async () => {
    expect((await cli(['crawl', 'http://', '--out', join(out, 'h')])).code).toBe(2);
    expect((await cli(['crawl', server.origin, '--fail-on', 'nope'])).code).toBe(2);
    expect((await cli(['crawl', server.origin, '--include', '('])).code).toBe(2);
  });
});
