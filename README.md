# crawlscope

Free, open-source (MIT), local SEO crawler with modern **GEO/AEO** (AI-readiness) checks and an agent-friendly JSON interface.
No URL limits, no accounts, no telemetry: it runs on your machine and writes plain files.

> **Status: milestone 1 of 3.** The crawler, 90+ checks, AI-readiness score, CLI, JSON and CSV outputs are done.
> `report` (HTML), `diff`, `ui` and `mcp` are registered but print "coming in a later milestone".

## Install

```bash
npm install -g crawlscope      # once published; until then: npm pack && npm i -g ./crawlscope-0.1.0.tgz
crawlscope crawl https://example.com --max-pages 200
```

Requires Node ≥ 20.

## Usage

```bash
crawlscope crawl <url> [--out dir] [--max-pages N] [--max-depth N] [--concurrency 4] [--delay 250]
                       [--include regex ...] [--exclude regex ...] [--subdomains] [--external-check]
                       [--sitemap url ...] [--respect-nofollow] [--timeout ms] [--user-agent s]
                       [--no-robots --i-own-this-site] [--resume] [--ai-bots-check]
                       [--json] [--fail-on error|warning]
crawlscope llms <url>          # quick AI-readiness check (alias: ai-readiness); add --json
```

Output directory (default `./crawlscope-data/<host>-<timestamp>`): `crawl.json` ([schema](docs/schema.md)), `pages.csv`,
`issues.csv`, `links.csv`, `state.jsonl`.

* `--json` prints a compact machine-readable summary to stdout only; progress and logs go to stderr.
* `--fail-on error|warning` exits 1 when issues of that severity or worse exist (CI gate).
* `--resume` continues an interrupted crawl, or re-crawls incrementally using stored ETag / Last-Modified.

## Responsible crawling

crawlscope obeys robots.txt (RFC 9309: longest-match Allow/Disallow, `*` and `$`, user-agent group selection, `Crawl-delay`
as a per-host minimum), keeps a per-host delay and concurrency cap, backs off on 429/503 (honouring `Retry-After`), caps body
size and never crawls external sites (`--external-check` only sends HEAD/GET requests to outbound link targets).
A 5xx or unreachable robots.txt is treated as "disallow all", as the RFC requires. `--no-robots` needs `--i-own-this-site`;
use it only on sites you are authorised to crawl.

## What it checks

Response and redirects, broken links, on-page SEO (titles, descriptions, headings, images, canonicals, hreflang, duplicates and
near-duplicates, thin content, URL hygiene, Open Graph/Twitter), indexability (noindex, robots blocks, sitemap conflicts),
site-level (sitemaps incl. index and gzip, orphans, depth, robots.txt syntax, HTTPS/HSTS, favicon, soft-404 probe),
structured data (JSON-LD/microdata/RDFa extraction; required/recommended properties for Organization, WebSite, Article, Product,
BreadcrumbList, FAQPage, LocalBusiness, Person, Event, Recipe, VideoObject), and **AI readiness**: `llms.txt`/`llms-full.txt`
validation, per-bot robots.txt status for 21 AI crawlers (training vs search vs user-fetch), JSON-LD coverage, authorship/dates,
semantic HTML, JS-only shells, snippet controls, sitemap `lastmod`. The 0–100 AI score mixes hard checks with heuristics and says
so in its output. Every check lives in `src/checks/` with an id, severity, description and how-to-fix text (also embedded in `crawl.json`).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs unit tests and integration tests against a deliberately flawed local
fixture site (`test/fixtures/site`).

## Clean-room statement

crawlscope is an independent implementation based on public specifications and documentation (RFC 9309, sitemaps.org,
schema.org, Google Search Central, llmstxt.org). It does not copy code, wording, UI or assets from other crawlers.

## License

MIT
