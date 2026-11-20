import { describe, expect, it } from 'vitest';
import { getCheck, runChecks } from '../../src/checks/index.js';
import { versionTokens } from '../../src/checks/disclosure.js';
import { ctx, page } from '../helpers/factory.js';
import type { PageRecord } from '../../src/types.js';

const run = (pages: PageRecord[]) => getCheck('server-version-disclosure')!.run(ctx(pages));
const withHeaders = (path: string, headers: Record<string, string>, patch: Partial<PageRecord> = {}) => page(path, { headers, ...patch });

describe('versionTokens', () => {
  it('finds product/version tokens', () => {
    expect(versionTokens('server', 'nginx/1.25.3')).toEqual(['nginx/1.25.3']);
    expect(versionTokens('server', 'Apache/2.4.57 (Ubuntu)')).toEqual(['Apache/2.4.57']);
    expect(versionTokens('server', 'Apache/2.4.41 (Unix) OpenSSL/1.1.1f PHP/7.4.3')).toEqual(['Apache/2.4.41', 'OpenSSL/1.1.1f', 'PHP/7.4.3']);
    expect(versionTokens('x-powered-by', 'PHP/8.1.2')).toEqual(['PHP/8.1.2']);
    expect(versionTokens('server', 'Microsoft-IIS/10.0')).toEqual(['Microsoft-IIS/10.0']);
    expect(versionTokens('x-powered-by', 'Phusion Passenger 6.0.4')).toEqual(['Passenger 6.0.4']);
  });
  it('treats ASP.NET version headers as bare versions', () => {
    expect(versionTokens('x-aspnet-version', '4.0.30319')).toEqual(['4.0.30319']);
    expect(versionTokens('x-aspnetmvc-version', '5.2')).toEqual(['5.2']);
    expect(versionTokens('x-aspnetmvc-version', '')).toEqual([]);
  });
  it('ignores product names without a specific version', () => {
    for (const v of ['nginx', 'Apache', 'cloudflare', 'Microsoft-IIS', 'gws', 'AmazonS3', 'Apache/2', 'nginx/1']) expect(versionTokens('server', v)).toEqual([]);
    for (const v of ['Express', 'ASP.NET', 'Next.js', 'PleskLin']) expect(versionTokens('x-powered-by', v)).toEqual([]);
  });
  it('ignores protocol versions', () => {
    expect(versionTokens('server', 'HTTP/1.1 frontend')).toEqual([]);
  });
});

describe('server-version-disclosure check', () => {
  it('has warning severity in the security category', () => {
    const c = getCheck('server-version-disclosure')!;
    expect(c).toMatchObject({ severity: 'warning', category: 'security' });
    expect(c.howToFix).toMatch(/server_tokens off/);
    expect(c.description).toMatch(/CVE/);
    expect(c.description).toMatch(/does not check whether the version is actually vulnerable/);
  });
  it('reports once per host, combining headers and pages', () => {
    const f = run([
      withHeaders('/a', { server: 'nginx/1.25.3', 'x-powered-by': 'PHP/8.1.2' }),
      withHeaders('/b', { server: 'nginx/1.25.3' }),
      withHeaders('/c', { server: 'nginx/1.25.3', 'x-aspnet-version': '4.0.30319' }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].url).toBe('https://example.test/a');
    expect(f[0].message).toContain('example.test');
    expect(f[0].message).toContain('3 pages');
    expect(f[0].message).toContain('Server: nginx/1.25.3');
    expect(f[0].message).toMatch(/server_tokens off/);
    expect(f[0].message).not.toMatch(/is vulnerable/i);
    expect(f[0].details).toMatchObject({
      host: 'example.test', pages: 3, versions: ['nginx/1.25.3', 'PHP/8.1.2', '4.0.30319'],
      headers: { server: ['nginx/1.25.3'], 'x-powered-by': ['PHP/8.1.2'], 'x-aspnet-version': ['4.0.30319'] },
    });
  });
  it('reports each host separately', () => {
    const f = run([
      withHeaders('/a', { server: 'nginx/1.25.3' }),
      withHeaders('https://blog.example.test/', { server: 'Apache/2.4.57 (Ubuntu)' }),
    ]);
    expect(f.map((x) => x.details!.host).sort()).toEqual(['blog.example.test', 'example.test']);
  });
  it('is silent when no version is exposed or the request failed', () => {
    expect(run([withHeaders('/a', { server: 'nginx', 'x-powered-by': 'Express' }), page('/b')])).toEqual([]);
    expect(run([withHeaders('/x', { server: 'nginx/1.25.3' }, { status: 0, fetchError: { code: 'TIMEOUT', message: 't' } })])).toEqual([]);
  });
  it('flags non-HTML responses too (headers are what matter)', () => {
    expect(run([withHeaders('/file.pdf', { server: 'Microsoft-IIS/10.0' }, { isHtml: false, contentType: 'application/pdf' })])).toHaveLength(1);
  });
  it('flows through runChecks as a single issue', () => {
    const issues = runChecks(ctx([withHeaders('/a', { server: 'nginx/1.25.3' }), withHeaders('/b', { server: 'nginx/1.25.3' })]))
      .filter((i) => i.checkId === 'server-version-disclosure');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', category: 'security' });
  });
});
