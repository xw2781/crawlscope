#!/usr/bin/env bash
# Very light real-world sanity check: crawls ONLY example.com and example.org
# (IANA-reserved demo domains), at most 5 pages each, 1 request per second.
# Usage: scripts/smoke-public.sh        (needs `npm run build` first, or crawlscope on PATH)
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v crawlscope >/dev/null 2>&1; then CLI=(crawlscope)
elif [ -f dist/cli.js ]; then CLI=(node dist/cli.js)
else echo "Build first: npm run build" >&2; exit 2; fi

OUT="$(mktemp -d)"
trap 'echo "Output kept in $OUT"' EXIT
for site in https://example.com https://example.org; do
  host="${site#https://}"
  echo "== $site"
  "${CLI[@]}" crawl "$site" --max-pages 5 --delay 1000 --concurrency 1 --json -o "$OUT/$host" > "$OUT/$host.json"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!(j.summary.pagesCrawled >= 1)) { console.error("no pages crawled"); process.exit(1); }
    console.log(`  pages=${j.summary.pagesCrawled} health=${j.summary.healthScore} ai=${j.summary.aiReadinessScore} issues=${j.summary.issuesTotal} status=${JSON.stringify(j.summary.statusCodes)}`);
  ' "$OUT/$host.json"
done
echo "OK: smoke test passed"
