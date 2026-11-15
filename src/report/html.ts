import type { CrawlResult } from '../types.js';
import { webAsset } from '../web-assets.js';
import { buildReportData, safeJson, type ReportData } from './data.js';
import type { CrawlDiff } from '../diff.js';

const THEME_BOOT = `try{var t=localStorage.getItem('crawlscope-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** inline JS/CSS must never contain a closing tag for its own container */
const inlineSafe = (s: string) => s.replace(/<\/(script|style)/gi, '<\\/$1');

function page(title: string, bodyScript: string, data: unknown): string {
  const host = (() => { try { return new URL(title).host; } catch { return title; } })();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="crawlscope">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%230d7c76'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='white' stroke-width='2.4'/%3E%3C/svg%3E">
<title>${esc(host)} · crawlscope report</title>
<script>${THEME_BOOT}</script>
<style>${inlineSafe(webAsset('theme.css'))}${inlineSafe(webAsset('page.css'))}</style>
</head>
<body>
<div id="app"></div>
<noscript><p style="padding:24px;font-family:sans-serif">This report needs JavaScript to render. The raw data is in crawl.json and the CSV exports.</p></noscript>
<script id="cs-data" type="application/json">${safeJson(data)}</script>
<script>${inlineSafe(webAsset('common.js'))}</script>
<script>${inlineSafe(webAsset('diff-viewer.js'))}</script>
<script>${inlineSafe(webAsset('viewer.js'))}</script>
<script>${inlineSafe(bodyScript)}</script>
</body>
</html>
`;
}

const BOOT_REPORT = `(function(){var D=JSON.parse(document.getElementById('cs-data').textContent);CS.themeInit();CrawlViewer.mount(document.getElementById('app'),D,{});})();`;
const BOOT_DIFF = `(function(){var D=JSON.parse(document.getElementById('cs-data').textContent);CS.themeInit();DiffViewer.mountStandalone(document.getElementById('app'),D);})();`;

/** Self-contained report.html for a crawl. Optionally embeds a diff section. */
export function renderReportHtml(result: CrawlResult, opts: { diff?: CrawlDiff } = {}): string {
  const data: ReportData = buildReportData(result);
  if (opts.diff) data.diff = opts.diff;
  return page(result.seed, BOOT_REPORT, data);
}

export function renderDiffHtml(diff: CrawlDiff): string {
  return page(diff.b.seed, BOOT_DIFF, diff);
}
