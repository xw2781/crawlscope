import type { CheckContext, CheckDef, CheckMeta, Issue } from '../types.js';
import { responseChecks } from './response.js';
import { onPageChecks } from './onpage.js';
import { indexabilityChecks } from './indexability.js';
import { linkChecks } from './links.js';
import { siteChecks } from './site.js';
import { structuredChecks } from './structured.js';
import { aiChecks } from './ai.js';

export const ALL_CHECKS: CheckDef[] = [
  ...responseChecks,
  ...linkChecks,
  ...onPageChecks,
  ...indexabilityChecks,
  ...structuredChecks,
  ...siteChecks,
  ...aiChecks,
];

export function checkMeta(): CheckMeta[] {
  return ALL_CHECKS.map(({ run: _run, ...meta }) => meta);
}

export function getCheck(id: string): CheckDef | undefined {
  return ALL_CHECKS.find((c) => c.id === id);
}

export function runChecks(ctx: CheckContext, checks: CheckDef[] = ALL_CHECKS): Issue[] {
  const issues: Issue[] = [];
  for (const c of checks) {
    for (const f of c.run(ctx)) {
      issues.push({ checkId: c.id, severity: f.severity ?? c.severity, category: c.category, url: f.url, message: f.message, ...(f.details ? { details: f.details } : {}) });
    }
  }
  const order = { error: 0, warning: 1, notice: 2 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.checkId.localeCompare(b.checkId) || a.url.localeCompare(b.url));
  return issues;
}
