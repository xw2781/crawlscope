import { describe, expect, it } from 'vitest';
import { isSameSite, normalizeUrl, registrableDomain } from '../../src/util/url.js';

describe('normalizeUrl', () => {
  it('lowercases host, drops fragment and default port, adds root slash', () => {
    expect(normalizeUrl('HTTP://Example.COM:80')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com:443/a#frag')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });
  it('resolves relative URLs and dot segments', () => {
    expect(normalizeUrl('../b/./c', 'https://x.test/a/d/e')).toBe('https://x.test/a/b/c');
    expect(normalizeUrl('?q=1', 'https://x.test/p')).toBe('https://x.test/p?q=1');
    expect(normalizeUrl('//cdn.test/x', 'https://x.test/')).toBe('https://cdn.test/x');
  });
  it('normalises percent-encoding and keeps query order', () => {
    expect(normalizeUrl('https://x.test/%7euser/a%2fb?b=1&a=%7e')).toBe('https://x.test/~user/a%2Fb?b=1&a=~');
  });
  it('rejects non-http(s) and garbage', () => {
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('http://')).toBeNull();
  });
  it('strips credentials, trailing dot and empty query marker', () => {
    expect(normalizeUrl('https://u:p@x.test./a?')).toBe('https://x.test/a');
  });
  it('can strip tracking params', () => {
    expect(normalizeUrl('https://x.test/?utm_source=a&id=2&gclid=z', undefined, { stripTracking: true })).toBe('https://x.test/?id=2');
  });
});

describe('site scoping', () => {
  it('treats www and apex as the same site', () => {
    expect(isSameSite('https://www.x.test/a', 'https://x.test/', false)).toBe(true);
    expect(isSameSite('https://blog.x.test/a', 'https://x.test/', false)).toBe(false);
    expect(isSameSite('https://blog.x.test/a', 'https://x.test/', true)).toBe(true);
    expect(isSameSite('https://evil-x.test/a', 'https://x.test/', true)).toBe(false);
  });
  it('registrableDomain knows common multi-part suffixes', () => {
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.example.com')).toBe('example.com');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});
