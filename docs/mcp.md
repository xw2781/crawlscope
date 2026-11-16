# MCP server

`crawlscope mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over **stdio**. It lets an AI agent crawl a
site, read the results in small pieces, and diff crawls, all locally. No account, no network service of ours: the server only talks to
the sites you ask it to crawl.

Crawls are stored under `~/.crawlscope` (override with the `CRAWLSCOPE_DATA_DIR` environment variable or `crawlscope mcp --data-dir DIR`).
Each crawl is a normal crawlscope directory (`crawl.json`, CSVs, `report.html`), so the CLI, `crawlscope ui` and `crawlscope diff` can open them too.

## Setup

Requires Node 20+. Until the package is published to npm, replace `npx -y crawlscope` with `node /path/to/crawlscope/dist/cli.js`
(after `npm run build`) or install a tarball with `npm pack && npm i -g ./crawlscope-*.tgz` and use `crawlscope`.

### Claude Code

```bash
claude mcp add crawlscope -- npx -y crawlscope mcp
# custom data directory:
claude mcp add crawlscope -e CRAWLSCOPE_DATA_DIR=$HOME/seo-crawls -- npx -y crawlscope mcp
```

Or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "crawlscope": { "command": "npx", "args": ["-y", "crawlscope", "mcp"] }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "crawlscope": { "command": "npx", "args": ["-y", "crawlscope", "mcp"] }
  }
}
```

### Codex CLI

```bash
codex mcp add crawlscope -- npx -y crawlscope mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.crawlscope]
command = "npx"
args = ["-y", "crawlscope", "mcp"]
```

### Any other MCP client (generic JSON)

```json
{
  "mcpServers": {
    "crawlscope": {
      "command": "npx",
      "args": ["-y", "crawlscope", "mcp"],
      "env": { "CRAWLSCOPE_DATA_DIR": "/absolute/path/for/crawls" }
    }
  }
}
```

Quick check without a client: `npx @modelcontextprotocol/inspector npx -y crawlscope mcp`.

## Tools

| Tool | What it does |
|---|---|
| `crawl_site` | Crawl a site and save it. Agent-safe defaults: `max_pages` 200, 250 ms delay, 4 connections, 10-minute time limit, crawl-trap guard. Sends progress notifications; cancelling the call stops the crawl gracefully and keeps the partial result. Returns a compact summary and a `crawl_id`. |
| `get_crawl_summary` | Health and AI-readiness scores, issue counts by severity, top issue types. |
| `list_crawls` | Saved crawls (newest first). |
| `list_issues` | Issues with filters (`severity`, `check_id`, `category`, `url_contains`), per-check counts, paging (`limit`, `offset`). With `check_id` it includes the how-to-fix text. |
| `get_page` | Everything about one URL: status, indexability, title/description/headings, canonicals, hreflang, structured data, its issues (with fixes), inbound/outbound links (capped). Accepts a full URL or a path such as `/about`. |
| `find_pages` | Filter and sort pages (status, indexable, missing title/description/H1/canonical, depth, response time, word count, URL/title text). |
| `audit_url` | Single-URL audit, nothing saved. |
| `check_ai_readiness` | GEO/AEO check for a site: llms.txt, per-bot robots.txt access for 21 AI crawlers, structured data, authorship/dates, JS-only shells. Nothing saved. |
| `check_robots_url` | Is a URL allowed for a given user agent? Shows the deciding robots.txt rule (RFC 9309). |
| `diff_crawls` | Compare two crawls (default: latest vs the previous crawl of the same site). |
| `export_report` | Write `report.html`, the CSV files or confirm `crawl.json`; returns absolute paths. |

`crawl_id` arguments accept a crawl name, `latest`, or a host/URL (latest crawl of that host).

**Resources:** `crawlscope://crawls/latest/summary` and `crawlscope://crawls/{id}/summary`.

### Output conventions

* JSON text, compact. Lists are capped (`limit`, default 25) and say how many more exist plus the argument to fetch them (`hint`).
  Any response over ~24,000 characters is cut with a note, so a bad query cannot flood the agent's context.
* Failures (bad URL, unknown crawl, invalid regex, unreachable robots.txt...) come back as MCP tool errors (`isError: true`) with a
  message that says what to do next. The server does not exit on errors.
* Only one `crawl_site` runs at a time per server process.

### Safety notes

* The server obeys robots.txt and cannot be told to ignore it. It can reach any URL the machine can reach (including `localhost` and
  private networks), like the CLI. Only point agents at sites you are allowed to crawl.
* stdout is reserved for the protocol; diagnostics go to stderr.
