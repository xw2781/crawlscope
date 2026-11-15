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
  "summary": { /* CrawlSummary: counts by severity/check, status codes, health score ... */ },
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

## Companion files in a crawl directory

| File | Purpose |
| --- | --- |
| `crawl.json` | the full result above |
| `pages.csv`, `issues.csv`, `links.csv` | spreadsheet exports (formula-injection safe) |
| `state.jsonl` | one `{page, links}` JSON object per line; powers `--resume` and conditional re-crawls |

`--resume` semantics: if the previous `crawl.json` is `complete` and not `truncated`, pages are revalidated with
`If-None-Match`/`If-Modified-Since` (a 304 reuses stored data, `reusedFromCache: true`). Otherwise the stored pages are
reused without network access and the crawl continues from the frontier.
