import type { CheckDef, Finding } from '../types.js';
import { def, isIndexableHtml, perPage } from './helpers.js';

export const aiChecks: CheckDef[] = [
  def(
    { id: 'llms-txt-missing', severity: 'notice', category: 'ai-readiness', title: 'No llms.txt',
      description: 'No /llms.txt file was found. It is an emerging convention (llmstxt.org) that points AI tools at your best content; support by AI vendors is not guaranteed.',
      howToFix: 'Publish /llms.txt: an H1 with the site name, a blockquote summary, and H2 sections listing key pages as "- [Title](url): notes".' },
    (ctx) => (ctx.aiReadiness && !ctx.aiReadiness.llmsTxt.present ? [{ url: ctx.aiReadiness.llmsTxt.url, message: `llms.txt not found (HTTP ${ctx.aiReadiness.llmsTxt.status ?? 'error'})` }] : []),
  ),
  def(
    { id: 'llms-txt-invalid', severity: 'warning', category: 'ai-readiness', title: 'llms.txt format problems',
      description: 'llms.txt exists but deviates from the llmstxt.org structure or contains dead links.',
      howToFix: 'Follow the format: one H1, a blockquote summary, H2 sections of markdown link lists, working URLs.' },
    (ctx) => {
      const l = ctx.aiReadiness?.llmsTxt;
      return l && l.present && l.problems.length ? [{ url: l.url, message: `${l.problems.length} problem(s); first: ${l.problems[0]}`, details: { problems: l.problems } }] : [];
    },
  ),
  def(
    { id: 'llms-full-missing', severity: 'notice', category: 'ai-readiness', title: 'No llms-full.txt',
      description: 'No /llms-full.txt (a single markdown file with the full documentation text) was found. It is optional.',
      howToFix: 'If you maintain documentation, publish its full text as /llms-full.txt.' },
    (ctx) => (ctx.aiReadiness && !ctx.aiReadiness.llmsFullTxt.present ? [{ url: ctx.aiReadiness.llmsFullTxt.url, message: 'llms-full.txt not found' }] : []),
  ),
  def(
    { id: 'ai-search-bot-blocked', severity: 'warning', category: 'ai-readiness', title: 'AI search / retrieval crawler blocked',
      description: 'robots.txt blocks a crawler that fetches pages to show in AI answers. Blocking training crawlers is a separate, legitimate choice; blocking search/user-fetch bots removes you from AI answer citations.',
      howToFix: 'Allow the search and user-fetch bots (e.g. OAI-SearchBot, Claude-SearchBot, PerplexityBot) if you want AI visibility, while blocking only training bots if desired.' },
    (ctx) => (ctx.aiReadiness?.bots ?? []).filter((b) => !b.allowed && (b.purpose === 'search' || b.purpose === 'user-fetch'))
      .map((b): Finding => ({ url: ctx.robots.url, message: `${b.bot} (${b.vendor}, ${b.purpose}) is blocked`, details: { bot: b.bot, purpose: b.purpose, matchedBy: b.matchedBy } })),
  ),
  def(
    { id: 'ai-no-structured-data', severity: 'notice', category: 'ai-readiness', title: 'No JSON-LD structured data',
      description: 'The page has no valid JSON-LD, which gives machines explicit facts about the page.',
      howToFix: 'Add JSON-LD describing the page (Article, Product, FAQPage, Organization…).' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && !p.ai.jsShell, (p) => (!p.ai.hasJsonLd ? 'No valid JSON-LD found' : null)),
  ),
  def(
    { id: 'ai-missing-author', severity: 'notice', category: 'ai-readiness', title: 'Article without clear authorship',
      description: 'Heuristic: no author markup (meta author, rel=author, itemprop or JSON-LD author) was detected on an article-like page.',
      howToFix: 'Show a byline and mark it up with JSON-LD author (Person) and a link to an author page.' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && p.ai.articleLike, (p) => (!p.ai.hasAuthor ? 'No author signal detected' : null)),
  ),
  def(
    { id: 'ai-missing-date', severity: 'notice', category: 'ai-readiness', title: 'Article without publication date',
      description: 'Heuristic: no publication date (time[datetime], meta, JSON-LD datePublished) was detected on an article-like page.',
      howToFix: 'Show the publish/update date and include datePublished/dateModified in JSON-LD.' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && p.ai.articleLike, (p) => (!p.ai.hasDate ? 'No publication date signal detected' : null)),
  ),
  def(
    { id: 'ai-no-semantic-main', severity: 'notice', category: 'ai-readiness', title: 'No <main> or <article> landmark',
      description: 'Semantic landmarks help machines separate the main content from navigation and boilerplate.',
      howToFix: 'Wrap primary content in <main> (and articles in <article>).' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && !p.ai.jsShell, (p) => (!p.ai.hasMain && !p.ai.hasArticle ? 'Neither <main> nor <article> found' : null)),
  ),
  def(
    { id: 'ai-js-shell', severity: 'warning', category: 'ai-readiness', title: 'Content may require JavaScript',
      description: 'Heuristic: the raw HTML has almost no text but loads scripts, so crawlers that do not run JavaScript (many AI fetchers) may see an empty page.',
      howToFix: 'Server-render or pre-render the main content so it is present in the initial HTML.' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && p.ai.jsShell, (p) => `Only ${p.wordCount} words in raw HTML with ${p.ai.scriptCount} script(s)`),
  ),
  def(
    { id: 'ai-snippet-restricted', severity: 'notice', category: 'ai-readiness', title: 'Snippet/AI-use restrictions present',
      description: 'The page uses nosnippet, max-snippet, noai/noimageai or data-nosnippet, which limit how excerpts can be shown or reused.',
      howToFix: 'Keep these only where intended; they reduce visibility in AI answers and snippets.' },
    (ctx) => perPage(ctx, (p) => isOkHtml2(p) && p.ai.snippetDirectives.length > 0, (p) => ({ message: `Directives: ${p.ai.snippetDirectives.join(', ')}`, details: { directives: p.ai.snippetDirectives } })),
  ),
  def(
    { id: 'ai-low-text-ratio', severity: 'notice', category: 'ai-readiness', title: 'Very low text-to-HTML ratio',
      description: 'Visible text is a tiny share of the HTML payload, making extraction harder and pages heavier.',
      howToFix: 'Reduce inline scripts/styles/markup bloat and move boilerplate out of the document.' },
    (ctx) => perPage(ctx, (p) => isIndexableHtml(p) && (p.sizeBytes ?? 0) > 20_000 && p.textRatio !== null && p.textRatio < 0.03, (p) => `Text is ${(p.textRatio! * 100).toFixed(1)}% of ${(p.sizeBytes! / 1024).toFixed(0)} KB HTML`),
  ),
  def(
    { id: 'ai-no-sameas', severity: 'notice', category: 'ai-readiness', title: 'No sameAs links in Organization/Person markup',
      description: 'Organization or Person structured data with sameAs links to official profiles helps machines disambiguate the entity.',
      howToFix: 'Add "sameAs": [profile URLs] to your Organization/Person JSON-LD.' },
    (ctx) => (ctx.aiReadiness && !ctx.aiReadiness.stats.orgSameAs && ctx.pages.some((p) => p.isHtml && p.status === 200) ? [{ url: ctx.seed, message: 'No Organization/Person JSON-LD with sameAs found on crawled pages' }] : []),
  ),
  def(
    { id: 'ai-sitemap-lastmod-missing', severity: 'notice', category: 'ai-readiness', title: 'Sitemap lacks lastmod',
      description: 'Most sitemap entries have no <lastmod>, which weakens freshness signals for crawlers.',
      howToFix: 'Emit accurate <lastmod> values (only update them when content really changes).' },
    (ctx) => {
      const r = ctx.aiReadiness?.stats.sitemapLastmodRatio;
      return r !== null && r !== undefined && r < 0.5 ? [{ url: ctx.sitemaps[0]?.url ?? ctx.seed, message: `Only ${Math.round(r * 100)}% of sitemap URLs have lastmod` }] : [];
    },
  ),
];

function isOkHtml2(p: { isHtml: boolean; status: number }): boolean {
  return p.isHtml && p.status === 200;
}
