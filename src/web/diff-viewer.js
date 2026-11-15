/* crawlscope diff viewer: renders a CrawlDiff (src/diff.ts) into any element. */
(function (g) {
  'use strict';
  var CS = g.CS, h = CS.h, n = CS.n;
  var LABELS = { status: 'Status', redirectTo: 'Redirect target', title: 'Title', metaDescription: 'Meta description', h1: 'H1', canonical: 'Canonical', metaRobots: 'Meta robots', indexable: 'Indexable', depth: 'Depth', wordCount: 'Word count', inlinks: 'Inlinks', outlinksInternal: 'Internal outlinks', outlinksExternal: 'External outlinks', contentHash: 'Content hash', responseTimeMs: 'Response time', sizeBytes: 'Size' };

  function delta(v, good, unit, fmt) {
    if (v === null || v === undefined) return h('span', { class: 'muted' }, '–');
    var cls = v === 0 ? 'muted' : ((good === 'up') === (v > 0) ? 'ok' : 'err');
    var col = v === 0 ? 'var(--muted)' : cls === 'ok' ? 'var(--ok)' : 'var(--err)';
    return h('span', { class: 'num', style: 'color:' + col + ';font-weight:650' }, (v > 0 ? '+' : v < 0 ? '−' : '±') + (fmt ? fmt(Math.abs(v)) : n(Math.abs(v))) + (unit || ''));
  }
  function val(v, field) {
    if (v === null || v === undefined || v === '') return h('i', { class: 'muted' }, 'empty');
    if (field === 'responseTimeMs') return CS.ms(v);
    if (field === 'sizeBytes') return CS.bytes(v);
    return String(v);
  }

  function render(el, d, opts) {
    opts = opts || {};
    var A = d.a, B = d.b;
    function crawlCard(tag, c) {
      return h('div', { class: 'card' }, h('h3', { class: 'card-h' }, tag), h('div', { style: 'font-weight:650;word-break:break-all' }, c.seed), h('div', { class: 'note' }, CS.date(c.startedAt) + ' · ' + n(c.pages) + ' pages · ' + n(c.issues) + ' issues'));
    }
    el.appendChild(h('div', { class: 'grid g2' }, crawlCard('Before (A)', A), crawlCard('After (B)', B)));
    function tile(label, a, b, dl) { return h('div', { class: 'card', style: 'padding:14px 16px' }, h('div', { class: 'note', style: 'font-weight:650' }, label), h('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-top:2px' }, h('b', { class: 'num', style: 'font-size:24px;letter-spacing:-.02em' }, b === null ? '–' : typeof b === 'number' ? n(b) : b), dl), h('div', { class: 'note num' }, 'was ' + (a === null ? '–' : typeof a === 'number' ? n(a) : a))); }
    var D = d.deltas;
    el.appendChild(h('div', { class: 'grid g4' },
      tile('Health score', A.healthScore, B.healthScore, delta(D.healthScore, 'up')),
      tile('AI readiness', A.aiReadinessScore, B.aiReadinessScore, delta(D.aiReadinessScore, 'up')),
      tile('Pages', A.pages, B.pages, delta(D.pages, 'up')),
      tile('Avg response', A.avgResponseTimeMs === null ? null : CS.ms(A.avgResponseTimeMs), B.avgResponseTimeMs === null ? null : CS.ms(B.avgResponseTimeMs), delta(D.avgResponseTimeMs, 'down', '', CS.ms)),
      tile('Errors', A.bySeverity.error, B.bySeverity.error, delta(D.errors, 'down')),
      tile('Warnings', A.bySeverity.warning, B.bySeverity.warning, delta(D.warnings, 'down')),
      tile('Notices', A.bySeverity.notice, B.bySeverity.notice, delta(D.notices, 'down')),
      tile('Indexable pages', A.indexablePages, B.indexablePages, delta(D.indexablePages, 'up'))));

    // issue deltas by check
    var rows = d.byCheck.filter(function (k) { return k.added || k.resolved || k.before !== k.after; });
    el.appendChild(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h3', { class: 'card-h' }, 'Issue changes by check', h('span', { class: 'r' }, n(d.totals.issuesAdded) + ' new · ' + n(d.totals.issuesResolved) + ' resolved · ' + n(d.totals.issuesPersisting) + ' persisting')),
      rows.length ? h('div', { class: 'scrollx' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Severity', 'Check', 'Before', 'After', 'New', 'Resolved'].map(function (x, i) { return h('th', { style: i > 1 ? 'text-align:right' : '' }, x); }))),
        h('tbody', null, rows.map(function (k) {
          return h('tr', null, h('td', null, CS.sevBadge(k.severity)), h('td', null, h('b', null, k.title), h('div', { class: 'note' }, k.checkId)), h('td', { class: 'num', style: 'text-align:right' }, n(k.before)), h('td', { class: 'num', style: 'text-align:right' }, n(k.after)),
            h('td', { class: 'num', style: 'text-align:right;color:' + (k.added ? 'var(--err)' : 'var(--muted)') }, k.added ? '+' + n(k.added) : '0'), h('td', { class: 'num', style: 'text-align:right;color:' + (k.resolved ? 'var(--ok)' : 'var(--muted)') }, k.resolved ? '−' + n(k.resolved) : '0'));
        })))) : h('div', { class: 'empty' }, 'No differences in issues.')));

    // tabs
    var TABS = [['added', 'Pages added', d.totals.added], ['removed', 'Pages removed', d.totals.removed], ['changed', 'Pages changed', d.totals.changed], ['iadded', 'New issues', d.totals.issuesAdded], ['iresolved', 'Resolved issues', d.totals.issuesResolved], ['ipersist', 'Persisting issues', d.totals.issuesPersisting]];
    var active = TABS.find(function (t) { return t[2] > 0; }) || TABS[0];
    var tabBar = h('div', { class: 'chips no-print', style: 'margin-bottom:12px' }), box = h('div'), fieldBar = h('div', { class: 'chips no-print', style: 'margin-bottom:10px' });
    var fieldFilter = '';
    el.appendChild(h('div', { class: 'card' }, h('h3', { class: 'card-h' }, 'Details'), tabBar, fieldBar, box));
    function paint() {
      CS.clear(tabBar); CS.clear(box); CS.clear(fieldBar);
      TABS.forEach(function (t) { tabBar.appendChild(h('button', { class: 'chip' + (t === active ? ' on' : ''), onclick: function () { active = t; fieldFilter = ''; paint(); } }, t[1], h('span', { class: 'n' }, n(t[2])))); });
      var k = active[0], list;
      if (k === 'added' || k === 'removed') list = d.pages[k].map(function (u) { return h('div', { class: 'list-row' }, h('span', { class: 'tag', style: 'color:' + (k === 'added' ? 'var(--ok)' : 'var(--err)') }, k === 'added' ? '+ new' : '− gone'), h('span', { class: 'url grow' }, u)); });
      else if (k === 'changed') {
        var fc = Object.keys(d.fieldCounts).sort(function (a, b) { return d.fieldCounts[b] - d.fieldCounts[a]; });
        fieldBar.appendChild(h('button', { class: 'chip' + (!fieldFilter ? ' on' : ''), onclick: function () { fieldFilter = ''; paint(); } }, 'All fields'));
        fc.forEach(function (f) { fieldBar.appendChild(h('button', { class: 'chip' + (fieldFilter === f ? ' on' : ''), onclick: function () { fieldFilter = f; paint(); } }, LABELS[f] || f, h('span', { class: 'n' }, n(d.fieldCounts[f])))); });
        list = d.pages.changed.filter(function (c) { return !fieldFilter || c.changes.some(function (x) { return x.field === fieldFilter; }); }).map(function (c) {
          return h('div', { style: 'padding:10px 0;border-bottom:1px dashed var(--line)' }, h('div', { class: 'url' }, c.url), h('div', { style: 'margin-top:4px;display:grid;grid-template-columns:130px 1fr;gap:3px 12px;font-size:13px' }, c.changes.map(function (x) {
            return [h('span', { class: 'muted', style: 'font-weight:600' }, LABELS[x.field] || x.field), h('span', { style: 'word-break:break-word' }, h('span', { style: 'color:var(--err);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--err) 50%,transparent)' }, val(x.before, x.field)), '  →  ', h('span', { style: 'color:var(--ok);font-weight:600' }, val(x.after, x.field)))];
          })));
        });
      } else {
        var src = k === 'iadded' ? d.issues.added : k === 'iresolved' ? d.issues.resolved : d.issues.persisting;
        list = src.map(function (i) { return h('div', { class: 'list-row' }, CS.sevBadge(i.severity), h('div', { class: 'grow' }, h('b', null, i.checkId), h('div', { class: 'url' }, i.url), h('div', { class: 'note' }, i.message, i.messageBefore ? '  (was: ' + i.messageBefore + ')' : ''))); });
      }
      if (!list || !list.length) { box.appendChild(h('div', { class: 'empty' }, 'Nothing here.')); return; }
      var shown = 0, rowsEl = h('div'), more = h('button', { class: 'btn sm no-print', style: 'margin-top:10px', onclick: next }, '');
      function next() { var end = Math.min(list.length, shown + 100); for (; shown < end; shown++) rowsEl.appendChild(list[shown]); more.style.display = shown < list.length ? '' : 'none'; more.textContent = 'Show more (' + n(list.length - shown) + ' left)'; }
      next(); box.appendChild(rowsEl); box.appendChild(more);
      var total = active[2];
      if (total > list.length && k !== 'changed') box.appendChild(h('p', { class: 'note' }, 'List truncated to ' + n(d.limit) + ' of ' + n(total) + ' entries; use --json for the full diff.'));
    }
    paint();
  }

  function mountStandalone(root, d) {
    var shell = h('div', { class: 'cs tabs' });
    var main = h('main', { class: 'cs-main', style: 'max-width:1200px;margin:0 auto' });
    main.appendChild(h('div', { class: 'topbar' }, h('div', { style: 'display:flex;gap:12px;align-items:center' }, CS.logo(34), h('div', { class: 'grow' }, h('h1', null, 'Crawl comparison'), h('div', { class: 'sub' }, d.a.seed + (d.a.seed === d.b.seed ? '' : '  →  ' + d.b.seed)))), h('div', { style: 'margin-left:auto' }, CS.themeToggle())));
    var body = h('div'); main.appendChild(body); shell.appendChild(main); root.appendChild(shell);
    CS.installTips(root); render(body, d);
  }
  g.DiffViewer = { render: render, mountStandalone: mountStandalone };
})(window);
