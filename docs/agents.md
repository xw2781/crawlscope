# Using crawlscope from a coding agent

Two interfaces, same data: the **CLI with `--json`** and the **[MCP server](mcp.md)**. Prefer MCP when the client supports it
(small, filterable answers); use the CLI in scripts, CI and agents without MCP.

## CLI contract

```bash
npx -y crawlscope crawl https://staging.example.com --max-pages 300 --json -o ./crawls/before > summary.json
```

* **stdout** gets one JSON document and nothing else; progress and logs go to **stderr**.
* Exit codes: `0` success, `1` `--fail-on error|warning` threshold hit, `2` usage/validation error, `130` interrupted.
* The summary JSON contains `id`, `seed`, `status`, `truncated`, `outDir`, `files`, `summary` (pages, `healthScore`,
  `aiReadinessScore`, `issuesTotal`, `bySeverity`, `statusCodes`) and `topIssues` (check ids with counts).
* Full detail is in `<outDir>/crawl.json` ([schema](schema.md)); `issues.csv` and `pages.csv` are easy to grep.

Useful `jq` queries on `crawl.json`:

```bash
jq -r '.issues[] | select(.severity=="error") | [.checkId,.url,.message] | @tsv' crawls/before/crawl.json | head -50
jq -r '.pages[] | select(.status>=400) | "\(.status) \(.url)"' crawls/before/crawl.json
jq '.checks[] | select(.id=="canonical-missing") | .howToFix' crawls/before/crawl.json
```

## A fix-and-verify loop

1. `crawlscope crawl <url> --max-pages 300 --json -o crawls/before` (or MCP `crawl_site`).
2. Group issues by `checkId`, fix the high-count errors first; the `howToFix` text is in `crawl.json` (`checks`) and in `list_issues {check_id}`.
3. Deploy / restart the dev server, then crawl again into `crawls/after`.
4. `crawlscope diff crawls/before crawls/after --json` (or MCP `diff_crawls`): confirm issues were resolved and none were added.
5. Gate in CI with `--fail-on error`.

## Agent etiquette

* Default to `--max-pages 200`-ish crawls; the MCP `crawl_site` does this for you. Say so when results are truncated (`truncated: true`).
* Keep the default delay (250 ms) on sites you do not control; crawlscope obeys robots.txt and refuses `--no-robots` without `--i-own-this-site`.
* Local dev servers are fine to crawl (`http://localhost:3000`); a JavaScript-only front end will show up as thin pages because crawlscope does not run JavaScript.
* Do not paste whole `crawl.json` files into context: filter first.

## Claude Code skill

[`skills/crawlscope/SKILL.md`](../skills/crawlscope/SKILL.md) is a ready-to-use skill. Install it for a project or for yourself:

```bash
mkdir -p .claude/skills && cp -r node_modules/crawlscope/skills/crawlscope .claude/skills/   # project, from an installed package
# or from a clone:
cp -r skills/crawlscope ~/.claude/skills/                                                   # all projects
```

It tells the agent which tools to call in which order and how to report results.
