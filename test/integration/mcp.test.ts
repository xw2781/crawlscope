import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMcpServer } from '../../src/mcp/server.js';
import { startFixtureServer, type FixtureServer } from '../helpers/server.js';

let fx: FixtureServer;
let dataDir: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content[0].text;
  let json: any;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!res.isError, text, json };
}

beforeAll(async () => {
  fx = await startFixtureServer();
  dataDir = mkdtempSync(join(tmpdir(), 'cs-mcp-'));
  const { server } = createMcpServer({ dataDir });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
}, 30000);
afterAll(async () => {
  await client.close();
  await fx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('MCP server (in-memory)', () => {
  it('lists all tools with descriptions and schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['audit_url', 'check_ai_readiness', 'check_robots_url', 'crawl_site', 'diff_crawls', 'export_report', 'find_pages', 'get_crawl_summary', 'get_page', 'list_crawls', 'list_issues']);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    const crawl = tools.find((t) => t.name === 'crawl_site')!;
    expect((crawl.inputSchema.properties as any).max_pages.default).toBe(200);
  });

  it('returns a clear error when there are no crawls', async () => {
    const r = await call('get_crawl_summary');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No crawls found/);
  });

  let crawlId = '';
  it('crawl_site -> summary with agent-safe cap and progress', async () => {
    const progress: number[] = [];
    const res = (await client.callTool({ name: 'crawl_site', arguments: { url: fx.origin + '/', max_pages: 12, delay_ms: 50, concurrency: 4 } }, undefined, { onprogress: (p) => progress.push(p.progress), timeout: 60000 })) as any;
    const j = JSON.parse(res.content[0].text);
    crawlId = j.crawl_id;
    expect(res.isError).toBeFalsy();
    expect(j.pages).toBeGreaterThan(5);
    expect(j.truncated).toBe(true);
    expect(j.hints.join(' ')).toMatch(/max_pages/);
    expect(existsSync(join(dataDir, crawlId, 'crawl.json'))).toBe(true);
    expect(existsSync(join(dataDir, crawlId, 'report.html'))).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  }, 60000);

  it('list_crawls and get_crawl_summary', async () => {
    const l = await call('list_crawls');
    expect(l.json.total).toBe(1);
    expect(l.json.crawls[0].crawl_id).toBe(crawlId);
    const s = await call('get_crawl_summary', { crawl_id: 'latest' });
    expect(s.json.topIssueTypes.length).toBeGreaterThan(0);
    expect(s.json.healthScore).toBeTypeOf('number');
  });

  it('list_issues filters, pages and truncates with hints', async () => {
    const all = await call('list_issues', { limit: 3 });
    expect(all.json.returned).toBe(3);
    expect(all.json.total).toBeGreaterThan(3);
    expect(all.json.hint).toMatch(/offset=3/);
    expect(all.json.issues[0].severity).toBe('error');
    const errs = await call('list_issues', { severity: 'error', limit: 200 });
    expect(errs.json.issues.every((i: any) => i.severity === 'error')).toBe(true);
    const check = errs.json.checks[0].check;
    const one = await call('list_issues', { check_id: check });
    expect(one.json.checks[0].howToFix).toBeTruthy();
  });

  it('get_page by absolute URL and by path', async () => {
    const a = await call('get_page', { url: fx.origin + '/' });
    expect(a.json.status).toBe(200);
    expect(a.json.title).toBeTruthy();
    expect(a.json.outlinks.total).toBeGreaterThan(0);
    const b = await call('get_page', { url: '/' });
    expect(b.json.url).toBe(a.json.url);
  });

  it('find_pages filters and sorts', async () => {
    const r = await call('find_pages', { status_class: '2xx', sort_by: 'response_time', order: 'desc', limit: 5 });
    expect(r.json.pages.length).toBeLessThanOrEqual(5);
    expect(r.json.pages.every((p: any) => p.status === 200)).toBe(true);
    const ms = r.json.pages.map((p: any) => p.ms);
    expect([...ms].sort((x, y) => y - x)).toEqual(ms);
  });

  it('second crawl then diff_crawls', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const fb = await startFixtureServer({ variant: 'b' });
    const res = await call('crawl_site', { url: fb.origin + '/', max_pages: 30, delay_ms: 50 });
    // different origin => different host:port, so compare explicitly
    const d = await call('diff_crawls', { crawl_a: crawlId, crawl_b: res.json.crawl_id, limit: 5 });
    expect(d.isError).toBe(false);
    expect(d.json.totals).toBeDefined();
    expect(d.json.pagesAdded.length).toBeLessThanOrEqual(5);
    await fb.close();
  }, 90000);

  it('export_report writes files', async () => {
    const r = await call('export_report', { crawl_id: crawlId, format: 'csv' });
    expect(r.json.files.map((f: any) => f.path.split('/').pop())).toEqual(['pages.csv', 'issues.csv', 'links.csv']);
  });

  it('audit_url, check_robots_url and check_ai_readiness need no saved crawl', async () => {
    const a = await call('audit_url', { url: fx.origin + '/about' });
    expect(a.json.status).toBe(200);
    expect(Array.isArray(a.json.issues)).toBe(true);
    const ok = await call('check_robots_url', { url: fx.origin + '/about', user_agent: 'Googlebot' });
    expect(ok.json.allowed).toBe(true);
    const no = await call('check_robots_url', { url: fx.origin + '/private/secret', user_agent: 'crawlscope' });
    expect(no.json.allowed).toBe(false);
    expect(no.json.decidingRule).toMatch(/disallow/);
    const ai = await call('check_ai_readiness', { url: fx.origin + '/', sample_pages: 4 });
    expect(ai.json.score).toBeTypeOf('number');
    expect(ai.json.bots.length).toBeGreaterThan(10);
  }, 60000);

  it('exposes resources for the latest crawl', async () => {
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === 'crawlscope://crawls/latest/summary')).toBe(true);
    const res = await client.readResource({ uri: 'crawlscope://crawls/latest/summary' });
    expect(JSON.parse((res.contents[0] as { text: string }).text).crawl_id).toBeTruthy();
  });

  describe('errors are tool errors, never crashes', () => {
    it.each([
      ['crawl_site', { url: 'not a url with spaces' }, /valid http/],
      ['crawl_site', { url: fx_placeholder(), include: ['('] }, /regular expression/],
      ['get_page', { url: '/does-not-exist' }, /not found/],
      ['get_page', { crawl_id: 'nope', url: '/' }, /Unknown crawl/],
      ['list_issues', { check_id: 'bogus-check' }, /Unknown check_id/],
      ['diff_crawls', { crawl_a: 'latest', crawl_b: 'latest' }, /same crawl/],
      ['check_robots_url', { url: 'http://127.0.0.1:1/x' }, /unreachable/],
    ])('%s %j', async (name, args, re) => {
      const r = await call(name as string, args as Record<string, unknown>);
      if (name === 'check_robots_url') { expect(r.json.allowed).toBe(false); expect(r.json.reason).toMatch(re as RegExp); return; }
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(re as RegExp);
    });
    it('rejects invalid arguments (schema validation)', async () => {
      const res = await client.callTool({ name: 'list_issues', arguments: { limit: 100000 } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] })) as any;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/limit|too_big|Invalid/i);
    });
    it('unknown tool does not kill the session', async () => {
      await client.callTool({ name: 'nope', arguments: {} }).catch(() => undefined);
      expect((await call('list_crawls')).json.total).toBeGreaterThan(0);
    });
  });
});

function fx_placeholder() { return 'https://example.invalid/'; }

describe('MCP server over stdio (built CLI)', () => {
  const cli = resolve('dist/cli.js');
  it.skipIf(!existsSync(cli))('handshake, crawl and read back through `crawlscope mcp`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-mcp-stdio-'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...process.env, CRAWLSCOPE_DATA_DIR: dir } as Record<string, string>, stderr: 'pipe' });
    const c = new Client({ name: 'stdio-test', version: '0' });
    await c.connect(transport);
    expect(c.getServerVersion()?.name).toBe('crawlscope');
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(11);
    const res = (await c.callTool({ name: 'crawl_site', arguments: { url: fx.origin + '/', max_pages: 5, delay_ms: 50 } }, undefined, { timeout: 60000 })) as any;
    const j = JSON.parse(res.content[0].text);
    expect(j.dir.startsWith(dir)).toBe(true);
    const issues = (await c.callTool({ name: 'list_issues', arguments: { crawl_id: j.crawl_id, limit: 2 } })) as any;
    expect(JSON.parse(issues.content[0].text).returned).toBe(2);
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }, 90000);
});
