import type { ParsedRobots, RobotsGroup, RobotsWarning } from './types.js';

const MAX_BYTES = 500 * 1024; // RFC 9309 §2.5: parse at least 500 KiB
const KNOWN = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param', 'noindex', 'request-rate', 'visit-time']);

/** Parse robots.txt per RFC 9309 (tolerant: BOM, CRLF, comments, missing colon warnings). */
export function parseRobots(text: string): ParsedRobots {
  if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const warnings: RobotsWarning[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) return;
    const colon = line.indexOf(':');
    if (colon < 0) {
      warnings.push({ line: lineNo, message: `Line has no ":" separator and was ignored: "${line.slice(0, 60)}"` });
      return;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN.has(field)) {
      warnings.push({ line: lineNo, message: `Unknown directive "${field}" is ignored by most crawlers.` });
      return;
    }
    if (field === 'sitemap') {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
      else warnings.push({ line: lineNo, message: 'Sitemap directive must be an absolute http(s) URL.' });
      return;
    }
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      if (!value) warnings.push({ line: lineNo, message: 'Empty User-agent value.' });
      else current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (field === 'allow' || field === 'disallow') {
      if (!current) {
        warnings.push({ line: lineNo, message: `"${field}" appears before any User-agent line and is ignored.` });
        return;
      }
      if (value && !value.startsWith('/') && !value.startsWith('*')) {
        warnings.push({ line: lineNo, message: `Path "${value.slice(0, 40)}" should start with "/" or "*".` });
      }
      current.rules.push({ type: field, path: value });
      return;
    }
    if (field === 'crawl-delay') {
      if (!current) {
        warnings.push({ line: lineNo, message: 'Crawl-delay appears before any User-agent line and is ignored.' });
        return;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) warnings.push({ line: lineNo, message: `Invalid Crawl-delay "${value}".` });
      else current.crawlDelay = n;
      return;
    }
    // host / clean-param / etc: valid-ish but non-standard
    warnings.push({ line: lineNo, message: `"${field}" is a non-standard directive; Google ignores it.` });
  });
  return { groups, sitemaps, warnings };
}

/** Normalise percent-encoding so patterns and paths compare consistently. */
function normPath(p: string): string {
  return p.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const ch = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m.toUpperCase();
  });
}

function patternToRegex(pattern: string): RegExp {
  let anchored = false;
  let p = normPath(pattern);
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const re = p
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + re + (anchored ? '$' : ''));
}

export function productToken(userAgent: string): string {
  const m = /^[A-Za-z0-9_-]+/.exec(userAgent.trim());
  return (m ? m[0] : userAgent).toLowerCase();
}

export interface RobotsMatcher {
  isAllowed(pathWithQuery: string): boolean;
  /** the winning rule for a path, or null when none matches */
  matchingRule(pathWithQuery: string): { type: 'allow' | 'disallow'; path: string } | null;
  /** seconds, or null */
  crawlDelay: number | null;
  matchedBy: 'explicit' | 'wildcard' | 'none';
  /** the rules applying to this agent (merged groups) */
  rules: { type: 'allow' | 'disallow'; path: string }[];
}

/** Build a matcher for a given user agent (full UA string or product token). */
export function robotsMatcher(parsed: ParsedRobots | null, userAgent: string): RobotsMatcher {
  const token = productToken(userAgent);
  const explicit = parsed?.groups.filter((g) => g.agents.includes(token)) ?? [];
  const star = parsed?.groups.filter((g) => g.agents.includes('*')) ?? [];
  const chosen = explicit.length ? explicit : star;
  const matchedBy = explicit.length ? 'explicit' : star.length ? 'wildcard' : 'none';
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  const compiled = rules
    .filter((r) => r.path !== '') // empty Disallow = allow all; empty Allow = no-op
    .map((r) => ({ type: r.type, path: r.path, len: normPath(r.path).length, re: patternToRegex(r.path) }));
  const best = (pathWithQuery: string) => {
    const path = normPath(pathWithQuery.startsWith('/') ? pathWithQuery : '/' + pathWithQuery);
    let b: (typeof compiled)[number] | null = null;
    for (const r of compiled) {
      if (!r.re.test(path)) continue;
      if (!b || r.len > b.len || (r.len === b.len && r.type === 'allow')) b = r;
    }
    return b;
  };
  return {
    matchingRule(pathWithQuery: string) {
      const b = best(pathWithQuery);
      return b ? { type: b.type, path: b.path } : null;
    },
    matchedBy,
    rules,
    crawlDelay: delays.length ? Math.max(...delays) : null,
    isAllowed(pathWithQuery: string): boolean {
      if (pathWithQuery === '/robots.txt') return true;
      const b = best(pathWithQuery);
      return !b || b.type === 'allow';
    },
  };
}
