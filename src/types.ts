/**
 * Core data model for crawlscope. `CrawlResult` is serialised as crawl.json
 * (schemaVersion 1). Reports, diffing and the MCP server all build on these types.
 * Rule of thumb: everything here is plain JSON (no Maps/Dates/BigInts).
 */

export const SCHEMA_VERSION = 1;

export type Severity = 'error' | 'warning' | 'notice';

export type CheckCategory =
  | 'response'
  | 'links'
  | 'on-page'
  | 'indexability'
  | 'international'
  | 'content'
  | 'url'
  | 'site'
  | 'security'
  | 'structured-data'
  | 'ai-readiness';

export interface CrawlOptions {
  url: string;
  maxPages: number | null;
  maxDepth: number | null;
  concurrency: number;
  /** minimum delay between requests to the same host, ms */
  delayMs: number;
  include: string[];
  exclude: string[];
  userAgent: string;
  respectRobots: boolean;
  respectNofollow: boolean;
  subdomains: boolean;
  externalCheck: boolean;
  timeoutMs: number;
  maxBodyBytes: number;
  maxRetries: number;
  /** stop following link-discovered URLs of one path pattern after this many (0 = unlimited); guards against calendar/filter traps */
  maxUrlsPerPattern: number;
  /** cap on how long we honour a Retry-After header, ms */
  maxRetryWaitMs: number;
  sitemapUrls: string[];
  aiBotsCheck: boolean;
  resume: boolean;
  outDir: string | null;
  /** thresholds used by checks */
  thresholds: Thresholds;
}

export interface Thresholds {
  slowMs: number;
  verySlowMs: number;
  largeHtmlBytes: number;
  titleMax: number;
  titleMin: number;
  descMax: number;
  descMin: number;
  thinWords: number;
  urlMaxLength: number;
  deepPage: number;
  nearDuplicateDistance: number;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

export interface FetchErrorInfo {
  /** e.g. TIMEOUT, DNS, ECONNREFUSED, ECONNRESET, TLS, TOO_LARGE, UNKNOWN */
  code: string;
  message: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface HreflangEntry {
  lang: string;
  href: string;
  source: 'html' | 'header' | 'sitemap';
}

export interface ImageInfo {
  src: string;
  /** null = attribute absent; '' = present but empty */
  alt: string | null;
  width: string | null;
  height: string | null;
}

export type SDFormat = 'json-ld' | 'microdata' | 'rdfa';

export interface StructuredDataItem {
  format: SDFormat;
  /** schema.org types (short names, e.g. "Article") */
  types: string[];
  /** properties of the item (JSON-LD object, or flattened microdata/RDFa properties) */
  data: Record<string, unknown>;
  hasContext: boolean;
  parseError?: string;
}

export interface PageRecord {
  /** normalised URL requested */
  url: string;
  /** URL after redirects when the final hop was crawled; equals url if no redirect */
  finalUrl: string;
  /** HTTP status; 0 = not fetched or failed (see fetchError / blockedByRobots) */
  status: number;
  statusText: string;
  /** shortest link distance from the seed (null = unreachable by links, e.g. sitemap-only) */
  depth: number | null;
  discoveredVia: 'seed' | 'link' | 'sitemap' | 'redirect';
  fetchedAt: string;
  blockedByRobots: boolean;
  fetchError: FetchErrorInfo | null;
  /** 304 reuse during incremental re-crawl */
  reusedFromCache: boolean;
  redirectTo: string | null;
  contentType: string | null;
  isHtml: boolean;
  responseTimeMs: number | null;
  /** bytes of body received (or Content-Length for non-parsed bodies) */
  sizeBytes: number | null;
  bodyTruncated: boolean;
  etag: string | null;
  lastModified: string | null;
  /** selected response headers (lowercase names) */
  headers: Record<string, string>;
  xRobotsTag: string | null;

  // ---- HTML-derived (null/empty for non-HTML) ----
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string | null;
  canonicals: string[];
  /** true if any canonical link href was relative in the source HTML */
  canonicalRelative: boolean;
  lang: string | null;
  viewport: string | null;
  headings: HeadingInfo[];
  hreflang: HreflangEntry[];
  images: ImageInfo[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  structuredData: StructuredDataItem[];
  paginationNext: string | null;
  paginationPrev: string | null;
  faviconHref: string | null;
  /** absolute URLs of http:// subresources referenced from an https page */
  mixedContent: string[];
  wordCount: number;
  textBytes: number;
  /** visible text bytes / html bytes */
  textRatio: number | null;
  /** sha256 of normalised visible text (hex, 16 chars) */
  contentHash: string | null;
  /** 64-bit simhash of visible text (hex) */
  simhash: string | null;

  // ---- derived ----
  indexable: boolean;
  indexabilityReason: string;
  noindex: boolean;
  nofollow: boolean;
  inlinks: number;
  uniqueInlinkSources: number;
  outlinksInternal: number;
  outlinksExternal: number;
  inSitemap: boolean;

  /** <meta http-equiv=refresh> redirect, if any */
  metaRefresh?: { delay: number; url: string | null } | null;
  /** rel=canonical from the HTTP Link header (also merged into `canonicals`) */
  canonicalHeader?: string | null;
  /** iframe and srcset URLs: recorded but never crawled */
  resources?: { iframes: string[]; srcset: string[] };
  /** character set used to decode the body */
  charset?: string | null;

  /** every <script src> on the page (absent in crawls made before v0.2) */
  scripts?: PageScript[];
  /** Content-Security-Policy state (absent for non-HTML pages and older crawls) */
  csp?: PageCsp;

  /** AI-readiness related page signals (heuristics, see docs) */
  ai: PageAiSignals;
}

export interface PageScript {
  /** absolute URL */
  url: string;
  host: string;
  /** host is outside the site's registrable domain (subdomains of the start host are first-party) */
  thirdParty: boolean;
  /** has a non-empty integrity attribute (Subresource Integrity) */
  sri: boolean;
  /** value of the crossorigin attribute ('' when present without value), null when absent */
  crossorigin: string | null;
}

export interface PageCsp {
  /** an enforcing policy exists (header or <meta http-equiv>) */
  enforced: boolean;
  /** a Content-Security-Policy-Report-Only header exists */
  reportOnly: boolean;
  source: 'header' | 'meta' | 'both' | null;
}

export interface ThirdPartyHost {
  host: string;
  /** label from the built-in list, or null when unknown */
  category: ThirdPartyCategory | null;
  /** well-known snippet that is generated dynamically, so SRI cannot be used */
  dynamic: boolean;
  pages: number;
  scripts: number;
  withSri: number;
  /** share (0-1) of this host's script tags that carry integrity */
  sriCoverage: number;
  /** up to 3 script URLs */
  exampleScripts: string[];
  /** up to 3 pages loading it */
  examplePages: string[];
  /** some pages load it over http:// */
  insecure: boolean;
}

export type ThirdPartyCategory = 'experimentation' | 'tag-manager' | 'analytics' | 'advertising' | 'consent' | 'cdn' | 'social' | 'support-chat' | 'monitoring' | 'payments' | 'video';

export interface ThirdPartyInventory {
  /** HTML pages that were analysed for scripts */
  pagesScanned: number;
  hosts: ThirdPartyHost[];
  totalScripts: number;
  thirdPartyScripts: number;
  thirdPartyWithSri: number;
  pagesWithThirdParty: number;
  csp: { enforced: number; reportOnly: number; none: number };
}

export interface PageAiSignals {
  hasMain: boolean;
  hasArticle: boolean;
  hasAuthor: boolean;
  hasDate: boolean;
  datePublished: string | null;
  dateModified: string | null;
  hasJsonLd: boolean;
  faqLike: boolean;
  summaryLike: boolean;
  jsShell: boolean;
  scriptCount: number;
  /** snippet-control directives found: nosnippet, max-snippet:N, noai, noimageai, data-nosnippet */
  snippetDirectives: string[];
  articleLike: boolean;
}

export interface LinkRecord {
  from: string;
  /** normalised target URL */
  to: string;
  type: 'a' | 'redirect';
  anchor: string;
  /** rel tokens, lowercase */
  rel: string[];
  nofollow: boolean;
  internal: boolean;
  /** true when anchor contains only an image (no text) */
  imageOnly: boolean;
}

export interface Finding {
  url: string;
  message: string;
  /** optional severity override (rare) */
  severity?: Severity;
  details?: Record<string, unknown>;
}

export interface CheckMeta {
  id: string;
  severity: Severity;
  category: CheckCategory;
  title: string;
  description: string;
  howToFix: string;
}

export interface Issue {
  checkId: string;
  severity: Severity;
  category: CheckCategory;
  /** the URL the issue is reported on */
  url: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}
export interface RobotsWarning {
  line: number;
  message: string;
}
export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  warnings: RobotsWarning[];
}
export interface RobotsInfo {
  url: string;
  status: number | null;
  present: boolean;
  fetchError: string | null;
  /** how crawlers treat it: parsed rules, allow-all (4xx) or disallow-all (5xx / unreachable) */
  mode: 'rules' | 'allow-all' | 'disallow-all';
  sizeBytes: number | null;
  parsed: ParsedRobots | null;
  /** raw text, truncated to 64KiB in crawl.json */
  raw: string | null;
}

export interface SitemapFile {
  url: string;
  source: 'robots' | 'default' | 'option' | 'index';
  kind: 'urlset' | 'index' | 'unknown';
  status: number | null;
  gzip: boolean;
  urlCount: number;
  lastmodCount: number;
  children: string[];
  error: string | null;
}
export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  sitemap: string;
}

export interface LlmsFileInfo {
  url: string;
  status: number | null;
  present: boolean;
  sizeBytes: number | null;
  contentType: string | null;
  valid: boolean;
  /** format problems per llmstxt.org (llms.txt only) */
  problems: string[];
  title: string | null;
  summary: string | null;
  sections: { name: string; links: number }[];
  linkCount: number;
  brokenLinks: string[];
  checkedLinks: number;
}

export type BotPurpose = 'training' | 'search' | 'user-fetch' | 'mixed';
export interface AiBotStatus {
  bot: string;
  vendor: string;
  purpose: BotPurpose;
  allowed: boolean;
  /** some paths disallowed but "/" allowed */
  partial: boolean;
  matchedBy: 'explicit' | 'wildcard' | 'none';
  note: string;
}

export interface ScoreComponent {
  id: string;
  label: string;
  score: number;
  max: number;
  note: string;
}
export interface AiReadiness {
  score: number;
  components: ScoreComponent[];
  bots: AiBotStatus[];
  llmsTxt: LlmsFileInfo;
  llmsFullTxt: LlmsFileInfo;
  stats: {
    htmlPages: number;
    pagesWithJsonLd: number;
    articleLikePages: number;
    articlesWithAuthor: number;
    articlesWithDate: number;
    pagesWithMain: number;
    jsShellPages: number;
    faqLikePages: number;
    summaryLikePages: number;
    orgSameAs: boolean;
    sitemapLastmodRatio: number | null;
  };
  /** reminder shown to users: signals are heuristics */
  disclaimer: string;
}

export interface ExternalLinkResult {
  url: string;
  status: number | null;
  error: string | null;
  method: 'HEAD' | 'GET';
  /** pages linking to it (first 20) */
  linkedFrom: string[];
}

export interface SiteProbes {
  soft404: { url: string; status: number | null } | null;
  httpRedirect: { tested: boolean; startUrl: string; status: number | null; location: string | null; redirectsToHttps: boolean } | null;
  favicon: { url: string; status: number | null; declaredInHtml: boolean } | null;
  hsts: string | null;
  isHttps: boolean;
  /** path patterns that hit --max-urls-per-pattern */
  trapPatterns?: { pattern: string; skipped: number; example: string }[];
}

export interface CrawlSummary {
  pagesCrawled: number;
  htmlPages: number;
  indexablePages: number;
  issuesTotal: number;
  bySeverity: Record<Severity, number>;
  byCheck: { checkId: string; severity: Severity; count: number }[];
  statusCodes: Record<string, number>;
  healthScore: number;
  aiReadinessScore: number | null;
  slowestPages: { url: string; responseTimeMs: number }[];
  avgResponseTimeMs: number | null;
  maxDepth: number;
  internalLinks: number;
  externalLinks: number;
  sitemapUrls: number;
  /** third-party script inventory (absent in crawls made before v0.2) */
  thirdPartyScripts?: ThirdPartyInventory;
}

export interface CrawlResult {
  schemaVersion: 1;
  tool: { name: 'crawlscope'; version: string };
  id: string;
  seed: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 'partial' = interrupted or stopped; max-pages truncation sets truncated=true but status stays complete */
  status: 'complete' | 'partial';
  truncated: boolean;
  options: Omit<CrawlOptions, 'outDir'>;
  summary: CrawlSummary;
  pages: PageRecord[];
  links: LinkRecord[];
  issues: Issue[];
  checks: CheckMeta[];
  robots: RobotsInfo;
  sitemaps: SitemapFile[];
  sitemapUrls: SitemapUrl[];
  aiReadiness: AiReadiness | null;
  externalLinks: ExternalLinkResult[];
  site: SiteProbes;
}

export interface CheckContext {
  options: CrawlOptions;
  seed: string;
  pages: PageRecord[];
  pageByUrl: Map<string, PageRecord>;
  links: LinkRecord[];
  inlinksByUrl: Map<string, LinkRecord[]>;
  outlinksByUrl: Map<string, LinkRecord[]>;
  robots: RobotsInfo;
  sitemaps: SitemapFile[];
  sitemapUrls: SitemapUrl[];
  sitemapUrlSet: Set<string>;
  externalLinks: ExternalLinkResult[];
  site: SiteProbes;
  aiReadiness: AiReadiness | null;
  /** whole site was crawled (no max-pages / max-depth truncation) */
  complete: boolean;
}

export interface CheckDef extends CheckMeta {
  run(ctx: CheckContext): Finding[];
}
