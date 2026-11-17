---
name: crawlscope
description: Audit a website's SEO and AI-search (GEO/AEO) readiness with the crawlscope crawler. Use when asked to crawl or audit a site, find broken links, missing titles/canonicals, indexability problems, check llms.txt / AI-bot access, verify SEO fixes, or compare two crawls.
---

# crawlscope: site audits for agents

crawlscope is a free, local crawler. Use the MCP tools if the `crawlscope` MCP server is connected; otherwise use the CLI.
Only crawl sites the user owns or is allowed to crawl. Never disable robots.txt unless the user states they own the site.

## With MCP tools (preferred)

1. `crawl_site {url, max_pages: 200}`: saves a crawl and returns `crawl_id`, scores and top issue types.
   If `truncated` is true, tell the user coverage is partial and offer a bigger `max_pages`.
2. `get_crawl_summary` then `list_issues {severity: "error"}`; group by `check` and fix the most frequent first.
3. `list_issues {check_id}` shows affected URLs plus the how-to-fix text; `get_page {url}` shows one page in full.
4. `find_pages {missing: "title"}`, `{status_class: "4xx"}`, `{min_response_ms: 1000}` for lists of pages.
5. After changes are deployed, run `crawl_site` again and `diff_crawls`: report resolved vs new issues, not just totals.
6. GEO/AEO questions: `check_ai_readiness {url}` (llms.txt, AI-bot access, structured data); `check_robots_url {url, user_agent: "GPTBot"}`.
7. Supply-chain questions ("which third-party scripts do we load?"): `get_crawl_summary` returns `thirdPartyScripts` (hosts, pages, SRI coverage); `list_issues {check_id: "third-party-script-no-sri"}` (also `insecure-script`, `csp-missing`, `csp-report-only`). SRI cannot be used for dynamic snippets such as Optimizely or GTM; recommend CSP instead.

Keep outputs small: use `limit`, filters, and summarise for the user instead of pasting raw JSON.

## With the CLI

```bash
npx -y crawlscope crawl https://example.com --max-pages 200 --json -o ./crawl-before   # JSON summary on stdout, logs on stderr
npx -y crawlscope crawl https://example.com --max-pages 200 --json -o ./crawl-after --fail-on error   # exit 1 if errors remain
npx -y crawlscope diff ./crawl-before ./crawl-after --json
npx -y crawlscope llms https://example.com --json
```

Details live in `<out>/crawl.json` (schema: docs/schema.md in the crawlscope repo); read it with `jq` or a script rather than printing it whole.
Exit codes: 0 ok, 1 `--fail-on` threshold hit, 2 usage error.

## Reporting

Lead with the score and the three to five issue types that matter most, give example URLs, and say what to change.
Mention what crawlscope cannot see: JavaScript-rendered content is not executed, and the AI-readiness score contains heuristics.
