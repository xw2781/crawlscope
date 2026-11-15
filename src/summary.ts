import type { CrawlResult, CrawlSummary, Severity } from './types.js';

const WEIGHT: Record<Severity, number> = { error: 10, warning: 4, notice: 0.75 };

export function healthScore(result: Pick<CrawlResult, 'issues' | 'pages'>): number {
  const total = Math.max(1, result.pages.filter((p) => p.status > 0).length);
  const perCheck = new Map<string, { sev: Severity; urls: Set<string> }>();
  for (const i of result.issues) {
    let e = perCheck.get(i.checkId);
    if (!e) perCheck.set(i.checkId, (e = { sev: i.severity, urls: new Set() }));
    e.urls.add(i.url);
  }
  let penalty = 0;
  for (const e of perCheck.values()) {
    const share = Math.min(1, e.urls.size / total);
    penalty += WEIGHT[e.sev] * (0.4 + 0.6 * share);
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

export function summarize(result: CrawlResult): CrawlSummary {
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  const byCheckMap = new Map<string, { checkId: string; severity: Severity; count: number }>();
  for (const i of result.issues) {
    bySeverity[i.severity]++;
    const e = byCheckMap.get(i.checkId) ?? { checkId: i.checkId, severity: i.severity, count: 0 };
    e.count++;
    byCheckMap.set(i.checkId, e);
  }
  const order = { error: 0, warning: 1, notice: 2 };
  const byCheck = [...byCheckMap.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const statusCodes: Record<string, number> = {};
  for (const p of result.pages) {
    const k = p.blockedByRobots ? 'blocked' : p.fetchError ? 'error' : String(p.status);
    statusCodes[k] = (statusCodes[k] ?? 0) + 1;
  }
  const timed = result.pages.filter((p) => p.responseTimeMs !== null && p.status > 0);
  const avg = timed.length ? Math.round(timed.reduce((a, p) => a + p.responseTimeMs!, 0) / timed.length) : null;
  return {
    pagesCrawled: result.pages.filter((p) => !p.blockedByRobots).length,
    htmlPages: result.pages.filter((p) => p.isHtml && p.status === 200).length,
    indexablePages: result.pages.filter((p) => p.indexable).length,
    issuesTotal: result.issues.length,
    bySeverity,
    byCheck,
    statusCodes,
    healthScore: healthScore(result),
    aiReadinessScore: result.aiReadiness?.score ?? null,
    slowestPages: [...timed].sort((a, b) => b.responseTimeMs! - a.responseTimeMs!).slice(0, 5).map((p) => ({ url: p.url, responseTimeMs: p.responseTimeMs! })),
    avgResponseTimeMs: avg,
    maxDepth: Math.max(0, ...result.pages.map((p) => p.depth ?? 0)),
    internalLinks: result.links.filter((l) => l.type === 'a' && l.internal).length,
    externalLinks: result.links.filter((l) => l.type === 'a' && !l.internal).length,
    sitemapUrls: result.sitemapUrls.length,
  };
}
