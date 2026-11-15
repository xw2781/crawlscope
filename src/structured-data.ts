import type { CheerioAPI } from 'cheerio';
import type { StructuredDataItem } from './types.js';

const shortType = (t: unknown): string => String(t).replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');

function typesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(shortType);
  if (v === undefined || v === null || v === '') return [];
  return [shortType(v)];
}

function pushJsonLd(node: unknown, out: StructuredDataItem[], inheritedContext: boolean): void {
  if (Array.isArray(node)) return node.forEach((n) => pushJsonLd(n, out, inheritedContext));
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const hasContext = inheritedContext || obj['@context'] !== undefined;
  if (Array.isArray(obj['@graph'])) {
    pushJsonLd(obj['@graph'], out, hasContext);
    // a graph wrapper may carry no @type itself
    if (obj['@type'] === undefined) return;
  }
  out.push({ format: 'json-ld', types: typesOf(obj['@type']), data: obj, hasContext });
}

function microdataValue($: CheerioAPI, el: ReturnType<CheerioAPI>): unknown {
  const node = el.get(0) as { tagName?: string } | undefined;
  const tag = node?.tagName?.toLowerCase();
  if (el.is('[itemscope]')) return microdataItem($, el);
  if (tag === 'meta') return el.attr('content') ?? '';
  if (['a', 'link', 'area'].includes(tag ?? '')) return el.attr('href') ?? '';
  if (['img', 'audio', 'video', 'source', 'embed', 'iframe'].includes(tag ?? '')) return el.attr('src') ?? '';
  if (tag === 'time') return el.attr('datetime') ?? el.text().trim();
  return el.attr('content') ?? el.text().replace(/\s+/g, ' ').trim();
}

function microdataItem($: CheerioAPI, scope: ReturnType<CheerioAPI>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const type = scope.attr('itemtype');
  if (type) data['@type'] = type.split(/\s+/).map(shortType);
  const walk = (el: ReturnType<CheerioAPI>) => {
    el.children().each((_, c) => {
      const child = $(c);
      const prop = child.attr('itemprop');
      if (prop) {
        for (const name of prop.split(/\s+/)) {
          const val = microdataValue($, child);
          data[name] = data[name] === undefined ? val : ([] as unknown[]).concat(data[name], val);
        }
        if (!child.is('[itemscope]')) walk(child);
      } else if (!child.is('[itemscope]')) walk(child);
    });
  };
  walk(scope);
  return data;
}

function rdfaItem($: CheerioAPI, scope: ReturnType<CheerioAPI>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const tp = scope.attr('typeof');
  if (tp) data['@type'] = tp.split(/\s+/).map(shortType);
  scope.find('[property]').each((_, c) => {
    const el = $(c);
    // skip properties belonging to a nested typeof
    const owner = el.parents('[typeof]').first();
    if (owner.length && owner.get(0) !== scope.get(0) && !el.is('[typeof]')) return;
    const name = (el.attr('property') ?? '').split(/\s+/)[0].replace(/^schema:/, '');
    if (!name) return;
    const val = el.attr('content') ?? el.attr('href') ?? el.attr('src') ?? el.text().replace(/\s+/g, ' ').trim();
    data[name] = data[name] === undefined ? val : ([] as unknown[]).concat(data[name], val);
  });
  return data;
}

export function extractStructuredData($: CheerioAPI): StructuredDataItem[] {
  const out: StructuredDataItem[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) {
      out.push({ format: 'json-ld', types: [], data: {}, hasContext: false, parseError: 'Empty JSON-LD block' });
      return;
    }
    try {
      pushJsonLd(JSON.parse(raw), out, false);
    } catch (e) {
      out.push({ format: 'json-ld', types: [], data: {}, hasContext: false, parseError: (e as Error).message.slice(0, 160) });
    }
  });
  $('[itemscope]').each((_, el) => {
    const scope = $(el);
    if (scope.is('[itemprop]')) return; // nested, handled by parent
    const data = microdataItem($, scope);
    out.push({ format: 'microdata', types: typesOf(data['@type']), data, hasContext: true });
  });
  $('[typeof]').each((_, el) => {
    const scope = $(el);
    if (scope.parents('[typeof]').length) return;
    const data = rdfaItem($, scope);
    out.push({ format: 'rdfa', types: typesOf(data['@type']), data, hasContext: true });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Validation (own requirement table, modelled on public Google Search Central docs)
// ---------------------------------------------------------------------------

interface TypeRule {
  required: string[];
  recommended: string[];
}

const RULES: Record<string, TypeRule> = {
  Organization: { required: ['name'], recommended: ['url', 'logo', 'sameAs', 'contactPoint'] },
  WebSite: { required: ['url'], recommended: ['name', 'potentialAction'] },
  Article: { required: ['headline'], recommended: ['image', 'datePublished', 'dateModified', 'author'] },
  Product: { required: ['name'], recommended: ['image', 'description', 'offers', 'aggregateRating', 'sku', 'brand'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  FAQPage: { required: ['mainEntity'], recommended: [] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHoursSpecification', 'geo', 'url', 'image', 'priceRange'] },
  Person: { required: ['name'], recommended: ['url', 'sameAs', 'image', 'jobTitle'] },
  Event: { required: ['name', 'startDate', 'location'], recommended: ['endDate', 'description', 'image', 'offers', 'eventStatus', 'organizer'] },
  Recipe: { required: ['name', 'image'], recommended: ['author', 'datePublished', 'description', 'recipeIngredient', 'recipeInstructions', 'prepTime', 'cookTime', 'nutrition', 'aggregateRating'] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'contentUrl', 'embedUrl', 'duration'] },
};

const ALIASES: Record<string, string> = {
  BlogPosting: 'Article', NewsArticle: 'Article', TechArticle: 'Article', ScholarlyArticle: 'Article', Report: 'Article',
  Restaurant: 'LocalBusiness', Store: 'LocalBusiness', Hotel: 'LocalBusiness', Dentist: 'LocalBusiness', Physician: 'LocalBusiness',
  ProfessionalService: 'LocalBusiness', MedicalBusiness: 'LocalBusiness', FoodEstablishment: 'LocalBusiness', LodgingBusiness: 'LocalBusiness',
  AutoRepair: 'LocalBusiness', HealthAndBeautyBusiness: 'LocalBusiness', LegalService: 'LocalBusiness', RealEstateAgent: 'LocalBusiness',
  Corporation: 'Organization', NGO: 'Organization', EducationalOrganization: 'Organization', OnlineStore: 'Organization',
  ProductGroup: 'Product',
};

export const SUPPORTED_SD_TYPES = Object.keys(RULES);

export type SDProblemKind = 'invalid-json' | 'missing-context' | 'missing-type' | 'missing-required' | 'missing-recommended' | 'invalid-value';
export interface SDProblem {
  kind: SDProblemKind;
  message: string;
  type?: string;
  properties?: string[];
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v).length === 0);

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

export function ruleFor(type: string): { canonical: string; rule: TypeRule } | null {
  const c = RULES[type] ? type : ALIASES[type];
  return c ? { canonical: c, rule: RULES[c] } : null;
}

export function validateStructuredItem(item: StructuredDataItem): SDProblem[] {
  const problems: SDProblem[] = [];
  if (item.parseError) {
    return [{ kind: 'invalid-json', message: `JSON-LD block could not be parsed: ${item.parseError}` }];
  }
  if (item.format === 'json-ld') {
    if (!item.hasContext) problems.push({ kind: 'missing-context', message: 'JSON-LD block has no @context (expected "https://schema.org").' });
    else {
      const ctx = item.data['@context'];
      const ctxStr = typeof ctx === 'string' ? ctx : JSON.stringify(ctx ?? '');
      if (ctx !== undefined && !/schema\.org/i.test(ctxStr)) {
        problems.push({ kind: 'invalid-value', message: `@context does not reference schema.org: ${ctxStr.slice(0, 80)}` });
      }
    }
    if (item.types.length === 0) {
      problems.push({ kind: 'missing-type', message: 'JSON-LD object has no @type.' });
      return problems;
    }
  }
  for (const t of item.types) {
    const r = ruleFor(t);
    if (!r) continue;
    const missingReq = r.rule.required.filter((p) => isEmpty(item.data[p]));
    if (missingReq.length) {
      problems.push({ kind: 'missing-required', type: t, properties: missingReq, message: `${t} is missing required propert${missingReq.length > 1 ? 'ies' : 'y'}: ${missingReq.join(', ')}.` });
    }
    const missingRec = r.rule.recommended.filter((p) => isEmpty(item.data[p]));
    if (missingRec.length) {
      problems.push({ kind: 'missing-recommended', type: t, properties: missingRec, message: `${t} is missing recommended propert${missingRec.length > 1 ? 'ies' : 'y'}: ${missingRec.join(', ')}.` });
    }
    // nested checks for the two list-shaped types
    if (r.canonical === 'BreadcrumbList') {
      const items = asArray(item.data['itemListElement']) as Record<string, unknown>[];
      const bad = items.filter((i) => !i || typeof i !== 'object' || isEmpty(i['position']) || (isEmpty(i['name']) && isEmpty((i['item'] as Record<string, unknown> | undefined)?.['name'])));
      if (bad.length) problems.push({ kind: 'missing-required', type: t, properties: ['itemListElement.position', 'itemListElement.name'], message: `${bad.length} BreadcrumbList item(s) lack position or name.` });
    }
    if (r.canonical === 'FAQPage') {
      const qs = asArray(item.data['mainEntity']) as Record<string, unknown>[];
      const bad = qs.filter((q) => !q || typeof q !== 'object' || isEmpty(q['name']) || isEmpty((q['acceptedAnswer'] as Record<string, unknown> | undefined)?.['text']));
      if (bad.length) problems.push({ kind: 'missing-required', type: t, properties: ['mainEntity.name', 'mainEntity.acceptedAnswer.text'], message: `${bad.length} FAQPage question(s) lack a name or acceptedAnswer.text.` });
    }
    if (r.canonical === 'Product' && !isEmpty(item.data['offers'])) {
      const offers = asArray(item.data['offers']) as Record<string, unknown>[];
      const bad = offers.filter((o) => !o || typeof o !== 'object' || (isEmpty(o['price']) && isEmpty(o['lowPrice'])) || isEmpty(o['priceCurrency']));
      if (bad.length) problems.push({ kind: 'missing-required', type: t, properties: ['offers.price', 'offers.priceCurrency'], message: `${bad.length} Product offer(s) lack price or priceCurrency.` });
    }
  }
  return problems;
}

export function validateStructuredData(items: StructuredDataItem[]): { item: StructuredDataItem; problems: SDProblem[] }[] {
  return items.map((item) => ({ item, problems: validateStructuredItem(item) })).filter((r) => r.problems.length > 0);
}
