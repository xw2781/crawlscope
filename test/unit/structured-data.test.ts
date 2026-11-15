import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { extractStructuredData, validateStructuredItem } from '../../src/structured-data.js';

const ex = (html: string) => extractStructuredData(cheerio.load(html));

describe('structured data extraction', () => {
  it('parses JSON-LD including @graph and arrays', () => {
    const items = ex(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"A"},{"@type":["Person","Thing"],"name":"B"}]}</script>`);
    expect(items.map((i) => i.types)).toEqual([['Organization'], ['Person', 'Thing']]);
    expect(items.every((i) => i.hasContext)).toBe(true);
  });
  it('reports invalid JSON', () => {
    const items = ex(`<script type="application/ld+json">{"a":1,}</script>`);
    expect(items[0].parseError).toBeTruthy();
    expect(validateStructuredItem(items[0])[0].kind).toBe('invalid-json');
  });
  it('extracts microdata with nested items', () => {
    const items = ex(`<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Pen</span><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="3"><meta itemprop="priceCurrency" content="USD"></div></div>`);
    expect(items).toHaveLength(1);
    expect(items[0].format).toBe('microdata');
    expect(items[0].types).toEqual(['Product']);
    expect(items[0].data['name']).toBe('Pen');
    expect((items[0].data['offers'] as Record<string, unknown>)['price']).toBe('3');
  });
  it('extracts basic RDFa', () => {
    const items = ex(`<div vocab="https://schema.org/" typeof="Person"><span property="name">Ada</span><a property="url" href="https://a.test">x</a></div>`);
    expect(items[0].format).toBe('rdfa');
    expect(items[0].types).toEqual(['Person']);
    expect(items[0].data['name']).toBe('Ada');
    expect(items[0].data['url']).toBe('https://a.test');
  });
});

describe('structured data validation', () => {
  const item = (data: Record<string, unknown>) => ({ format: 'json-ld' as const, types: [String(data['@type'])], data, hasContext: '@context' in data });
  const kinds = (data: Record<string, unknown>) => validateStructuredItem(item(data)).map((p) => p.kind);

  it('flags missing @context and @type', () => {
    expect(kinds({ '@type': 'Thing' })).toContain('missing-context');
    expect(validateStructuredItem({ format: 'json-ld', types: [], data: { '@context': 'https://schema.org' }, hasContext: true }).map((p) => p.kind)).toContain('missing-type');
  });
  it('flags non-schema.org context', () => {
    expect(kinds({ '@context': 'https://example.org/vocab', '@type': 'Thing' })).toContain('invalid-value');
  });
  it('requires properties per type', () => {
    const p = validateStructuredItem(item({ '@context': 'https://schema.org', '@type': 'Event', name: 'x' }));
    const req = p.find((x) => x.kind === 'missing-required')!;
    expect(req.properties).toEqual(['startDate', 'location']);
  });
  it('treats subtypes like their parent (BlogPosting -> Article)', () => {
    expect(kinds({ '@context': 'https://schema.org', '@type': 'BlogPosting' })).toContain('missing-required');
  });
  it('accepts a complete Article without required problems', () => {
    const k = kinds({ '@context': 'https://schema.org', '@type': 'Article', headline: 'h', image: 'i', datePublished: 'd', dateModified: 'd', author: { name: 'a' } });
    expect(k).toEqual([]);
  });
  it('checks BreadcrumbList, FAQPage and Product offers deeply', () => {
    expect(kinds({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', name: 'x' }] })).toContain('missing-required');
    expect(kinds({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'q' }] })).toContain('missing-required');
    expect(kinds({ '@context': 'https://schema.org', '@type': 'Product', name: 'p', offers: { price: '1' } })).toContain('missing-required');
    expect(kinds({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'q', acceptedAnswer: { text: 'a' } }] })).toEqual([]);
  });
  it('ignores unknown types', () => {
    expect(kinds({ '@context': 'https://schema.org', '@type': 'SomethingNew' })).toEqual([]);
  });
});
