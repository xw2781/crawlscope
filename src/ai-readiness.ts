import type { AiBotStatus, AiReadiness, LlmsFileInfo, PageRecord, ScoreComponent, SitemapFile, SitemapUrl, ParsedRobots } from './types.js';
import { analyzeAiBots } from './ai-bots.js';

export const AI_DISCLAIMER =
  'The score combines hard checks (files, robots.txt rules, markup present in the raw HTML) with heuristics (authorship, summaries, FAQ detection). ' +
  'No AI vendor publishes how it ranks sources, so treat it as a readiness checklist, not a ranking prediction.';

const r1 = (n: number) => Math.round(n * 10) / 10;
const frac = (a: number, b: number) => (b > 0 ? a / b : 0);

export interface AiInput {
  pages: PageRecord[];
  llmsTxt: LlmsFileInfo;
  llmsFullTxt: LlmsFileInfo;
  robotsParsed: ParsedRobots | null;
  robotsMode: 'rules' | 'allow-all' | 'disallow-all';
  sitemaps: SitemapFile[];
  sitemapUrls: SitemapUrl[];
}

export function computeAiReadiness(input: AiInput): AiReadiness {
  const { pages, llmsTxt, llmsFullTxt } = input;
  const html = pages.filter((p) => p.isHtml && p.status === 200 && p.indexable);
  const content = html.filter((p) => !p.ai.jsShell);
  const bots: AiBotStatus[] = analyzeAiBots(input.robotsParsed, input.robotsMode);

  const withJsonLd = content.filter((p) => p.ai.hasJsonLd).length;
  const articleLike = html.filter((p) => p.ai.articleLike);
  const withAuthor = articleLike.filter((p) => p.ai.hasAuthor).length;
  const withDate = articleLike.filter((p) => p.ai.hasDate).length;
  const withMain = html.filter((p) => p.ai.hasMain || p.ai.hasArticle).length;
  const withH1 = html.filter((p) => p.headings.some((h) => h.level === 1 && h.text)).length;
  const jsShell = html.filter((p) => p.ai.jsShell).length;
  const goodRatio = html.filter((p) => p.textRatio === null || p.textRatio >= 0.05).length;
  const restricted = html.filter((p) => p.ai.snippetDirectives.length > 0).length;
  const selfCanon = html.filter((p) => p.canonicals.length === 1 && p.canonicals[0] === p.url).length;
  const allItems = pages.flatMap((p) => p.structuredData);
  const entityTypes = new Set(allItems.filter((i) => !i.parseError).flatMap((i) => i.types));
  const hasEntity = ['Organization', 'WebSite', 'Corporation', 'LocalBusiness', 'Person'].some((t) => entityTypes.has(t));
  const hasRich = [...entityTypes].some((t) => !['Organization', 'WebSite', 'Corporation', 'WebPage', 'ImageObject', 'ListItem'].includes(t));
  const invalidBlocks = allItems.filter((i) => i.parseError).length;
  const orgSameAs = allItems.some((i) => i.types.some((t) => ['Organization', 'Person', 'Corporation', 'LocalBusiness'].includes(t)) && i.data['sameAs'] && (!Array.isArray(i.data['sameAs']) || (i.data['sameAs'] as unknown[]).length > 0));
  const faqLike = html.filter((p) => p.ai.faqLike).length;
  const summaryLike = html.filter((p) => p.ai.summaryLike).length;
  const lastmodTotal = input.sitemapUrls.length;
  const lastmodCount = input.sitemapUrls.filter((u) => u.lastmod).length;
  const lastmodRatio = lastmodTotal ? lastmodCount / lastmodTotal : null;

  const comps: ScoreComponent[] = [];
  // 1. llms.txt (15)
  {
    let s = 0;
    if (llmsTxt.present) s += llmsTxt.valid ? 12 : 6;
    if (llmsFullTxt.present) s += 3;
    comps.push({ id: 'llms', label: 'llms.txt / llms-full.txt', max: 15, score: s,
      note: llmsTxt.present ? (llmsTxt.valid ? 'llms.txt present and valid' : `llms.txt present with ${llmsTxt.problems.length} problem(s)`) : 'llms.txt not found' });
  }
  // 2. crawler access (20)
  {
    const retrieval = bots.filter((b) => b.purpose === 'search' || b.purpose === 'user-fetch');
    const allowedRetrieval = retrieval.filter((b) => b.allowed).length;
    let s = frac(allowedRetrieval, retrieval.length) * 14;
    const training = bots.filter((b) => b.purpose === 'training');
    const explicit = training.some((b) => b.matchedBy === 'explicit');
    const star = input.robotsParsed?.groups.some((g) => g.agents.includes('*')) ?? false;
    s += explicit ? 6 : star ? 3 : 0;
    comps.push({ id: 'bots', label: 'AI crawler access (robots.txt)', max: 20, score: r1(s),
      note: `${allowedRetrieval}/${retrieval.length} search & user-fetch bots allowed; training-bot policy ${explicit ? 'declared explicitly' : star ? 'only via wildcard rules' : 'not declared'} (allow or block both count: it is your choice)` });
  }
  // 3. structured data (20)
  {
    const cov = frac(withJsonLd, content.length);
    const penalty = invalidBlocks ? Math.min(0.5, invalidBlocks / Math.max(1, allItems.length)) : 0;
    const s = cov * 10 * (1 - penalty) + (hasEntity ? 5 : 0) + (hasRich ? 5 : 0);
    comps.push({ id: 'structured-data', label: 'Structured data (JSON-LD)', max: 20, score: r1(s),
      note: `${withJsonLd}/${content.length} pages have JSON-LD; entity markup ${hasEntity ? 'found' : 'missing'}; rich types ${hasRich ? 'found' : 'missing'}${invalidBlocks ? `; ${invalidBlocks} invalid block(s)` : ''}` });
  }
  // 4. authorship & dates (10)
  {
    const s = articleLike.length ? frac(withAuthor, articleLike.length) * 5 + frac(withDate, articleLike.length) * 5 : 5;
    comps.push({ id: 'authorship', label: 'Authorship and dates (heuristic)', max: 10, score: r1(s),
      note: articleLike.length ? `${withAuthor}/${articleLike.length} article-like pages show an author, ${withDate}/${articleLike.length} a date` : 'No article-like pages detected; neutral score' });
  }
  // 5. semantic html (10)
  {
    const s = frac(withMain, html.length) * 6 + frac(withH1, html.length) * 4;
    comps.push({ id: 'semantic-html', label: 'Semantic HTML', max: 10, score: r1(s), note: `${withMain}/${html.length} pages use <main>/<article>; ${withH1}/${html.length} have an H1` });
  }
  // 6. extractability (10)
  {
    const s = (html.length ? (1 - frac(jsShell, html.length)) * 7 + frac(goodRatio, html.length) * 3 : 0);
    comps.push({ id: 'extractability', label: 'Content extractable without JavaScript', max: 10, score: r1(s),
      note: `${jsShell} page(s) look like JavaScript-only shells (heuristic); ${goodRatio}/${html.length} have a healthy text-to-HTML ratio` });
  }
  // 7. snippet controls (5)
  {
    const s = html.length ? 5 * (1 - frac(restricted, html.length)) : 5;
    comps.push({ id: 'snippets', label: 'Snippet and AI-use controls', max: 5, score: r1(s), note: restricted ? `${restricted} page(s) restrict snippets or AI use` : 'No snippet restrictions found' });
  }
  // 8. sitemap & canonicals (10)
  {
    const s = (lastmodRatio === null ? 0 : lastmodRatio * 5) + frac(selfCanon, html.length) * 5;
    comps.push({ id: 'sitemap-canonical', label: 'Sitemap freshness and canonicals', max: 10, score: r1(s),
      note: `${lastmodRatio === null ? 'no sitemap' : Math.round(lastmodRatio * 100) + '% of sitemap URLs have lastmod'}; ${selfCanon}/${html.length} pages have a self-referencing canonical` });
  }

  const score = Math.round(comps.reduce((a, c) => a + c.score, 0));
  return {
    score: Math.max(0, Math.min(100, score)),
    components: comps,
    bots,
    llmsTxt,
    llmsFullTxt,
    stats: {
      htmlPages: html.length, pagesWithJsonLd: withJsonLd, articleLikePages: articleLike.length, articlesWithAuthor: withAuthor, articlesWithDate: withDate,
      pagesWithMain: withMain, jsShellPages: jsShell, faqLikePages: faqLike, summaryLikePages: summaryLike, orgSameAs, sitemapLastmodRatio: lastmodRatio,
    },
    disclaimer: AI_DISCLAIMER,
  };
}
