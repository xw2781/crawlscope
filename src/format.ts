import type { CrawlResult, Severity } from './types.js';
import { c } from './util/term.js';

const sevColor = (s: Severity) => (s === 'error' ? c.red : s === 'warning' ? c.yellow : c.cyan);
const bar = (n: number, max: number, w = 24) => '█'.repeat(max ? Math.max(n > 0 ? 1 : 0, Math.round((n / max) * w)) : 0);

export function formatSummary(r: CrawlResult, outDir?: string | null): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push('');
  lines.push(c.bold(`crawlscope  ${r.seed}`) + c.gray(`  (${(r.durationMs / 1000).toFixed(1)}s${r.truncated ? ', stopped at limit' : ''}${r.status === 'partial' ? ', interrupted' : ''})`));
  lines.push('');
  const hs = s.healthScore;
  const hc = hs >= 85 ? c.green : hs >= 60 ? c.yellow : c.red;
  lines.push(`  Health score   ${hc(c.bold(String(hs)))}/100` + (s.aiReadinessScore !== null ? `     AI readiness   ${c.bold(String(s.aiReadinessScore))}/100` : ''));
  lines.push(`  Pages          ${s.pagesCrawled} crawled · ${s.htmlPages} HTML · ${s.indexablePages} indexable · ${s.sitemapUrls} in sitemap`);
  lines.push(`  Links          ${s.internalLinks} internal · ${s.externalLinks} external   Avg response ${s.avgResponseTimeMs ?? '–'} ms   Max depth ${s.maxDepth}`);
  lines.push('');
  lines.push(c.bold('  Issues') + `   ${c.red(s.bySeverity.error + ' errors')}  ${c.yellow(s.bySeverity.warning + ' warnings')}  ${c.cyan(s.bySeverity.notice + ' notices')}`);
  const top = s.byCheck.slice(0, 12);
  const titles = new Map(r.checks.map((x) => [x.id, x.title]));
  const max = Math.max(1, ...top.map((t) => t.count));
  for (const t of top) {
    lines.push(`    ${sevColor(t.severity)(t.severity.padEnd(7))} ${String(t.count).padStart(4)}  ${sevColor(t.severity)(bar(t.count, max, 12).padEnd(12))} ${titles.get(t.checkId) ?? t.checkId} ${c.gray('(' + t.checkId + ')')}`);
  }
  if (s.byCheck.length > top.length) lines.push(c.gray(`    … and ${s.byCheck.length - top.length} more checks with findings`));
  lines.push('');
  lines.push(c.bold('  Status codes'));
  const codes = Object.entries(s.statusCodes).sort(([a], [b]) => a.localeCompare(b));
  lines.push('    ' + codes.map(([k, v]) => `${k}: ${v}`).join('   '));
  if (s.slowestPages.length) {
    lines.push('');
    lines.push(c.bold('  Slowest pages'));
    for (const p of s.slowestPages.slice(0, 5)) lines.push(`    ${String(p.responseTimeMs).padStart(6)} ms  ${p.url}`);
  }
  if (r.aiReadiness) {
    lines.push('');
    lines.push(c.bold('  AI readiness') + c.gray('  (heuristic checklist, not a ranking prediction)'));
    for (const comp of r.aiReadiness.components) lines.push(`    ${String(comp.score).padStart(5)}/${String(comp.max).padEnd(2)} ${comp.label}`);
  }
  if (outDir) {
    lines.push('');
    lines.push(c.gray(`  Output: ${outDir}`));
  }
  lines.push('');
  return lines.join('\n');
}

export function formatAiReport(r: NonNullable<CrawlResult['aiReadiness']>, site: string): string {
  const L: string[] = [];
  L.push('', c.bold(`AI readiness  ${site}`), '');
  const sc = r.score;
  L.push(`  Score  ${(sc >= 70 ? c.green : sc >= 40 ? c.yellow : c.red)(c.bold(String(sc)))}/100`, '');
  for (const comp of r.components) L.push(`  ${String(comp.score).padStart(5)}/${String(comp.max).padEnd(2)}  ${comp.label}\n           ${c.gray(comp.note)}`);
  L.push('', c.bold('  llms.txt'), `    ${r.llmsTxt.present ? (r.llmsTxt.valid ? c.green('found, valid') : c.yellow('found, ' + r.llmsTxt.problems.length + ' problem(s)')) : c.red('not found')}   llms-full.txt: ${r.llmsFullTxt.present ? c.green('found') : c.gray('not found')}`);
  for (const p of r.llmsTxt.problems.slice(0, 5)) L.push(c.gray('      - ' + p));
  L.push('', c.bold('  AI crawlers in robots.txt'));
  for (const b of r.bots) {
    const label = b.allowed ? (b.partial ? 'partial' : 'allowed') : 'blocked';
    const st = (b.allowed ? (b.partial ? c.yellow : c.green) : c.red)(label.padEnd(8));
    L.push(`    ${b.bot.padEnd(22)} ${st} ${c.gray(b.purpose.padEnd(10) + b.vendor)}`);
  }
  L.push('', c.gray('  ' + r.disclaimer), '');
  return L.join('\n');
}
