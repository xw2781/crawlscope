/** Small parsers for HTTP header values that carry SEO directives. */

export interface HeaderLink {
  url: string;
  rel: string[];
  hreflang: string | null;
}

/** Parse an RFC 8288 Link header (comma separated, `<url>; rel="x"; hreflang="y"`). */
export function parseLinkHeader(value: string | null | undefined): HeaderLink[] {
  if (!value) return [];
  const out: HeaderLink[] = [];
  for (const part of value.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>(.*)$/s.exec(part);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const p of m[2].split(';')) {
      const kv = /^\s*([A-Za-z*-]+)\s*(?:=\s*(?:"([^"]*)"|(\S*)))?\s*$/.exec(p);
      if (kv) params[kv[1].toLowerCase()] ??= kv[2] ?? kv[3] ?? '';
    }
    out.push({ url: m[1].trim(), rel: (params.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean), hreflang: params.hreflang ?? null });
  }
  return out;
}

const APPLIES_TO = new Set(['googlebot', 'bingbot', 'crawlscope', 'googlebot-news']);

/**
 * Directives from an X-Robots-Tag value that apply to a general crawler. Values may carry a
 * leading `botname:` prefix; unprefixed ones and those for major engines / us are kept.
 * Multiple header values arrive comma-joined, so a new `bot:` prefix may start mid-string.
 */
export function xRobotsDirectives(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let applies = true;
  for (const raw of value.toLowerCase().split(',')) {
    let tok = raw.trim();
    if (!tok) continue;
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(tok);
    if (m && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/.test(m[1])) {
      applies = APPLIES_TO.has(m[1]);
      tok = m[2].trim();
    }
    if (applies && tok) out.push(tok);
  }
  return out;
}

/** Parse `<meta http-equiv="refresh" content="5; url=/next">`. */
export function parseMetaRefresh(content: string | undefined | null): { delay: number; url: string | null } | null {
  if (!content) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?(?:"([^"]*)"|'([^']*)'|(.*?)))?\s*$/i.exec(content);
  if (!m) return null;
  const url = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  return { delay: Number(m[1]), url: url || null };
}
