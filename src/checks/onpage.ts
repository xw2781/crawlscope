import type { CheckDef, Finding } from '../types.js';
import { def, duplicateFindings, duplicateGroups, isIndexableHtml, isOkHtml, perPage, short } from './helpers.js';
import { hamming } from '../util/hash.js';

export const onPageChecks: CheckDef[] = [
  def(
    { id: 'title-missing', severity: 'error', category: 'on-page', title: 'Missing or empty title',
      description: 'The page has no <title> element, or it is empty. Titles are the main label shown in results and browser tabs.',
      howToFix: 'Add a unique, descriptive <title> of roughly 30–60 characters that leads with the page topic.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (!p.title ? 'No <title> text found' : null)),
  ),
  def(
    { id: 'title-duplicate', severity: 'warning', category: 'on-page', title: 'Duplicate title',
      description: 'Several indexable pages share the same title, making them hard to tell apart.',
      howToFix: 'Give every page a title that reflects its unique content.' },
    (ctx) => duplicateFindings(duplicateGroups(ctx.pages.filter(isIndexableHtml), (p) => (p.title ? p.title.toLowerCase() : null)), 'Title'),
  ),
  def(
    { id: 'title-too-long', severity: 'notice', category: 'on-page', title: 'Title is long',
      description: 'The title exceeds the configured length (default 60 characters) and is likely to be truncated in results.',
      howToFix: 'Shorten the title and put the key phrase near the start.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.title && p.title.length > ctx.options.thresholds.titleMax ? `Title is ${p.title.length} characters: "${short(p.title, 70)}"` : null)),
  ),
  def(
    { id: 'title-too-short', severity: 'notice', category: 'on-page', title: 'Title is short',
      description: 'The title is shorter than the configured minimum (default 30 characters), leaving room to describe the page better.',
      howToFix: 'Expand the title with descriptive, relevant words.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.title && p.title.length < ctx.options.thresholds.titleMin ? `Title is only ${p.title.length} characters: "${p.title}"` : null)),
  ),
  def(
    { id: 'meta-description-missing', severity: 'warning', category: 'on-page', title: 'Missing meta description',
      description: 'No meta description was found. Search engines may auto-generate a snippet that is less persuasive.',
      howToFix: 'Add a unique <meta name="description"> of about 70–160 characters summarising the page.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (!p.metaDescription ? 'No meta description' : null)),
  ),
  def(
    { id: 'meta-description-duplicate', severity: 'notice', category: 'on-page', title: 'Duplicate meta description',
      description: 'Several pages reuse the same meta description.',
      howToFix: 'Write a distinct description for each page.' },
    (ctx) => duplicateFindings(duplicateGroups(ctx.pages.filter(isIndexableHtml), (p) => (p.metaDescription ? p.metaDescription.toLowerCase() : null)), 'Meta description'),
  ),
  def(
    { id: 'meta-description-too-long', severity: 'notice', category: 'on-page', title: 'Meta description is long',
      description: 'The description is longer than the configured limit (default 160 characters) and may be cut off.',
      howToFix: 'Trim the description and front-load the key message.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.metaDescription && p.metaDescription.length > ctx.options.thresholds.descMax ? `Meta description is ${p.metaDescription.length} characters` : null)),
  ),
  def(
    { id: 'meta-description-too-short', severity: 'notice', category: 'on-page', title: 'Meta description is short',
      description: 'The description is shorter than the configured minimum (default 70 characters).',
      howToFix: 'Expand the description so it explains what the visitor will find.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.metaDescription && p.metaDescription.length < ctx.options.thresholds.descMin ? `Meta description is only ${p.metaDescription.length} characters` : null)),
  ),
  def(
    { id: 'h1-missing', severity: 'warning', category: 'on-page', title: 'Missing H1',
      description: 'The page has no non-empty <h1> heading.',
      howToFix: 'Add one H1 that states the main topic of the page.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (!p.headings.some((h) => h.level === 1) ? 'No <h1> found' : null)),
  ),
  def(
    { id: 'h1-empty', severity: 'warning', category: 'on-page', title: 'Empty H1',
      description: 'An <h1> element exists but contains no text.',
      howToFix: 'Put the page topic in the H1 or remove the empty element.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (p.headings.some((h) => h.level === 1) && p.headings.filter((h) => h.level === 1).every((h) => !h.text) ? '<h1> is empty' : null)),
  ),
  def(
    { id: 'h1-multiple', severity: 'notice', category: 'on-page', title: 'Multiple H1 headings',
      description: 'More than one <h1> was found. HTML allows it, but a single H1 gives a clearer outline.',
      howToFix: 'Keep one H1 for the page topic and demote the others to H2/H3.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => {
      const n = p.headings.filter((h) => h.level === 1 && h.text).length;
      return n > 1 ? `${n} <h1> headings` : null;
    }),
  ),
  def(
    { id: 'h1-duplicate', severity: 'notice', category: 'on-page', title: 'Duplicate H1',
      description: 'Multiple pages share the same main heading.',
      howToFix: 'Make each page’s H1 specific to its content.' },
    (ctx) => duplicateFindings(duplicateGroups(ctx.pages.filter(isIndexableHtml), (p) => p.headings.find((h) => h.level === 1 && h.text)?.text.toLowerCase() ?? null), 'H1'),
  ),
  def(
    { id: 'heading-order-skip', severity: 'notice', category: 'on-page', title: 'Heading levels skipped',
      description: 'The heading outline jumps down more than one level (e.g. H2 straight to H4), which weakens document structure for assistive tech and machines.',
      howToFix: 'Use consecutive heading levels and style them with CSS instead of picking tags for size.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => {
      let prev = 0;
      for (const h of p.headings) {
        if (prev && h.level > prev + 1) return `H${prev} is followed by H${h.level} ("${short(h.text, 40)}")`;
        prev = h.level;
      }
      return null;
    }),
  ),
  def(
    { id: 'image-alt-missing', severity: 'warning', category: 'on-page', title: 'Images without alt attribute',
      description: 'Images lack an alt attribute, so screen readers and search engines get no description.',
      howToFix: 'Add concise alt text describing each meaningful image.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => {
      const bad = p.images.filter((i) => i.alt === null && i.src);
      return bad.length ? { message: `${bad.length} image(s) have no alt attribute`, details: { images: bad.slice(0, 10).map((i) => i.src) } } : null;
    }),
  ),
  def(
    { id: 'image-alt-empty', severity: 'notice', category: 'on-page', title: 'Images with empty alt text',
      description: 'alt="" marks an image as decorative. That is right for decoration but wrong for informative images.',
      howToFix: 'Describe images that carry meaning; keep empty alt only for purely decorative ones.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => {
      const n = p.images.filter((i) => i.alt === '' && i.src).length;
      return n ? `${n} image(s) have empty alt text` : null;
    }),
  ),
  def(
    { id: 'image-dimensions-missing', severity: 'notice', category: 'on-page', title: 'Images without width/height',
      description: 'Without explicit dimensions the layout can shift while images load (CLS).',
      howToFix: 'Set width and height attributes (or CSS aspect-ratio) on images.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => {
      const n = p.images.filter((i) => i.src && (!i.width || !i.height)).length;
      return n ? `${n} image(s) lack width/height` : null;
    }),
  ),
  def(
    { id: 'viewport-missing', severity: 'warning', category: 'on-page', title: 'Missing viewport meta tag',
      description: 'Without a viewport tag mobile browsers render the page at desktop width.',
      howToFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (!p.viewport ? 'No viewport meta tag' : null)),
  ),
  def(
    { id: 'html-lang-missing', severity: 'notice', category: 'on-page', title: 'Missing html lang attribute',
      description: 'The <html> element does not declare the page language.',
      howToFix: 'Add lang="en" (or the right BCP 47 code) to the <html> element.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (!p.lang ? '<html> has no lang attribute' : null)),
  ),
  def(
    { id: 'thin-content', severity: 'notice', category: 'content', title: 'Thin content',
      description: 'The page has fewer words than the configured threshold (default 200).',
      howToFix: 'Expand the page with useful, original information, or consolidate it into a stronger page.' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && !p.ai.jsShell, (p) => (p.wordCount < ctx.options.thresholds.thinWords ? `Only ${p.wordCount} words of content` : null)),
  ),
  def(
    { id: 'duplicate-content', severity: 'warning', category: 'content', title: 'Exact duplicate content',
      description: 'Pages have identical visible text.',
      howToFix: 'Consolidate duplicates with a 301 redirect or point them at a single canonical URL.' },
    (ctx) => duplicateFindings(duplicateGroups(ctx.pages.filter((p) => isIndexableHtml(p) && p.wordCount >= 20), (p) => p.contentHash), 'Page content'),
  ),
  def(
    { id: 'near-duplicate-content', severity: 'notice', category: 'content', title: 'Near-duplicate content',
      description: 'Pages are almost identical (SimHash distance is small), although not byte-for-byte equal. This is a heuristic.',
      howToFix: 'Differentiate the pages, merge them, or canonicalise to the preferred version.' },
    (ctx) => {
      const pages = ctx.pages.filter((p) => isIndexableHtml(p) && p.simhash && p.wordCount >= 50);
      const dist = ctx.options.thresholds.nearDuplicateDistance;
      // pigeonhole: with `dist` differing bits split into dist+1 bands, at least one band is identical
      const nb = dist + 1;
      const width = Math.floor(64 / nb);
      const buckets = new Map<string, number[]>();
      pages.forEach((p, i) => {
        const h = BigInt('0x' + p.simhash!);
        for (let b = 0; b < nb; b++) {
          const bits = b === nb - 1 ? 64 - width * (nb - 1) : width;
          const key = b + ':' + ((h >> BigInt(b * width)) & ((1n << BigInt(bits)) - 1n)).toString(16);
          const arr = buckets.get(key);
          if (arr) arr.push(i);
          else buckets.set(key, [i]);
        }
      });
      const pairs = new Set<string>();
      const near = new Map<number, number[]>();
      for (const idxs of buckets.values()) {
        if (idxs.length < 2 || idxs.length > 2000) continue;
        for (let a = 0; a < idxs.length; a++) for (let c = a + 1; c < idxs.length; c++) {
          const i = idxs[a], j = idxs[c];
          const k = i < j ? `${i}|${j}` : `${j}|${i}`;
          if (pairs.has(k)) continue;
          pairs.add(k);
          const pi = pages[i], pj = pages[j];
          if (pi.contentHash === pj.contentHash) continue; // exact dupes reported by duplicate-content
          if (hamming(pi.simhash!, pj.simhash!) <= dist) {
            near.set(i, [...(near.get(i) ?? []), j]);
            near.set(j, [...(near.get(j) ?? []), i]);
          }
        }
      }
      const out: Finding[] = [];
      for (const [i, js] of near) {
        out.push({ url: pages[i].url, message: `Near-identical to ${js.length} other page(s)`, details: { similar: js.slice(0, 5).map((j) => pages[j].url) } });
      }
      return out;
    },
  ),
  def(
    { id: 'pagination-rel', severity: 'notice', category: 'on-page', title: 'Pagination link relations present',
      description: 'The page declares rel=next/prev. Google no longer uses these hints, though other engines and tools may.',
      howToFix: 'Make sure paginated pages are linked with normal crawlable <a href> links and each has a self-referencing canonical.' },
    (ctx) => perPage(ctx, isOkHtml, (p) => (p.paginationNext || p.paginationPrev ? `rel=${[p.paginationPrev && 'prev', p.paginationNext && 'next'].filter(Boolean).join('/')} declared` : null)),
  ),
  def(
    { id: 'og-missing', severity: 'notice', category: 'on-page', title: 'Open Graph basics missing',
      description: 'og:title, og:description, og:image or og:type is absent, so link previews on social platforms may look poor.',
      howToFix: 'Add the four basic Open Graph meta tags.' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => {
      const missing = ['og:title', 'og:description', 'og:image', 'og:type'].filter((k) => !p.og[k]);
      return missing.length ? { message: `Missing ${missing.join(', ')}`, details: { missing } } : null;
    }),
  ),
  def(
    { id: 'twitter-card-missing', severity: 'notice', category: 'on-page', title: 'Twitter/X card missing',
      description: 'No twitter:card meta tag was found.',
      howToFix: 'Add <meta name="twitter:card" content="summary_large_image"> (other twitter:* tags fall back to Open Graph).' },
    (ctx) => perPage(ctx, isIndexableHtml, (p) => (!p.twitter['twitter:card'] ? 'No twitter:card meta tag' : null)),
  ),
];
