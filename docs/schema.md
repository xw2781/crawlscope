# crawl.json schema (version 1)

`crawl.json` is the full, machine-readable result of a crawl. It is plain JSON (no dates/maps/bigints),
and the authoritative TypeScript definition is `CrawlResult` in [`src/types.ts`](../src/types.ts).
Every consumer (reports, diff, MCP) must check `schemaVersion` first; breaking changes bump it.

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "crawlscope", "version": "0.1.0" },
  "id": "example.com-20260101120000-ab12",
  "seed": "https://example.com/",
  "startedAt": "ISO-8601", "finishedAt": "ISO-8601", "durationMs": 1234,
  "status": "complete",          // or "partial" (interrupted)
  "truncated": false,            // true when --max-pages stopped the crawl early
  "options": { /* CrawlOptions without outDir */ },
  "summary": { /* CrawlSummary: counts by severity/check, status codes, health score, thirdPartyScripts ... */ },
  "pages": [ /* PageRecord */ ],
  "links": [ /* LinkRecord */ ],
  "issues": [ /* Issue */ ],
  "checks": [ /* CheckMeta: id, severity, category, title, description, howToFix */ ],
  "robots": { /* RobotsInfo for the start origin */ },
  "sitemaps": [ /* SitemapFile */ ], "sitemapUrls": [ /* SitemapUrl */ ],
  "aiReadiness": { /* AiReadiness: score, components, bots, llmsTxt, llmsFullTxt, stats */ },
  "externalLinks": [ /* ExternalLinkResult (only with --external-check) */ ],
  "site": { /* SiteProbes: soft-404 probe, http->https, favicon, HSTS */ }
}
```

## Conventions

* **URLs** are normalised (see `normalizeUrl`): lowercase host, no fragment, no default port, `/` for an empty path.
  `PageRecord.url` is the key used everywhere (`LinkRecord.from/to`, `Issue.url`, hreflang/canonical targets).
* **`PageRecord.status`**: HTTP status; `0` means not fetched (blocked by robots, see `blockedByRobots`) or failed (see `fetchError`).
* **Redirects** are not followed inline. A 3xx page records `redirectTo`; the target is crawled as its own page, and a
  `LinkRecord` with `type: "redirect"` connects them. Chains/loops are derived from these records.
* **`depth`** is the shortest click distance from the start page over internal links (`null` = unreachable, e.g. sitemap-only).
* **`indexable`** is true for a 200 HTML page without noindex whose canonical is absent or self-referencing.
* **Issues** are `{ checkId, severity, category, url, message, details? }`; look up the check's wording in `checks[]`.
  Link-level issues (e.g. `broken-internal-link`) are reported on the *source* page, with the target in `details`.
* **AI readiness** mixes hard checks and heuristics; `aiReadiness.disclaimer` says so and consumers should repeat it.

## Third-party scripts and CSP

Added in 0.2 as optional fields (absent in older crawls; checks skip them, no schema bump).

* `PageRecord.scripts[]`: one entry per distinct `<script src>` (http/https only, max 300): `{ url, host, thirdParty, sri, crossorigin }`.
  `thirdParty` compares registrable domains (small built-in multi-part suffix list, not the full PSL) against the start URL, so subdomains are first-party.
  `sri` is true for a non-empty `integrity` attribute; `crossorigin` is the attribute value (`""` if bare) or `null`.
* `PageRecord.csp`: `{ enforced, reportOnly, source }`. `enforced` = `Content-Security-Policy` header or `<meta http-equiv>`;
  `reportOnly` = `Content-Security-Policy-Report-Only` header; `source` = `header` | `meta` | `both` | `null`. Both headers are also kept in `headers`.
* `summary.thirdPartyScripts`: `{ pagesScanned, hosts[], totalScripts, thirdPartyScripts, thirdPartyWithSri, pagesWithThirdParty, csp: { enforced, reportOnly, none } }`.
  Each host: `{ host, category, dynamic, pages, scripts, withSri, sriCoverage, exampleScripts, examplePages, insecure }`.
  `category` comes from a built-in list (`experimentation`, `tag-manager`, `analytics`, `advertising`, `consent`, `cdn`, `social`, `support-chat`, `monitoring`, `payments`, `video`) or is `null`;
  `dynamic` marks snippets whose content changes server-side, where SRI is impractical.
* Checks: `third-party-script-no-sri`, `insecure-script`, `csp-missing`, `csp-report-only` (category `security`).

## Server version disclosure

`server-version-disclosure` (category `security`, severity `warning`) uses `PageRecord.headers`; `x-aspnet-version` and `x-aspnetmvc-version` are now kept alongside `server` and `x-powered-by`.
One issue per host: `details` = `{ host, headers: { <header>: [values] }, versions: [tokens], pages, examplePages }`.

## Companion files in a crawl directory

| File | Purpose |
| --- | --- |
| `crawl.json` | the full result above |
| `pages.csv`, `issues.csv`, `links.csv` | spreadsheet exports (formula-injection safe) |
| `report.html` | self-contained HTML report (see below) |
| `state.jsonl` | one `{page, links}` JSON object per line; powers `--resume` and conditional re-crawls |

`--resume` semantics: if the previous `crawl.json` is `complete` and not `truncated`, pages are revalidated with
`If-None-Match`/`If-Modified-Since` (a 304 reuses stored data, `reusedFromCache: true`). Otherwise the stored pages are
reused without network access and the crawl continues from the frontier.

## Report data and diff payloads

`report.html` embeds a compact, columnar projection of `crawl.json` (`ReportData` in [`src/report/data.ts`](../src/report/data.ts)) in a
`<script id="cs-data" type="application/json">` element: URL/string tables plus parallel arrays per page column, issues as
`{c, u, m}` columns, links as `[from, to, anchor, flags]` quads (capped at 400k, flagged by `linksTruncated`), and per-page detail
as JSON strings parsed lazily when the drawer opens. It is an internal format and may change; `crawl.json` is the stable contract.

`crawlscope diff --json` prints a `CrawlDiff` (`src/diff.ts`, `schemaVersion: 1`): `a`/`b` crawl refs, `pages.{added,removed,changed,unchanged}`,
`issues.{added,resolved,persisting}`, `byCheck[]`, `deltas`, `fieldCounts` and `totals`. Page lists are truncated to `limit` (5000) entries;
`totals` always has the true counts. Pages match on path when the URL is on the crawl's own origin, otherwise on the full URL.
Issues match on check id + page, exact message first; a same-check, same-page issue whose message changed counts as persisting.

## Progress hooks

`crawl(options, hooks)` accepts `onProgress({crawled, queued, url, status, errors, active, responseTimeMs, depth, elapsedMs})`,
`onPhase('starting'|'robots'|'sitemaps'|'crawling'|'probes'|'external'|'analyzing'|'done')`, `onLog` and an `AbortSignal`.
All hooks are optional and the extra `onProgress` fields are additive.
