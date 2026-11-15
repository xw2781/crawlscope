#!/usr/bin/env node
// Synthetic 50k-page report: measures payload size, load and table interaction time in headless Chrome.
//   npx tsx scripts/bench-report.mjs [pages=50000]
import { writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { renderReportHtml } from '../src/report/html.ts';
import { blankPage } from '../src/crawler.ts';
import { checkMeta } from '../src/checks/index.ts';
import { summarize } from '../src/summary.ts';

const N = Number(process.argv[2] ?? 50000);
const pages = [], links = [], issues = [];
const meta = checkMeta();
for (let i = 0; i < N; i++) {
  const p = blankPage(`https://bench.test/section-${i % 40}/page-${i}`, 'link', 1 + (i % 6));
  Object.assign(p, { status: i % 97 === 0 ? 404 : 200, isHtml: true, contentType: 'text/html', responseTimeMs: (i * 37) % 1800, sizeBytes: 5000 + ((i * 13) % 90000), title: `Page ${i} title about topic ${i % 311}`, indexable: i % 7 !== 0, wordCount: 100 + (i % 900), inlinks: i % 25, headings: [{ level: 1, text: 'H1 ' + i }] });
  pages.push(p);
  if (i) links.push({ from: pages[Math.floor(i / 3)].url, to: p.url, type: 'a', anchor: 'link ' + i, rel: [], nofollow: false, internal: true, imageOnly: false });
  if (i % 5 === 0) { const c = meta[i % meta.length]; issues.push({ checkId: c.id, severity: c.severity, category: c.category, url: p.url, message: `Issue on page ${i}` }); }
}
const r = { schemaVersion: 1, tool: { name: 'crawlscope', version: 'bench' }, id: 'bench', seed: 'https://bench.test/', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1000, status: 'complete', truncated: false, options: {}, pages, links, issues, checks: meta,
  robots: { url: '', status: 200, present: false, fetchError: null, mode: 'allow-all', sizeBytes: null, parsed: null, raw: null }, sitemaps: [], sitemapUrls: [], aiReadiness: null, externalLinks: [], site: { soft404: null, httpRedirect: null, favicon: null, hsts: null, isHttps: true } };
r.summary = summarize(r);
const t0 = Date.now();
const html = renderReportHtml(r);
console.log(`generated ${N} pages in ${Date.now() - t0} ms, report.html ${(html.length / 1048576).toFixed(1)} MB (${Math.round(html.length / N)} B/page)`);
const file = join(mkdtempSync(join(tmpdir(), 'cs-bench-')), 'report.html');
writeFileSync(file, html);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const t1 = Date.now();
await page.goto(pathToFileURL(file).href + '#/pages');
await page.waitForSelector('.vt-row');
console.log('load + first render of pages table:', Date.now() - t1, 'ms');
const timing = await page.evaluate(async () => {
  const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = {};
  const q = document.querySelector('.search input');
  let t = performance.now(); q.value = 'topic 17'; q.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 200)); await wait(); out.search = Math.round(performance.now() - t - 200);
  q.value = ''; q.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 200)); await wait();
  t = performance.now(); document.querySelectorAll('.vt-th')[5].click(); await wait(); out.sortByTime = Math.round(performance.now() - t);
  t = performance.now(); document.querySelectorAll('.vt-th')[0].click(); await wait(); out.sortByUrl = Math.round(performance.now() - t);
  const sc = document.querySelector('.vt'); t = performance.now(); for (let i = 0; i < 20; i++) { sc.scrollTop += 5000; await wait(); } out.scroll20frames = Math.round(performance.now() - t);
  out.domRows = document.querySelectorAll('.vt-row').length;
  return out;
});
console.log(timing);
await browser.close();
