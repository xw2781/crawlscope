#!/usr/bin/env node
/**
 * Generates a demo crawl from the fixture site and screenshots the report, diff and UI with headless Chrome.
 *   npx tsx scripts/screenshots.mjs            (writes ./shots/*.png, copies a subset to docs/img/)
 * Env: CHROME=/path/to/chrome
 */
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startFixtureServer } from '../test/helpers/server.ts';
import { crawl } from '../src/crawler.ts';
import { resolveOptions } from '../src/options.ts';
import { writeCrawlDir } from '../src/output.ts';
import { diffCrawls } from '../src/diff.ts';
import { renderDiffHtml } from '../src/report/html.ts';
import { startUiServer } from '../src/ui/server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'shots');
const docsImg = join(root, 'docs', 'img');
mkdirSync(shots, { recursive: true });
mkdirSync(docsImg, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'crawlscope-shots-'));
const data = join(work, 'workspace');

const thresholds = { slowMs: 300, verySlowMs: 2000 };
async function runCrawl(server, name) {
  const dir = join(data, name);
  const r = await crawl(resolveOptions({ url: server.origin + '/', delayMs: 0, externalCheck: true, aiBotsCheck: true, outDir: dir, thresholds }));
  writeCrawlDir(dir, r, ['json', 'csv', 'html']);
  return { dir, result: r };
}

const sa = await startFixtureServer();
const sb = await startFixtureServer({ variant: 'b' });
const a = await runCrawl(sa, 'demo.test-20260101090000');
const b = await runCrawl(sb, 'demo.test-20260201090000');
const diff = diffCrawls(a.result, b.result);
writeFileSync(join(work, 'diff.html'), renderDiffHtml(diff));
await sa.close(); await sb.close();

const ui = await startUiServer({ dataDir: data, port: 0 });
const slow = await startFixtureServer({ latency: 220 });
const base = `http://127.0.0.1:${ui.port}`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'] });
const problems = [];
async function newPage(scheme = 'light', height = 900) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  page.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/.test(u) && !u.startsWith(base)) problems.push('EXTERNAL REQUEST: ' + u); });
  return page;
}
const snap = async (page, name, opts = {}) => {
  await new Promise((r) => setTimeout(r, opts.wait ?? 350));
  await page.screenshot({ path: join(shots, name + '.png'), fullPage: !!opts.full, clip: opts.clip });
  console.log('shot', name, Math.round(statSync(join(shots, name + '.png')).size / 1024) + ' KB');
};
const reportUrl = pathToFileURL(join(a.dir, 'report.html')).href;

for (const scheme of ['light', 'dark']) {
  const p = await newPage(scheme, 1500);
  await p.goto(reportUrl + '#/overview');
  await snap(p, 'report-overview-' + scheme);
  if (scheme === 'light') {
    await p.goto(reportUrl + '#/issues'); await p.reload();
    await p.evaluate(() => { const hs = document.querySelectorAll('.issue-head'); hs[0]?.click(); hs[2]?.click(); });
    await p.setViewport({ width: 1440, height: 1250, deviceScaleFactor: 1 });
    await snap(p, 'report-issues');
    await p.goto(reportUrl + '#/pages'); await p.reload();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await p.evaluate(() => { document.querySelector('.vt-row')?.click(); });
    await snap(p, 'report-pages-drawer');
    await p.evaluate(() => document.querySelector('.scrim').click());
    await snap(p, 'report-pages');
    await p.goto(reportUrl + '#/ai'); await p.reload();
    await p.setViewport({ width: 1440, height: 1500, deviceScaleFactor: 1 });
    await snap(p, 'ai-readiness');
    for (const sec of ['links', 'sitemap', 'structured']) { await p.goto(reportUrl + '#/' + sec); await p.reload(); await p.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 }); await snap(p, 'report-' + sec); }
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await p.goto(reportUrl + '#/overview'); await p.reload();
    await snap(p, 'report-mobile');
  }
  await p.close();
}

const dp = await newPage('light', 1400);
await dp.goto(pathToFileURL(join(work, 'diff.html')).href);
await snap(dp, 'diff-report');
await dp.close();

// ---- UI ----
const up = await newPage('light', 1000);
await up.goto(base + '/#/');
await snap(up, 'ui-crawls');
await up.goto(base + '/#/crawl/' + encodeURIComponent('demo.test-20260201090000') + '/overview'); await up.reload();
await up.setViewport({ width: 1440, height: 1250, deviceScaleFactor: 1 });
await snap(up, 'ui-dashboard', { wait: 700 });
await up.goto(base + '/#/new'); await up.reload();
await up.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await snap(up, 'ui-new-crawl');
await up.goto(base + '/#/compare?a=demo.test-20260101090000&b=demo.test-20260201090000'); await up.reload();
await up.setViewport({ width: 1440, height: 1300, deviceScaleFactor: 1 });
await snap(up, 'ui-compare', { wait: 700 });

// live crawl
await up.goto(base + '/#/new'); await up.reload();
await up.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const token = ui.token;
const started = await fetch(base + '/api/crawls', { method: 'POST', headers: { 'content-type': 'application/json', 'x-crawlscope-token': token }, body: JSON.stringify({ url: slow.origin + '/', maxPages: 60, concurrency: 2, delayMs: 60 }) });
if (started.status !== 202) problems.push('could not start live crawl: ' + (await started.text()));
await up.evaluate(() => { location.hash = '#/live'; });
await up.waitForFunction(() => /\d/.test(document.querySelector('.live-stats b')?.textContent || '') && Number((document.querySelector('.live-stats b')?.textContent || '0').replace(/,/g, '')) >= 14, { timeout: 30000 });
await snap(up, 'ui-live-crawl', { wait: 200 });
await fetch(base + '/api/job/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-crawlscope-token': token }, body: '{}' });
await up.close();

await browser.close();
await ui.close();
await slow.close();

const keep = ['report-overview-light', 'report-overview-dark', 'report-issues', 'report-pages-drawer', 'ai-readiness', 'diff-report', 'ui-dashboard', 'ui-live-crawl'];
for (const k of keep) copyFileSync(join(shots, k + '.png'), join(docsImg, k + '.png'));
rmSync(work, { recursive: true, force: true });
if (problems.length) { console.error('PROBLEMS:\n' + [...new Set(problems)].join('\n')); process.exitCode = 1; }
else console.log('no console errors / external requests');
