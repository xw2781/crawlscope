import type { CheckContext, CheckDef, CheckMeta, Finding, PageRecord } from '../types.js';

export type CheckBody = (ctx: CheckContext) => Finding[];

export function def(meta: CheckMeta, run: CheckBody): CheckDef {
  return { ...meta, run };
}

/** A page that was fetched successfully as HTML (status 200). */
export const isOkHtml = (p: PageRecord): boolean => p.isHtml && p.status === 200 && !p.fetchError;

/** Indexable, successfully fetched HTML page: the population for most on-page checks. */
export const isIndexableHtml = (p: PageRecord): boolean => isOkHtml(p) && p.indexable;

export function pagesWhere(ctx: CheckContext, pred: (p: PageRecord) => boolean): PageRecord[] {
  return ctx.pages.filter(pred);
}

/** Emit one finding per page for which `fn` returns a message (or finding). */
export function perPage(
  ctx: CheckContext,
  pred: (p: PageRecord) => boolean,
  fn: (p: PageRecord) => string | Omit<Finding, 'url'> | null | undefined,
): Finding[] {
  const out: Finding[] = [];
  for (const p of ctx.pages) {
    if (!pred(p)) continue;
    const r = fn(p);
    if (!r) continue;
    out.push(typeof r === 'string' ? { url: p.url, message: r } : { url: p.url, ...r });
  }
  return out;
}

/** Group pages by a key; returns only groups with 2+ members. */
export function duplicateGroups(pages: PageRecord[], key: (p: PageRecord) => string | null): Map<string, PageRecord[]> {
  const m = new Map<string, PageRecord[]>();
  for (const p of pages) {
    const k = key(p);
    if (!k) continue;
    const arr = m.get(k);
    if (arr) arr.push(p);
    else m.set(k, [p]);
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}

export function duplicateFindings(groups: Map<string, PageRecord[]>, what: string): Finding[] {
  const out: Finding[] = [];
  for (const [value, pages] of groups) {
    for (const p of pages) {
      const others = pages.filter((o) => o !== p).map((o) => o.url);
      out.push({
        url: p.url,
        message: `${what} is shared with ${others.length} other page${others.length > 1 ? 's' : ''}.`,
        details: { value: value.slice(0, 120), duplicates: others.slice(0, 5), duplicateCount: others.length },
      });
    }
  }
  return out;
}

export const short = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
