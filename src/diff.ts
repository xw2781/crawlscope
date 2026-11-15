import { readCrawl } from './output.js';
import type { CrawlResult, PageRecord, Severity } from './types.js';
import { c } from './util/term.js';

export interface FieldChange { field: string; before: string | number | boolean | null; after: string | number | boolean | null }
export interface PageChange { url: string; changes: FieldChange[] }
export interface DiffIssue { checkId: string; severity: Severity; url: string; message: string; messageBefore?: string }
export interface CheckDelta { checkId: string; title: string; severity: Severity; before: number; after: number; added: number; resolved: number; persisting: number }
export interface CrawlRef {
  id: string; seed: string; startedAt: string; pages: number; healthScore: number; aiReadinessScore: number | null;
  issues: number; bySeverity: Record<Severity, number>; avgResponseTimeMs: number | null; indexablePages: number; status: string;
}
export interface CrawlDiff {
  schemaVersion: 1;
  a: CrawlRef;
  b: CrawlRef;
  /** pages are matched on path when the URL is on the crawl's own origin, so staging vs production compare cleanly */
  pages: { added: string[]; removed: string[]; changed: PageChange[]; unchanged: number };
  issues: { added: DiffIssue[]; resolved: DiffIssue[]; persisting: DiffIssue[] };
  byCheck: CheckDelta[];
  deltas: {
    pages: number; healthScore: number; aiReadinessScore: number | null; issues: number; errors: number; warnings: number; notices: number;
    avgResponseTimeMs: number | null; indexablePages: number;
  };
  /** counts of changed pages per field */
  fieldCounts: Record<string, number>;
  /** lists above are truncated to this many entries (totals in `totals`) */
  limit: number;
  totals: { added: number; removed: number; changed: number; issuesAdded: number; issuesResolved: number; issuesPersisting: number };
}

const LIMIT = 5000;
const refOf = (r: CrawlResult): CrawlRef => ({
  id: r.id, seed: r.seed, startedAt: r.startedAt, pages: r.summary.pagesCrawled, healthScore: r.summary.healthScore, aiReadinessScore: r.summary.aiReadinessScore,
  issues: r.summary.issuesTotal, bySeverity: r.summary.bySeverity, avgResponseTimeMs: r.summary.avgResponseTimeMs, indexablePages: r.summary.indexablePages, status: r.status,
});

const h1Of = (p: PageRecord) => p.headings.find((h) => h.level === 1)?.text ?? null;
const FIELDS: [string, (p: PageRecord) => string | number | boolean | null][] = [
  ['status', (p) => p.status], ['redirectTo', (p) => p.redirectTo], ['title', (p) => p.title], ['metaDescription', (p) => p.metaDescription],
  ['h1', h1Of], ['canonical', (p) => p.canonicals[0] ?? null], ['metaRobots', (p) => p.metaRobots], ['indexable', (p) => p.indexable],
  ['depth', (p) => p.depth], ['wordCount', (p) => (p.isHtml ? p.wordCount : null)], ['inlinks', (p) => p.inlinks],
  ['outlinksInternal', (p) => p.outlinksInternal], ['outlinksExternal', (p) => p.outlinksExternal], ['contentHash', (p) => p.contentHash],
];

export function diffCrawls(A: CrawlResult, B: CrawlResult): CrawlDiff {
  const keyer = (r: CrawlResult) => {
    const origin = new URL(r.seed).origin;
    return (u: string) => (u.startsWith(origin + '/') || u === origin ? u.slice(origin.length) || '/' : u);
  };
  const ka = keyer(A), kb = keyer(B);
  // re-map relative origins inside text so messages compare across origins
  const norm = (r: CrawlResult) => { const o = new URL(r.seed).origin; return (s: string) => s.split(o).join(''); };
  const na = norm(A), nb = norm(B);

  const pa = new Map(A.pages.map((p) => [ka(p.url), p]));
  const pb = new Map(B.pages.map((p) => [kb(p.url), p]));
  const added: string[] = [], removed: string[] = [], changed: PageChange[] = [];
  const fieldCounts: Record<string, number> = {};
  let unchanged = 0;
  for (const [k, p] of pb) if (!pa.has(k)) added.push(p.url);
  for (const [k, p] of pa) {
    const q = pb.get(k);
    if (!q) { removed.push(p.url); continue; }
    const changes: FieldChange[] = [];
    for (const [name, get] of FIELDS) {
      let x = get(p), y = get(q);
      if (typeof x === 'string') x = na(x);
      if (typeof y === 'string') y = nb(y);
      if (x !== y) { changes.push({ field: name, before: x, after: y }); fieldCounts[name] = (fieldCounts[name] ?? 0) + 1; }
    }
    const t1 = p.responseTimeMs, t2 = q.responseTimeMs;
    if (t1 !== null && t2 !== null && Math.abs(t2 - t1) >= Math.max(200, t1 * 0.5)) {
      changes.push({ field: 'responseTimeMs', before: t1, after: t2 });
      fieldCounts.responseTimeMs = (fieldCounts.responseTimeMs ?? 0) + 1;
    }
    const s1 = p.sizeBytes, s2 = q.sizeBytes;
    if (s1 !== null && s2 !== null && Math.abs(s2 - s1) >= Math.max(2048, s1 * 0.2)) {
      changes.push({ field: 'sizeBytes', before: s1, after: s2 });
      fieldCounts.sizeBytes = (fieldCounts.sizeBytes ?? 0) + 1;
    }
    if (changes.length) changed.push({ url: q.url, changes });
    else unchanged++;
  }

  // issues: multiset matching on check + page, exact message first
  const group = (r: CrawlResult, key: (u: string) => string, n: (s: string) => string) => {
    const m = new Map<string, DiffIssue[]>();
    for (const i of r.issues) {
      const k = i.checkId + '\u0000' + key(i.url);
      const list = m.get(k) ?? [];
      list.push({ checkId: i.checkId, severity: i.severity, url: i.url, message: n(i.message) });
      m.set(k, list);
    }
    return m;
  };
  const ga = group(A, ka, na), gb = group(B, kb, nb);
  const iAdded: DiffIssue[] = [], iResolved: DiffIssue[] = [], iPersist: DiffIssue[] = [];
  const perCheck = new Map<string, { added: number; resolved: number; persisting: number }>();
  const bump = (id: string, f: 'added' | 'resolved' | 'persisting') => {
    const e = perCheck.get(id) ?? { added: 0, resolved: 0, persisting: 0 };
    e[f]++;
    perCheck.set(id, e);
  };
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    const la = [...(ga.get(k) ?? [])], lb = [...(gb.get(k) ?? [])];
    const restA: DiffIssue[] = [];
    for (const x of la) {
      const j = lb.findIndex((y) => y.message === x.message);
      if (j >= 0) { iPersist.push(lb[j]); bump(x.checkId, 'persisting'); lb.splice(j, 1); } else restA.push(x);
    }
    while (restA.length && lb.length) {
      const x = restA.shift()!, y = lb.shift()!;
      iPersist.push({ ...y, messageBefore: x.message });
      bump(y.checkId, 'persisting');
    }
    for (const x of restA) { iResolved.push(x); bump(x.checkId, 'resolved'); }
    for (const y of lb) { iAdded.push(y); bump(y.checkId, 'added'); }
  }
  const meta = new Map([...A.checks, ...B.checks].map((m) => [m.id, m]));
  const cnt = (r: CrawlResult) => { const m = new Map<string, number>(); for (const i of r.issues) m.set(i.checkId, (m.get(i.checkId) ?? 0) + 1); return m; };
  const ca = cnt(A), cb = cnt(B);
  const order = { error: 0, warning: 1, notice: 2 };
  const byCheck: CheckDelta[] = [...new Set([...ca.keys(), ...cb.keys()])].map((id) => {
    const e = perCheck.get(id) ?? { added: 0, resolved: 0, persisting: 0 };
    const m = meta.get(id);
    return { checkId: id, title: m?.title ?? id, severity: (m?.severity ?? 'notice') as Severity, before: ca.get(id) ?? 0, after: cb.get(id) ?? 0, ...e };
  }).sort((x, y) => order[x.severity] - order[y.severity] || Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || y.after - x.after);

  const ra = refOf(A), rb = refOf(B);
  const nd = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
  const byUrl = (a: string, b: string) => a.localeCompare(b);
  added.sort(byUrl); removed.sort(byUrl); changed.sort((x, y) => byUrl(x.url, y.url));
  const sevSort = (a: DiffIssue, b: DiffIssue) => order[a.severity] - order[b.severity] || a.checkId.localeCompare(b.checkId) || a.url.localeCompare(b.url);
  iAdded.sort(sevSort); iResolved.sort(sevSort); iPersist.sort(sevSort);
  return {
    schemaVersion: 1, a: ra, b: rb,
    pages: { added: added.slice(0, LIMIT), removed: removed.slice(0, LIMIT), changed: changed.slice(0, LIMIT), unchanged },
    issues: { added: iAdded.slice(0, LIMIT), resolved: iResolved.slice(0, LIMIT), persisting: iPersist.slice(0, LIMIT) },
    byCheck,
    deltas: {
      pages: rb.pages - ra.pages, healthScore: rb.healthScore - ra.healthScore, aiReadinessScore: nd(ra.aiReadinessScore, rb.aiReadinessScore), issues: rb.issues - ra.issues,
      errors: rb.bySeverity.error - ra.bySeverity.error, warnings: rb.bySeverity.warning - ra.bySeverity.warning, notices: rb.bySeverity.notice - ra.bySeverity.notice,
      avgResponseTimeMs: nd(ra.avgResponseTimeMs, rb.avgResponseTimeMs), indexablePages: rb.indexablePages - ra.indexablePages,
    },
    fieldCounts, limit: LIMIT,
    totals: { added: added.length, removed: removed.length, changed: changed.length, issuesAdded: iAdded.length, issuesResolved: iResolved.length, issuesPersisting: iPersist.length },
  };
}

export function diffDirs(dirA: string, dirB: string): CrawlDiff {
  return diffCrawls(readCrawl(dirA), readCrawl(dirB));
}

const sign = (n: number | null, good: 'up' | 'down', unit = '') => {
  if (n === null) return c.gray('–');
  const s = (n > 0 ? '+' : '') + n + unit;
  if (n === 0) return c.gray(s);
  const isGood = good === 'up' ? n > 0 : n < 0;
  return isGood ? c.green(s) : c.red(s);
};

export function formatDiff(d: CrawlDiff): string {
  const L: string[] = [];
  L.push('', c.bold('crawlscope diff'), c.gray(`  A  ${d.a.seed}  ${d.a.startedAt}  (${d.a.pages} pages)`), c.gray(`  B  ${d.b.seed}  ${d.b.startedAt}  (${d.b.pages} pages)`), '');
  L.push(`  Health score    ${d.a.healthScore} → ${d.b.healthScore}  ${sign(d.deltas.healthScore, 'up')}`);
  if (d.a.aiReadinessScore !== null) L.push(`  AI readiness    ${d.a.aiReadinessScore} → ${d.b.aiReadinessScore ?? '–'}  ${sign(d.deltas.aiReadinessScore, 'up')}`);
  L.push(`  Pages           ${d.a.pages} → ${d.b.pages}  ${sign(d.deltas.pages, 'up')}`);
  L.push(`  Issues          ${d.a.issues} → ${d.b.issues}  ${sign(d.deltas.issues, 'down')}   (errors ${sign(d.deltas.errors, 'down')}, warnings ${sign(d.deltas.warnings, 'down')}, notices ${sign(d.deltas.notices, 'down')})`);
  L.push(`  Avg response    ${d.a.avgResponseTimeMs ?? '–'} → ${d.b.avgResponseTimeMs ?? '–'} ms  ${sign(d.deltas.avgResponseTimeMs, 'down', ' ms')}`, '');
  L.push(c.bold('  Pages'), `    ${c.green('+' + d.totals.added)} added   ${c.red('-' + d.totals.removed)} removed   ${c.yellow('~' + d.totals.changed)} changed   ${d.pages.unchanged} unchanged`);
  const fc = Object.entries(d.fieldCounts).sort((x, y) => y[1] - x[1]);
  if (fc.length) L.push('    changed fields: ' + fc.map(([k, v]) => `${k} ${v}`).join(', '));
  for (const u of d.pages.added.slice(0, 8)) L.push(c.green('    + ') + u);
  for (const u of d.pages.removed.slice(0, 8)) L.push(c.red('    - ') + u);
  for (const ch of d.pages.changed.slice(0, 8)) {
    L.push(c.yellow('    ~ ') + ch.url);
    for (const f of ch.changes.slice(0, 4)) L.push(c.gray(`        ${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`));
  }
  L.push('', c.bold('  Issues'), `    ${c.red('new ' + d.totals.issuesAdded)}   ${c.green('resolved ' + d.totals.issuesResolved)}   persisting ${d.totals.issuesPersisting}`);
  for (const k of d.byCheck.filter((x) => x.added || x.resolved).slice(0, 12)) {
    L.push(`    ${k.severity.padEnd(7)} ${k.title}  ${c.gray(`(${k.checkId})`)}  ${k.before} → ${k.after}  ${k.added ? c.red('+' + k.added) : ''} ${k.resolved ? c.green('-' + k.resolved) : ''}`);
  }
  L.push('');
  return L.join('\n');
}
