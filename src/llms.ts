import type { Fetcher } from './fetcher.js';
import type { LlmsFileInfo } from './types.js';
import { normalizeUrl } from './util/url.js';

export interface ParsedLlmsTxt {
  title: string | null;
  summary: string | null;
  sections: { name: string; links: { text: string; url: string; note: string | null }[] }[];
  problems: string[];
}

const LINK_LINE = /^\s*[-*+]\s+\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)\s*(?::\s*(.*))?$/;

/** Validate and parse an llms.txt file according to the proposal at llmstxt.org. */
export function parseLlmsTxt(text: string): ParsedLlmsTxt {
  const problems: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let title: string | null = null;
  let summary: string | null = null;
  const sections: ParsedLlmsTxt['sections'] = [];
  let cur: ParsedLlmsTxt['sections'][number] | null = null;
  let h1Count = 0;
  let sawFirstContent = false;
  let inFence = false;
  const summaryLines: string[] = [];
  let beforeFirstH2 = true;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (!line.trim()) continue;
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1) {
      h1Count++;
      if (!title) title = h1[1].trim();
      if (sawFirstContent && h1Count === 1) problems.push('The H1 title should be the first element of the file.');
      sawFirstContent = true;
      continue;
    }
    sawFirstContent = true;
    if (h2) {
      beforeFirstH2 = false;
      cur = { name: h2[1].trim(), links: [] };
      sections.push(cur);
      continue;
    }
    if (beforeFirstH2) {
      if (/^>\s?/.test(line)) summaryLines.push(line.replace(/^>\s?/, ''));
      continue;
    }
    if (!cur) continue;
    const m = LINK_LINE.exec(line);
    if (m) {
      const url = m[2];
      if (!url) problems.push(`Empty link target in section "${cur.name}".`);
      else cur.links.push({ text: m[1], url, note: m[3]?.trim() || null });
    } else if (/^\s*[-*+]\s+/.test(line)) {
      problems.push(`List item in "${cur.name}" is not in "[name](url): notes" form: "${line.trim().slice(0, 60)}"`);
    }
  }
  if (summaryLines.length) summary = summaryLines.join(' ').trim();
  if (h1Count === 0) problems.push('Missing the required H1 title (a single "# Project name" line).');
  if (h1Count > 1) problems.push(`Found ${h1Count} H1 headings; the format expects exactly one.`);
  if (!summary) problems.push('Missing the blockquote summary ("> short description") after the title.');
  if (sections.length === 0) problems.push('No H2 sections with link lists were found.');
  for (const s of sections) if (s.links.length === 0) problems.push(`Section "${s.name}" contains no links.`);
  const names = sections.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) problems.push('Duplicate H2 section names.');
  return { title, summary, sections, problems };
}

const emptyInfo = (url: string): LlmsFileInfo => ({
  url, status: null, present: false, sizeBytes: null, contentType: null, valid: false, problems: [], title: null, summary: null,
  sections: [], linkCount: 0, brokenLinks: [], checkedLinks: 0,
});

export async function inspectLlmsFile(
  fetcher: Fetcher,
  url: string,
  kind: 'llms' | 'llms-full',
  opts: { checkLinks?: boolean; maxLinks?: number; hostDelayMs?: number } = {},
): Promise<LlmsFileInfo> {
  const info = emptyInfo(url);
  const res = await fetcher.request(url, { hostDelayMs: opts.hostDelayMs, maxBodyBytes: 20 * 1024 * 1024 });
  if (res.error) {
    info.problems.push(`Fetch failed: ${res.error.message}`);
    return info;
  }
  info.status = res.status;
  info.contentType = res.headers['content-type'] ?? null;
  if (res.status !== 200 || !res.body) return info;
  const text = res.body.toString('utf8');
  info.sizeBytes = res.bytes;
  // SPA fallbacks often return an HTML page with status 200
  if (/^\s*<(!doctype|html)/i.test(text) || /text\/html/i.test(info.contentType ?? '')) {
    info.problems.push('The URL returns HTML, not a plain-text/markdown file (possibly a catch-all route).');
    return info;
  }
  info.present = true;
  if (!text.trim()) {
    info.problems.push('File is empty.');
    return info;
  }
  if (kind === 'llms') {
    const parsed = parseLlmsTxt(text);
    info.title = parsed.title;
    info.summary = parsed.summary;
    info.sections = parsed.sections.map((s) => ({ name: s.name, links: s.links.length }));
    info.linkCount = parsed.sections.reduce((n, s) => n + s.links.length, 0);
    info.problems.push(...parsed.problems);
    if (opts.checkLinks) {
      const urls: string[] = [];
      for (const s of parsed.sections) for (const l of s.links) {
        const n = normalizeUrl(l.url, url);
        if (!n) info.brokenLinks.push(l.url);
        else urls.push(n);
      }
      for (const u of [...new Set(urls)].slice(0, opts.maxLinks ?? 15)) {
        info.checkedLinks++;
        let r = await fetcher.request(u, { method: 'HEAD', hostDelayMs: opts.hostDelayMs });
        if (r.error || r.status === 405 || r.status === 501) r = await fetcher.request(u, { hostDelayMs: opts.hostDelayMs, readBody: () => false });
        if (r.error || r.status >= 400) info.brokenLinks.push(u);
      }
      if (info.brokenLinks.length) info.problems.push(`${info.brokenLinks.length} link(s) do not resolve: ${info.brokenLinks.slice(0, 3).join(', ')}`);
    }
    info.valid = parsed.problems.length === 0 && info.brokenLinks.length === 0;
  } else {
    const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
    if (!/^#/.test(first)) info.problems.push('llms-full.txt normally starts with a markdown heading.');
    info.title = /^#\s+(.+)/.exec(first)?.[1] ?? null;
    info.valid = info.problems.length === 0;
  }
  return info;
}
