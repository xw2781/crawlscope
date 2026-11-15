import { describe, expect, it } from 'vitest';
import { parseLlmsTxt } from '../../src/llms.js';

describe('llms.txt parsing', () => {
  it('accepts a well-formed file', () => {
    const p = parseLlmsTxt('# Name\n\n> Summary line\n\nSome details.\n\n## Docs\n\n- [A](https://x.test/a): about\n- [B](/b)\n\n## Optional\n\n- [C](https://x.test/c)\n');
    expect(p.problems).toEqual([]);
    expect(p.title).toBe('Name');
    expect(p.summary).toBe('Summary line');
    expect(p.sections.map((s) => [s.name, s.links.length])).toEqual([['Docs', 2], ['Optional', 1]]);
    expect(p.sections[0].links[0].note).toBe('about');
  });
  it('reports missing H1, summary and sections', () => {
    const p = parseLlmsTxt('just text\n');
    expect(p.problems.join('|')).toMatch(/H1/);
    expect(p.problems.join('|')).toMatch(/blockquote/);
    expect(p.problems.join('|')).toMatch(/H2/);
  });
  it('reports multiple H1s, empty sections and malformed list items', () => {
    const p = parseLlmsTxt('# A\n# B\n> s\n## Empty\n## S\n- not a link\n- [ok](/x)\n');
    const all = p.problems.join('|');
    expect(all).toMatch(/2 H1/);
    expect(all).toMatch(/Empty.*no links/);
    expect(all).toMatch(/not in/);
  });
  it('ignores content inside code fences', () => {
    const p = parseLlmsTxt('# T\n> s\n## S\n- [a](/a)\n```\n## Fake\n```\n');
    expect(p.sections.map((s) => s.name)).toEqual(['S']);
  });
  it('tolerates BOM and CRLF', () => {
    expect(parseLlmsTxt('﻿# T\r\n> s\r\n## S\r\n- [a](/a)\r\n').problems).toEqual([]);
  });
});
