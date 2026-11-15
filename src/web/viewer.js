/* crawlscope report viewer: renders a ReportData payload (see src/report/data.ts). */
(function (g) {
  'use strict';
  var CS = g.CS, h = CS.h, n = CS.n;
  var SEV = ['error', 'warning', 'notice'];
  var SEVC = { error: 'var(--err)', warning: 'var(--warn-fill)', notice: 'var(--note)' };
  var F = { INDEXABLE: 1, HTML: 2, NOINDEX: 4, NOFOLLOW: 8, BLOCKED: 16, SITEMAP: 32, REDIRECT: 64, ERROR: 128 };

  function mount(root, D, opts) {
    opts = opts || {};
    var P = D.pages, N = P.n, urls = D.urls, strs = D.str;
    var urlIdx = new Map(); for (var i = 0; i < N; i++) urlIdx.set(urls[i], i);
    var sections = [];
    var views = {};
    var current = null;
    var pending = {};

    // ---------- derived indices ----------
    var checkOf = D.checks;
    var byCheck = checkOf.map(function () { return []; });
    for (var k = 0; k < D.issues.c.length; k++) byCheck[D.issues.c[k]].push(k);
    var issuesByUrl = null;
    function pageIssues(u) {
      if (!issuesByUrl) { issuesByUrl = new Map(); for (var q = 0; q < D.issues.u.length; q++) { var a = issuesByUrl.get(D.issues.u[q]); if (!a) issuesByUrl.set(D.issues.u[q], (a = [])); a.push(q); } }
      return issuesByUrl.get(u) || [];
    }
    var LI = null;
    function linkIndex() {
      if (LI) return LI;
      var L = D.links, m = L.length / 4, oc = new Int32Array(N + 1), ic = new Int32Array(N + 1), j;
      for (j = 0; j < m; j++) { oc[L[j * 4] + 1]++; ic[L[j * 4 + 1] + 1]++; }
      for (j = 0; j < N; j++) { oc[j + 1] += oc[j]; ic[j + 1] += ic[j]; }
      var oa = new Int32Array(m), ia = new Int32Array(m), op = oc.slice(), ip = ic.slice();
      for (j = 0; j < m; j++) { oa[op[L[j * 4]]++] = j; ia[ip[L[j * 4 + 1]]++] = j; }
      LI = { oc: oc, ic: ic, oa: oa, ia: ia };
      return LI;
    }
    function titleOf(i) { return P.title[i] < 0 ? '' : strs[P.title[i]]; }

    // ---------- layout ----------
    var tabsMode = opts.layout === 'tabs';
    var shell = h('div', { class: 'cs' + (tabsMode ? ' tabs' : '') });
    var nav = h('nav', { class: 'nav', 'aria-label': 'Sections' });
    var side = h('aside', { class: 'cs-side' },
      h('div', { class: 'brand' }, CS.logo(30), h('div', null, 'crawlscope', h('small', null, 'SEO · GEO · AEO'))),
      nav,
      h('div', { class: 'side-foot' }, h('span', null, D.meta.tool), h('span', null, 'Generated ' + CS.date(D.meta.generatedAt))));
    var main = h('main', { class: 'cs-main' });
    var errCount = D.summary.bySeverity.error;
    var topbar = h('div', { class: 'topbar' },
      h('div', { class: 'grow' }, h('h1', null, D.meta.seed),
        h('div', { class: 'sub' }, 'Crawled ' + CS.date(D.meta.startedAt) + ' · ' + CS.dur(D.meta.durationMs) + ' · ' + n(N) + ' URLs' +
          (D.meta.status === 'partial' ? ' · interrupted (partial)' : '') + (D.meta.truncated ? ' · stopped at page limit' : ''))),
      h('div', { class: 'no-print', style: 'display:flex;gap:8px;align-items:center' }, opts.toolbar || null, opts.noTheme ? null : CS.themeToggle()));
    main.appendChild(topbar);
    shell.appendChild(side); shell.appendChild(main);
    root.appendChild(shell);
    CS.installTips(root);

    function addSection(id, label, ic, badge, render, cls) {
      var a = h('a', { href: '#', 'data-sec': id, onclick: function (e) { e.preventDefault(); show(id); } }, CS.icon(ic), label,
        badge !== undefined && badge !== null ? h('span', { class: 'badge' + (badge.err ? ' err' : '') }, badge.text) : null);
      nav.appendChild(a);
      var v = h('section', { class: 'view ' + (cls || ''), id: 'v-' + id, 'aria-label': label });
      main.appendChild(v);
      views[id] = { el: v, link: a, render: render, done: false };
      sections.push(id);
    }
    function show(id, params, silent) {
      if (!views[id]) id = 'overview';
      if (params) pending[id] = params;
      var vw = views[id];
      sections.forEach(function (sid) { views[sid].el.classList.toggle('on', sid === id); views[sid].link.classList.toggle('on', sid === id); });
      if (!vw.done) { vw.done = true; vw.api = vw.render(vw.el) || {}; }
      if (vw.api.onShow) { vw.api.onShow(pending[id]); delete pending[id]; }
      current = id;
      if (!silent && opts.setRoute) opts.setRoute(id);
      else if (!silent && !opts.setRoute) { try { history.replaceState(null, '', '#/' + id); } catch (e) { /* ignore */ } }
      window.scrollTo(0, 0);
    }

    // ---------- small builders ----------
    function card(title, body, right) { return h('div', { class: 'card' }, title ? h('h3', { class: 'card-h' }, title, right ? h('span', { class: 'r' }, right) : null) : null, body); }
    function urlLink(u, label) {
      return h('button', { class: 'link-btn url', title: 'Open details', onclick: function () { openPage(u); } }, label || urls[u]);
    }
    function emptyNote(t) { return h('div', { class: 'empty' }, t); }
    function kpi(label, value, sub) { return h('div', { class: 'kpi' }, h('b', { class: 'num' }, value), h('span', null, label), sub ? h('small', null, sub) : null); }
    function pagesLink(label, set, title) { return h('button', { class: 'btn sm', onclick: function () { show('pages', { label: title || label, set: set }); } }, label); }
    function statusClass(i) {
      var f = P.flags[i];
      if (f & F.BLOCKED) return 'blocked';
      if (f & F.ERROR || !P.status[i]) return 'err';
      return String(Math.floor(P.status[i] / 100)) + 'xx';
    }

    // =====================================================================
    // Overview
    // =====================================================================
    function renderOverview(el) {
      var S = D.summary, sc = S.healthScore;
      var hero = h('div', { class: 'grid g-hero' });
      hero.appendChild(card('Health score', h('div', { class: 'ring-wrap' }, CS.ring(sc, { label: 'Health score' }),
        h('div', { class: 'ring-label' }, h('b', null, CS.scoreLabel(sc)), 'Weighted by issue severity and how widespread each issue is.'))));
      hero.appendChild(card('At a glance', h('div', { class: 'kpis' },
        kpi('Pages crawled', n(S.pagesCrawled)), kpi('Indexable', n(S.indexablePages), S.htmlPages ? Math.round((S.indexablePages / Math.max(1, S.htmlPages)) * 100) + '% of HTML' : ''),
        kpi('Issues', n(S.issuesTotal), S.byCheck.length + ' checks'), kpi('Avg response', CS.ms(S.avgResponseTimeMs)), kpi('Max depth', n(S.maxDepth)),
        kpi('Internal links', n(S.internalLinks), n(S.externalLinks) + ' external'))));
      var total = S.bySeverity.error + S.bySeverity.warning + S.bySeverity.notice;
      hero.appendChild(card('Issues by severity', h('div', null,
        CS.stack(SEV.map(function (x) { return { value: S.bySeverity[x], color: SEVC[x], label: CS.cap(x) + 's' }; })),
        h('div', { class: 'legend' }, SEV.map(function (x) {
          return h('a', { href: '#', onclick: function (e) { e.preventDefault(); show('issues', { sev: x }); } }, h('i', { class: 'sw', style: 'background:' + SEVC[x] }), CS.cap(x) + 's', h('b', { class: 'num' }, n(S.bySeverity[x])));
        })),
        total === 0 ? h('p', { class: 'note' }, 'No issues found. Nice.') : null)));
      el.appendChild(hero);

      // distribution charts
      var codes = Object.keys(S.statusCodes).sort();
      var cls = { '2': 'var(--s2)', '3': 'var(--s3)', '4': 'var(--s4)', '5': 'var(--s5)' };
      var statusCard = card('Status codes', h('div', null, CS.hbars(codes.map(function (k) {
        return { label: k, value: S.statusCodes[k], color: cls[k.charAt(0)] || 'var(--sx)', tip: k === 'blocked' ? 'Blocked by robots.txt (not fetched)' : k === 'error' ? 'Request failed (DNS, timeout, TLS…)' : 'HTTP ' + k };
      }))));
      var depthCounts = [], unreach = 0, DMAX = 10;
      for (var i = 0; i < N; i++) { var d = P.depth[i]; if (d < 0) unreach++; else { d = Math.min(d, DMAX); depthCounts[d] = (depthCounts[d] || 0) + 1; } }
      var dbars = []; for (var d2 = 0; d2 < depthCounts.length; d2++) dbars.push({ label: d2 === DMAX ? DMAX + '+' : String(d2), value: depthCounts[d2] || 0, tip: 'Depth ' + d2 + ': ' + n(depthCounts[d2] || 0) + ' pages' });
      if (unreach) dbars.push({ label: 'n/a', value: unreach, color: 'var(--sx)', tip: n(unreach) + ' pages not reachable by links (sitemap only)' });
      var depthCard = card('Crawl depth', CS.colChart(dbars, { label: 'Pages by click depth' }), 'clicks from start');
      var edges = [100, 250, 500, 1000, 2000, 3000], labels = ['<100', '<250', '<500', '<1s', '<2s', '<3s', '3s+'], hist = labels.map(function () { return 0; });
      for (i = 0; i < N; i++) { var t = P.rt[i]; if (t < 0) continue; var b = 0; while (b < edges.length && t >= edges[b]) b++; hist[b]++; }
      var hcol = ['var(--accent)', 'var(--accent)', 'var(--accent)', 'var(--accent)', 'var(--warn-fill)', 'var(--warn-fill)', 'var(--err)'];
      var rtCard = card('Response time', CS.colChart(labels.map(function (l, j) { return { label: l, value: hist[j], color: hcol[j], tip: 'Response ' + l + ' ms: ' + n(hist[j]) + ' pages' }; }), { label: 'Response time histogram' }), 'ms · amber ≥ 1s · red ≥ 3s');
      el.appendChild(h('div', { class: 'grid g3' }, statusCard, depthCard, rtCard));

      // top issues + ai + lists
      var top = S.byCheck.slice(0, 8), meta = {}; checkOf.forEach(function (c) { meta[c.id] = c; });
      var topCard = card('Top issues', top.length ? h('div', null, top.map(function (t2) {
        return h('div', { class: 'list-row' }, CS.sevBadge(t2.severity), h('button', { class: 'link-btn grow', onclick: function () { show('issues', { open: t2.checkId }); } }, meta[t2.checkId] ? meta[t2.checkId].title : t2.checkId), h('b', { class: 'num' }, n(t2.count)));
      })) : emptyNote('No issues found.'), h('a', { href: '#', onclick: function (e) { e.preventDefault(); show('issues'); } }, 'All issues →'));
      var aiCard;
      if (D.ai) {
        var ai = D.ai, allowed = ai.bots.filter(function (b2) { return b2.allowed; }).length;
        aiCard = card('AI readiness', h('div', null, h('div', { class: 'ring-wrap' }, CS.ring(ai.score, { size: 96, stroke: 10, color: 'var(--accent)', label: 'AI readiness' }),
          h('div', { class: 'ring-label' }, h('b', null, allowed + ' of ' + ai.bots.length + ' AI bots allowed'), ai.llmsTxt.present ? 'llms.txt ' + (ai.llmsTxt.valid ? 'found & valid' : 'found, has problems') : 'No llms.txt')),
          h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-top:14px' }, ai.bots.map(function (b2) {
            return h('span', { class: 'sev ' + (b2.allowed ? (b2.partial ? 'notice' : 'ok') : 'error'), 'data-tip': b2.bot + ' · ' + b2.purpose + ' · ' + (b2.allowed ? (b2.partial ? 'partially allowed' : 'allowed') : 'blocked') }, b2.bot);
          }))), h('a', { href: '#', onclick: function (e) { e.preventDefault(); show('ai'); } }, 'Details →'));
      } else aiCard = card('AI readiness', emptyNote('Not computed for this crawl.'));
      el.appendChild(h('div', { class: 'grid g-21' }, topCard, aiCard));

      var slow = []; for (i = 0; i < N; i++) if (P.rt[i] >= 0) slow.push(i);
      slow.sort(function (a, b3) { return P.rt[b3] - P.rt[a]; });
      var inl = []; for (i = 0; i < N; i++) if (P.flags[i] & F.HTML && P.status[i] === 200) inl.push(i);
      inl.sort(function (a, b3) { return P.inl[b3] - P.inl[a]; });
      function ul(list, fn) { return list.length ? h('div', null, list.map(function (ix) { return h('div', { class: 'list-row' }, h('span', { class: 'grow', style: 'overflow:hidden' }, urlLink(ix)), h('b', { class: 'num' }, fn(ix))); })) : emptyNote('Nothing to show.'); }
      el.appendChild(h('div', { class: 'grid g2' }, card('Slowest pages', ul(slow.slice(0, 6), function (ix) { return CS.ms(P.rt[ix]); })), card('Most linked-to pages', ul(inl.slice(0, 6), function (ix) { return n(P.inl[ix]) + ' in'; }))));
    }

    // =====================================================================
    // Issues
    // =====================================================================
    function renderIssues(el) {
      var st = { sev: 'all', q: '', cat: 'all' }, groups = [];
      var bar = h('div', { class: 'no-print', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px' });
      var chipBox = h('div', { class: 'chips' });
      var q = h('input', { class: 'input', type: 'search', placeholder: 'Filter checks…', 'aria-label': 'Filter checks', oninput: function () { st.q = q.value.toLowerCase(); paint(); } });
      var cats = {}; checkOf.forEach(function (c, ci) { if (byCheck[ci].length) cats[c.cat] = 1; });
      var catSel = h('select', { class: 'input', 'aria-label': 'Category', onchange: function () { st.cat = catSel.value; paint(); } }, h('option', { value: 'all' }, 'All categories'), Object.keys(cats).sort().map(function (c) { return h('option', { value: c }, c); }));
      bar.appendChild(chipBox); bar.appendChild(h('div', { style: 'flex:1' })); bar.appendChild(q); bar.appendChild(catSel);
      var list = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
      el.appendChild(bar); el.appendChild(list);
      var rank = { error: 0, warning: 1, notice: 2 };
      checkOf.forEach(function (c, ci) { if (byCheck[ci].length) groups.push({ c: c, ci: ci, count: byCheck[ci].length }); });
      groups.sort(function (a, b) { return rank[a.c.sev] - rank[b.c.sev] || b.count - a.count; });
      var openSet = {};

      function paintChips() {
        CS.clear(chipBox);
        var cnt = { all: D.issues.c.length, error: 0, warning: 0, notice: 0 };
        groups.forEach(function (gp) { cnt[gp.c.sev] += gp.count; });
        ['all'].concat(SEV).forEach(function (x) {
          chipBox.appendChild(h('button', { class: 'chip' + (st.sev === x ? ' on' : ''), onclick: function () { st.sev = x; paint(); } }, x === 'all' ? 'All' : CS.cap(x) + 's', h('span', { class: 'n' }, n(cnt[x]))));
        });
      }
      function paint() {
        paintChips(); CS.clear(list);
        var shown = 0;
        groups.forEach(function (gp) {
          if (st.sev !== 'all' && gp.c.sev !== st.sev) return;
          if (st.cat !== 'all' && gp.c.cat !== st.cat) return;
          if (st.q && (gp.c.title + ' ' + gp.c.id).toLowerCase().indexOf(st.q) < 0) return;
          shown++; list.appendChild(group(gp));
        });
        if (!shown) list.appendChild(card(null, emptyNote(D.issues.c.length ? 'No checks match these filters.' : 'No issues found. Nice work.')));
      }
      function group(gp) {
        var c = gp.c, isOpen = !!openSet[c.id];
        var body = h('div', { class: 'issue-body', style: 'display:' + (isOpen ? 'block' : 'none') + ';padding-top:14px' });
        var head = h('button', { class: 'issue-head', 'aria-expanded': String(isOpen), style: 'all:unset;box-sizing:border-box;display:flex;gap:12px;align-items:center;width:100%;cursor:pointer' },
          CS.sevBadge(c.sev), h('div', { style: 'flex:1;min-width:0' }, h('b', null, c.title), h('div', { class: 'note' }, c.cat + ' · ' + c.id)),
          h('b', { class: 'num', style: 'font-size:18px' }, n(gp.count)));
        var filled = false;
        function fill() {
          if (filled) return; filled = true;
          body.appendChild(h('p', { class: 'dim', style: 'margin:0 0 10px' }, c.desc));
          body.appendChild(h('div', { class: 'callout' }, h('b', null, 'How to fix: '), c.fix));
          var idxs = byCheck[gp.ci], pageSet = [], seen = {};
          idxs.forEach(function (k) { var u = D.issues.u[k]; if (u < N && !seen[u]) { seen[u] = 1; pageSet.push(u); } });
          body.appendChild(h('div', { class: 'no-print', style: 'display:flex;gap:8px;margin:12px 0 6px' },
            pageSet.length ? pagesLink('Show ' + n(pageSet.length) + ' in pages table', pageSet, c.title) : null,
            h('button', { class: 'btn sm', onclick: function () { CS.download(c.id + '.txt', idxs.map(function (k) { return urls[D.issues.u[k]]; }).join('\n'), 'text/plain'); } }, CS.icon('download', 14), 'Export URLs')));
          var rows = h('div'), shownN = 0, more = h('button', { class: 'btn sm no-print', style: 'margin-top:8px', onclick: next }, '');
          function next() {
            var end = Math.min(idxs.length, shownN + 50);
            for (; shownN < end; shownN++) {
              var k = idxs[shownN], u = D.issues.u[k];
              rows.appendChild(h('div', { class: 'list-row' }, h('div', { class: 'grow' }, u < N ? urlLink(u) : h('span', { class: 'url' }, urls[u]), h('div', { class: 'note' }, D.issues.m[k]))));
            }
            more.style.display = shownN < idxs.length ? '' : 'none';
            more.textContent = 'Show more (' + n(idxs.length - shownN) + ' left)';
          }
          next();
          body.appendChild(rows); body.appendChild(more);
        }
        var cardEl = h('div', { class: 'card', id: 'chk-' + c.id, style: 'padding:14px 18px' }, head, body);
        head.addEventListener('click', function () {
          var o = body.style.display === 'none';
          body.style.display = o ? 'block' : 'none'; openSet[c.id] = o; head.setAttribute('aria-expanded', String(o));
          if (o) fill();
        });
        if (isOpen) fill();
        return cardEl;
      }
      paint();
      return {
        onShow: function (p) {
          if (!p) return;
          if (p.sev) { st.sev = p.sev; }
          if (p.open) { openSet[p.open] = true; st.sev = 'all'; st.q = ''; q.value = ''; st.cat = 'all'; catSel.value = 'all'; }
          paint();
          if (p.open) { var t2 = document.getElementById('chk-' + p.open); if (t2) t2.scrollIntoView({ block: 'center' }); }
        }
      };
    }

    // =====================================================================
    // Pages table (virtualised)
    // =====================================================================
    function renderPages(el) {
      el.classList.add('pages-view');
      var ROW = 36, st = { q: '', status: 'all', idx: 'all', iss: 'all', sort: -1, dir: 1, set: null, setLabel: '', sd: '' };
      var COLS = [
        { k: 'url', label: 'URL', w: 'minmax(300px,2.4fr)' }, { k: 'status', label: 'Status', w: '74px' }, { k: 'idx', label: 'Index', w: '66px' },
        { k: 'title', label: 'Title', w: 'minmax(180px,1.5fr)' }, { k: 'depth', label: 'Depth', w: '62px', num: 1 }, { k: 'rt', label: 'Time', w: '78px', num: 1 },
        { k: 'size', label: 'Size', w: '78px', num: 1 }, { k: 'inl', label: 'In', w: '58px', num: 1 }, { k: 'words', label: 'Words', w: '68px', num: 1 }, { k: 'iss', label: 'Issues', w: '66px', num: 1 }
      ];
      var tpl = COLS.map(function (c) { return c.w; }).join(' ');
      var countEl = h('span', { class: 'note' });
      var qIn = h('input', { class: 'input', type: 'search', placeholder: 'Search URL or title…', 'aria-label': 'Search pages', style: 'width:100%;padding-left:32px' });
      var timer = null; qIn.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { st.q = qIn.value.toLowerCase(); refresh(); }, 120); });
      function sel(key, opts2) {
        var s2 = h('select', { class: 'input', 'aria-label': key, onchange: function () { st[key] = s2.value; refresh(); } }, opts2.map(function (o) { return h('option', { value: o[0] }, o[1]); }));
        return s2;
      }
      var selStatus = sel('status', [['all', 'All statuses'], ['2xx', '2xx success'], ['3xx', '3xx redirect'], ['4xx', '4xx client error'], ['5xx', '5xx server error'], ['err', 'Failed / blocked']]);
      var selIdx = sel('idx', [['all', 'Any indexability'], ['yes', 'Indexable'], ['no', 'Not indexable'], ['html', 'HTML pages only'], ['nonhtml', 'Non-HTML']]);
      var selIss = sel('iss', [['all', 'Any issues'], ['any', 'Has issues'], ['error', 'Has errors'], ['none', 'No issues']]);
      var sdSel = h('select', { class: 'input', 'aria-label': 'Structured data type', onchange: function () { st.sd = sdSel.value; refresh(); } }, h('option', { value: '' }, 'Any schema type'), D.sd.types.map(function (t) { return h('option', { value: t.type }, t.type + ' (' + t.pages + ')'); }));
      var setChip = h('button', { class: 'chip on', style: 'display:none', title: 'Clear this filter', onclick: function () { st.set = null; refresh(); } });
      var exportBtn = h('button', { class: 'btn sm', onclick: exportCsv }, CS.icon('download', 14), 'Export CSV');
      el.appendChild(h('div', { class: 'no-print', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px' },
        h('div', { class: 'search' }, CS.icon('search', 15), qIn), selStatus, selIdx, selIss, sdSel, setChip, h('span', { style: 'flex:1' }), countEl, exportBtn));
      var head = h('div', { class: 'vt-head', style: 'display:grid;grid-template-columns:' + tpl }, COLS.map(function (c, ci) {
        return h('button', { class: 'vt-th' + (c.num ? ' r' : ''), 'data-ci': ci, onclick: function () { if (st.sort === ci) st.dir = -st.dir; else { st.sort = ci; st.dir = c.num ? -1 : 1; } refresh(); } }, c.label, h('i', null));
      }));
      var spacer = h('div', { class: 'vt-spacer' }), layer = h('div', { class: 'vt-layer' });
      var body = h('div', { class: 'vt-body' }, spacer, layer);
      var scroller = h('div', { class: 'vt', tabindex: 0 }, head, body);
      el.appendChild(h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, scroller));
      var style = h('style', null, '.vt{height:calc(100vh - 210px);min-height:380px;overflow:auto;position:relative}.vt-head{position:sticky;top:0;z-index:3;background:var(--surface-2);border-bottom:1px solid var(--line-2);min-width:1060px}' +
        '.vt-th{all:unset;box-sizing:border-box;cursor:pointer;padding:9px 10px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:flex;align-items:center;gap:4px;white-space:nowrap}.vt-th:hover{color:var(--ink)}.vt-th.r{justify-content:flex-end}' +
        '.vt-th.s{color:var(--accent)}.vt-th.s i::after{content:"▲";font-size:8px}.vt-th.s.d i::after{content:"▼"}' +
        '.vt-body{position:relative;min-width:1060px}.vt-layer{position:absolute;left:0;right:0;top:0}' +
        '.vt-row{display:grid;grid-template-columns:' + tpl + ';height:' + ROW + 'px;align-items:center;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px}' +
        '.vt-row:hover{background:var(--surface-2)}.vt-row>*{padding:0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vt-row .r{text-align:right;font-variant-numeric:tabular-nums}' +
        '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}');
      el.appendChild(style);
      var view = new Int32Array(0);

      function sortKey(ci) {
        var k = COLS[ci].k;
        if (k === 'url') return function (a, b) { return urls[a] < urls[b] ? -1 : urls[a] > urls[b] ? 1 : 0; };
        if (k === 'title') return function (a, b) { return titleOf(a).localeCompare(titleOf(b)); };
        if (k === 'idx') return function (a, b) { return (P.flags[a] & 1) - (P.flags[b] & 1); };
        var arr = k === 'iss' ? P.issues : P[k];
        return function (a, b) { return arr[a] - arr[b]; };
      }
      function refresh() {
        var q = st.q, out = [], sdq = st.sd, base = st.set;
        var count = base ? base.length : N;
        for (var t = 0; t < count; t++) {
          var i = base ? base[t] : t, f = P.flags[i], s2 = P.status[i];
          if (q && urls[i].toLowerCase().indexOf(q) < 0 && titleOf(i).toLowerCase().indexOf(q) < 0) continue;
          if (st.status !== 'all') {
            var sc = statusClass(i);
            if (st.status === 'err' ? !(sc === 'err' || sc === 'blocked') : sc !== st.status) continue;
          }
          if (st.idx === 'yes' && !(f & F.INDEXABLE)) continue;
          if (st.idx === 'no' && (f & F.INDEXABLE)) continue;
          if (st.idx === 'html' && !(f & F.HTML)) continue;
          if (st.idx === 'nonhtml' && (f & F.HTML)) continue;
          if (st.iss === 'any' && !P.issues[i]) continue;
          if (st.iss === 'none' && P.issues[i]) continue;
          if (st.iss === 'error' && P.sev[i] < 3) continue;
          if (sdq && (P.sd[i] < 0 || ('|' + strs[P.sd[i]].split(' | ').join('|') + '|').indexOf('|' + sdq + '|') < 0)) continue;
          void s2; out.push(i);
        }
        view = Int32Array.from(out);
        if (st.sort >= 0) { var cmp = sortKey(st.sort), dir = st.dir; view.sort(function (a, b) { return dir * cmp(a, b) || a - b; }); }
        spacer.style.height = view.length * ROW + 'px';
        countEl.textContent = n(view.length) + (view.length === N ? '' : ' of ' + n(N)) + ' pages';
        Array.prototype.forEach.call(head.children, function (b, ci) { b.className = 'vt-th' + (COLS[ci].num ? ' r' : '') + (st.sort === ci ? ' s' + (st.dir < 0 ? ' d' : '') : ''); });
        setChip.style.display = st.set ? '' : 'none';
        if (st.set) setChip.textContent = st.setLabel + ' (' + n(st.set.length) + ')  ✕';
        scroller.scrollTop = 0; draw();
      }
      var raf = 0;
      scroller.addEventListener('scroll', function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); });
      function draw() {
        var vh = scroller.clientHeight || 600, top = Math.max(0, scroller.scrollTop - head.offsetHeight);
        var first = Math.max(0, Math.floor(top / ROW) - 6), last = Math.min(view.length, Math.ceil((top + vh) / ROW) + 6);
        layer.style.top = first * ROW + 'px';
        var frag = document.createDocumentFragment();
        for (var r = first; r < last; r++) frag.appendChild(row(view[r]));
        CS.clear(layer).appendChild(frag);
      }
      function row(i) {
        var f = P.flags[i];
        var el2 = h('div', { class: 'vt-row', role: 'row', onclick: function () { openPage(i); } },
          h('div', { class: 'mono', title: urls[i] }, urls[i]), h('div', null, CS.statusPill(P.status[i], f)),
          h('div', null, h('i', { class: 'dot', style: 'background:' + (f & F.INDEXABLE ? 'var(--s2)' : 'var(--sx)') }), f & F.INDEXABLE ? 'Yes' : 'No'),
          h('div', { title: titleOf(i), class: titleOf(i) ? '' : 'muted' }, titleOf(i) || '—'),
          h('div', { class: 'r' }, P.depth[i] < 0 ? '–' : P.depth[i]), h('div', { class: 'r' }, CS.ms(P.rt[i])), h('div', { class: 'r' }, CS.bytes(P.size[i])),
          h('div', { class: 'r' }, n(P.inl[i])), h('div', { class: 'r' }, P.words[i] < 0 ? '–' : n(P.words[i])),
          h('div', { class: 'r' }, P.issues[i] ? h('span', { class: 'sev ' + (P.sev[i] === 3 ? 'error' : P.sev[i] === 2 ? 'warning' : 'notice') }, P.issues[i]) : h('span', { class: 'muted' }, '0')));
        return el2;
      }
      function exportCsv() {
        var esc = function (v) { v = v === null || v === undefined ? '' : String(v); if (/^[=+@\t\r-]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        var lines = ['url,status,indexable,depth,title,response_ms,size_bytes,inlinks,words,issues'];
        for (var r = 0; r < view.length; r++) { var i = view[r]; lines.push([urls[i], P.status[i], P.flags[i] & 1 ? 'true' : 'false', P.depth[i] < 0 ? '' : P.depth[i], titleOf(i), P.rt[i] < 0 ? '' : P.rt[i], P.size[i] < 0 ? '' : P.size[i], P.inl[i], P.words[i] < 0 ? '' : P.words[i], P.issues[i]].map(esc).join(',')); }
        CS.download('pages-filtered.csv', lines.join('\r\n') + '\r\n', 'text/csv');
      }
      refresh();
      window.addEventListener('resize', draw);
      return {
        onShow: function (p) {
          if (!p) { draw(); return; }
          st.set = p.set || null; st.setLabel = p.label || 'Filter';
          if (p.reset) { st.status = st.idx = st.iss = 'all'; st.q = ''; qIn.value = ''; st.sd = ''; }
          if (p.sd) { st.sd = p.sd; sdSel.value = p.sd; }
          if (p.status) { st.status = p.status; selStatus.value = p.status; }
          refresh();
        }
      };
    }

    // =====================================================================
    // Links
    // =====================================================================
    function renderLinks(el) {
      var htmlOk = []; for (var i = 0; i < N; i++) if (P.flags[i] & F.HTML && P.status[i] === 200) htmlOk.push(i);
      var orphans = htmlOk.filter(function (ix) { return P.inl[ix] === 0 && P.depth[ix] !== 0; });
      var weak = htmlOk.filter(function (ix) { return P.inl[ix] === 1; });
      var avg = htmlOk.length ? htmlOk.reduce(function (a, ix) { return a + P.inl[ix]; }, 0) / htmlOk.length : 0;
      el.appendChild(h('div', { class: 'grid g4' }, card(null, kpi('Internal links', n(D.linkTotals.internal))), card(null, kpi('External links', n(D.linkTotals.external))),
        card(null, kpi('Orphan pages', n(orphans.length), 'no internal inlinks')), card(null, kpi('Avg inlinks / page', avg.toFixed(1), n(weak.length) + ' pages with just one'))));
      if (D.linksTruncated) el.appendChild(h('div', { class: 'callout warn', style: 'margin-bottom:16px' }, 'The embedded link table was capped for size; per-page link lists in the details drawer may be incomplete. Full data is in links.csv.'));
      function ranked(list, key, fmt) {
        var arr = list.slice().sort(function (a, b) { return P[key][b] - P[key][a]; }).slice(0, 15);
        return arr.length ? h('div', null, arr.map(function (ix) { return h('div', { class: 'list-row' }, h('span', { class: 'grow', style: 'overflow:hidden' }, urlLink(ix)), h('b', { class: 'num' }, fmt(P[key][ix]))); })) : emptyNote('Nothing to show.');
      }
      el.appendChild(h('div', { class: 'grid g2' }, card('Most inlinked pages', ranked(htmlOk, 'inl', function (v) { return n(v) + ' in'; })), card('Most outlinks (internal)', ranked(htmlOk, 'outi', function (v) { return n(v) + ' out'; }))));
      var orph = card('Orphan pages (no internal links point here)', orphans.length ? h('div', null, orphans.slice(0, 40).map(function (ix) { return h('div', { class: 'list-row' }, h('span', { class: 'grow' }, urlLink(ix)), P.flags[ix] & F.SITEMAP ? h('span', { class: 'tag' }, 'in sitemap') : null); }),
        orphans.length > 40 ? h('div', { style: 'margin-top:10px' }, pagesLink('Show all ' + n(orphans.length) + ' in pages table', orphans, 'Orphan pages')) : null) : emptyNote('No orphan pages found.'));
      var ext = D.external.filter(function (e) { return e.error || (e.status && e.status >= 400); });
      var extCard = card('External link check', D.external.length ? h('div', null, h('p', { class: 'note', style: 'margin-top:0' }, n(D.external.length) + ' checked · ' + n(ext.length) + ' broken'), ext.slice(0, 25).map(function (e) {
        return h('div', { class: 'list-row' }, h('span', { class: 'pill-s st' + (e.status ? Math.floor(e.status / 100) : 0) }, e.status || 'err'), h('span', { class: 'grow url' }, e.url), h('span', { class: 'note' }, 'from ' + e.linkedFrom));
      })) : h('p', { class: 'note' }, 'External links were not checked. Re-run with --external-check.'));
      el.appendChild(h('div', { class: 'grid g2' }, orph, extCard));
    }

    // =====================================================================
    // Sitemap & site
    // =====================================================================
    function renderSitemap(el) {
      var M = D.sitemap;
      var cards = [
        ['URLs in sitemaps', M.total, null, null], ['In sitemap but not crawled', M.notCrawled.length, M.notCrawled, 'Listed in a sitemap, never reached by the crawler (limits, robots or no links).'],
        ['Indexable but not in sitemap', M.notInSitemap.length, M.notInSitemap, 'Crawled, indexable pages missing from every sitemap.'], ['In sitemap but not 200', M.nonOk.length, M.nonOk, 'Sitemaps should list only final, indexable URLs.'],
        ['In sitemap but noindex', M.noindex.length, M.noindex, 'Conflicting signals: listed for indexing but marked noindex.'], ['Orphans (sitemap-only)', M.orphans.length, M.orphans, 'In a sitemap but no internal link points to them.']
      ];
      var grid = h('div', { class: 'grid g3' });
      cards.forEach(function (c) {
        var bad = c[1] > 0 && c[2];
        grid.appendChild(h('div', { class: 'card' }, h('div', { style: 'display:flex;align-items:baseline;gap:10px' }, h('b', { class: 'num', style: 'font-size:26px;letter-spacing:-.02em' }, n(c[1])), bad ? CS.sevBadge('warning') : c[2] ? h('span', { class: 'sev ok' }, 'Clean') : null), h('div', { style: 'font-weight:650;margin-top:2px' }, c[0]), c[3] ? h('div', { class: 'note' }, c[3]) : null,
          bad ? h('div', { class: 'no-print', style: 'margin-top:10px' }, h('button', { class: 'btn sm', onclick: function () { drawList(c[0], c[2]); } }, 'View list')) : null));
      });
      el.appendChild(grid);
      var listBox = h('div'); el.appendChild(listBox);
      function drawList(title, idxs) {
        CS.clear(listBox).appendChild(card(title + ' (' + n(idxs.length) + ')', h('div', null, idxs.slice(0, 100).map(function (ix) { return h('div', { class: 'list-row' }, h('span', { class: 'grow' }, ix < N ? urlLink(ix) : h('span', { class: 'url' }, urls[ix])), ix < N ? CS.statusPill(P.status[ix], P.flags[ix]) : null); }), idxs.length > 100 ? h('p', { class: 'note' }, '… and ' + n(idxs.length - 100) + ' more (see pages.csv / issues.csv)') : null)));
        listBox.scrollIntoView({ block: 'nearest' });
      }
      el.appendChild(h('div', { class: 'grid g2', style: 'margin-top:16px' },
        card('Sitemap files', M.files.length ? h('div', { class: 'scrollx' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['File', 'Type', 'Status', 'URLs'].map(function (x) { return h('th', null, x); }))),
          h('tbody', null, M.files.map(function (f) { return h('tr', null, h('td', { class: 'url' }, f.url, f.gzip ? h('span', { class: 'tag', style: 'margin-left:6px' }, 'gz') : null, f.error ? h('div', { class: 'note', style: 'color:var(--err)' }, f.error) : null), h('td', null, f.kind), h('td', null, f.status || '–'), h('td', { class: 'num' }, n(f.urlCount))); })))) : h('p', { class: 'note' }, 'No sitemap discovered (robots.txt, /sitemap.xml).')),
        card('robots.txt & site checks', h('div', null, h('dl', { class: 'kv' },
          h('dt', null, 'robots.txt'), h('dd', null, D.robots.present ? 'Found (HTTP ' + D.robots.status + ')' : 'Not found', ' · ', D.robots.mode),
          h('dt', null, 'Protocol'), h('dd', null, D.site.isHttps ? 'HTTPS' : 'HTTP only'), h('dt', null, 'HSTS'), h('dd', null, D.site.hsts || 'not set'),
          h('dt', null, 'HTTP → HTTPS'), h('dd', null, D.site.httpRedirect && D.site.httpRedirect.tested ? (D.site.httpRedirect.redirectsToHttps ? 'redirects' : 'does not redirect') : 'not tested'),
          h('dt', null, 'Favicon'), h('dd', null, D.site.favicon ? 'HTTP ' + D.site.favicon.status : '–'),
          h('dt', null, '404 handling'), h('dd', null, D.site.soft404 ? (D.site.soft404.status === 404 || D.site.soft404.status === 410 ? 'returns a real 404' : 'soft 404 (HTTP ' + D.site.soft404.status + ')') : '–')),
          D.robots.warnings.length ? h('div', { style: 'margin-top:10px' }, D.robots.warnings.slice(0, 5).map(function (w2) { return h('div', { class: 'note' }, 'line ' + w2.line + ': ' + w2.message); })) : null,
          D.robots.raw ? h('details', { style: 'margin-top:10px' }, h('summary', { style: 'cursor:pointer;font-weight:600' }, 'View robots.txt'), h('pre', { class: 'code' }, D.robots.raw)) : null))));
    }

    // =====================================================================
    // Structured data
    // =====================================================================
    function renderSD(el) {
      var S = D.sd, cov = S.htmlPages ? Math.round((S.pagesWith / S.htmlPages) * 100) : 0;
      el.appendChild(h('div', { class: 'grid g3' }, card('Coverage', h('div', { class: 'ring-wrap' }, CS.ring(cov, { size: 96, stroke: 10, color: 'var(--accent)', label: 'Structured data coverage' }), h('div', { class: 'ring-label' }, h('b', null, n(S.pagesWith) + ' of ' + n(S.htmlPages)), 'HTML pages carry structured data'))),
        card('Formats', Object.keys(S.formats).length ? CS.hbars(Object.keys(S.formats).map(function (k) { return { label: k, value: S.formats[k] }; })) : emptyNote('No structured data found.')),
        card('Problems', h('div', null, kpi('Pages with invalid markup', n(S.invalid.length)), S.invalid.length ? h('div', { style: 'margin-top:10px' }, pagesLink('Show in pages table', S.invalid, 'Invalid structured data')) : null))));
      el.appendChild(card('Schema types', S.types.length ? h('div', { class: 'scrollx' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Type', 'Pages', 'Items', ''].map(function (x) { return h('th', null, x); }))),
        h('tbody', null, S.types.map(function (t) { return h('tr', null, h('td', { style: 'font-weight:600' }, t.type), h('td', { class: 'num' }, n(t.pages)), h('td', { class: 'num' }, n(t.items)), h('td', { style: 'text-align:right' }, h('button', { class: 'btn sm no-print', onclick: function () { show('pages', { sd: t.type, label: t.type, reset: true }); } }, 'Show pages'))); })))) : emptyNote('No schema.org markup found on crawled pages.')));
    }

    // =====================================================================
    // AI readiness
    // =====================================================================
    function renderAI(el) {
      var ai = D.ai;
      if (!ai) { el.appendChild(card(null, emptyNote('AI readiness was not computed for this crawl.'))); return; }
      el.appendChild(h('div', { class: 'grid g2' },
        card('AI readiness score', h('div', null, h('div', { class: 'ring-wrap', style: 'margin-bottom:16px' }, CS.ring(ai.score, { size: 120, color: 'var(--accent)', label: 'AI readiness' }), h('div', { class: 'ring-label' }, h('b', null, 'Out of 100'), 'A heuristic checklist of signals that help AI answer engines find, read and cite your content.')),
          h('div', null, ai.components.map(function (c) {
            return h('div', { style: 'margin:10px 0' }, h('div', { style: 'display:flex;justify-content:space-between;font-weight:600;font-size:13px' }, h('span', null, c.label), h('span', { class: 'num' }, c.score + ' / ' + c.max)),
              h('div', { class: 'hbar', style: 'grid-template-columns:1fr;padding:3px 0' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + (c.max ? (c.score / c.max) * 100 : 0) + '%;background:' + (c.score >= c.max * 0.8 ? 'var(--s2)' : c.score >= c.max * 0.4 ? 'var(--s4)' : 'var(--s5)') }))),
              h('div', { class: 'note' }, c.note));
          }))), null),
        h('div', { style: 'display:flex;flex-direction:column;gap:16px;min-width:0' }, llmsCard('llms.txt', ai.llmsTxt), llmsCard('llms-full.txt', ai.llmsFullTxt), statsCard(ai))));
      var purposes = [['search', 'Search & answer retrieval'], ['user-fetch', 'User-initiated fetchers'], ['training', 'Model training'], ['mixed', 'Mixed / other']];
      var botCard = h('div', { class: 'card' }, h('h3', { class: 'card-h' }, 'AI crawlers in robots.txt', h('span', { class: 'r' }, 'who may fetch your site')));
      purposes.forEach(function (p) {
        var list = ai.bots.filter(function (b) { return b.purpose === p[0]; });
        if (!list.length) return;
        botCard.appendChild(h('div', { style: 'font-weight:650;margin:14px 0 8px;font-size:13px' }, p[1]));
        botCard.appendChild(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:8px' }, list.map(function (b) {
          var state = b.allowed ? (b.partial ? 'notice' : 'ok') : 'error', lab = b.allowed ? (b.partial ? 'Allowed*' : 'Allowed') : 'Blocked';
          return h('div', { style: 'border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--surface-2)', 'data-tip': b.note || b.matchedBy }, h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:center' }, h('b', { class: 'mono', style: 'white-space:nowrap' }, b.bot), h('span', { class: 'sev ' + state }, lab)), h('div', { class: 'note' }, b.vendor + ' · ' + (b.matchedBy === 'none' ? 'no rule' : b.matchedBy + ' rule')));
        })));
      });
      botCard.appendChild(h('p', { class: 'note', style: 'margin-bottom:0' }, '* Allowed with some paths disallowed. Blocking training crawlers and allowing search/retrieval bots is a common, deliberate policy; the grid reports what robots.txt says, not what is right for you.'));
      el.appendChild(botCard);
      var aiIssues = []; D.issues.c.forEach(function (c, k) { if (checkOf[c].cat === 'ai-readiness') aiIssues.push(k); });
      if (aiIssues.length) el.appendChild(h('div', { style: 'margin-top:16px' }, card('AI-readiness findings', h('div', null, aiIssues.slice(0, 60).map(function (k) { var c = checkOf[D.issues.c[k]]; var u = D.issues.u[k]; return h('div', { class: 'list-row' }, CS.sevBadge(c.sev), h('div', { class: 'grow' }, h('b', null, c.title), h('div', { class: 'note' }, D.issues.m[k]), u < N ? urlLink(u) : h('span', { class: 'url muted' }, urls[u]))); })))));
      el.appendChild(h('p', { class: 'note', style: 'margin-top:14px' }, ai.disclaimer));
    }
    function llmsCard(name, f) {
      var state = !f.present ? h('span', { class: 'sev off' }, 'Not found') : f.valid ? h('span', { class: 'sev ok' }, 'Found · valid') : h('span', { class: 'sev warning' }, 'Found · ' + f.problems.length + ' problem' + (f.problems.length === 1 ? '' : 's'));
      return card(name, h('div', null, h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, state, f.present ? h('span', { class: 'note' }, CS.bytes(f.sizeBytes) + ' · ' + f.linkCount + ' links · ' + f.sections.length + ' sections') : null),
        f.title ? h('div', { style: 'margin-top:8px;font-weight:650' }, f.title) : null, f.summary ? h('div', { class: 'note' }, f.summary) : null,
        f.problems.length ? h('ul', { style: 'margin:8px 0 0;padding-left:18px;font-size:12.5px' }, f.problems.slice(0, 6).map(function (p) { return h('li', null, p); })) : null,
        f.brokenLinks && f.brokenLinks.length ? h('div', { class: 'note', style: 'margin-top:6px;color:var(--err)' }, f.brokenLinks.length + ' listed link(s) do not resolve') : null,
        !f.present ? h('div', { class: 'note', style: 'margin-top:6px' }, 'Create ' + name + ' at your site root (llmstxt.org) to give AI tools a curated map of your content.') : null));
    }
    function statsCard(ai) {
      var s2 = ai.stats;
      return card('Page signals', h('div', { class: 'kpis' }, kpi('With JSON-LD', n(s2.pagesWithJsonLd), 'of ' + n(s2.htmlPages)), kpi('Use <main>', n(s2.pagesWithMain)), kpi('JS-only shells', n(s2.jsShellPages)),
        kpi('Articles w/ author', n(s2.articlesWithAuthor), 'of ' + n(s2.articleLikePages)), kpi('Articles w/ date', n(s2.articlesWithDate)), kpi('FAQ-like pages', n(s2.faqLikePages))));
    }

    // =====================================================================
    // Page detail drawer
    // =====================================================================
    var scrim = h('div', { class: 'scrim', onclick: closeDrawer }), drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Page details', 'aria-hidden': 'true' });
    root.appendChild(scrim); root.appendChild(drawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
    function closeDrawer() { drawer.classList.remove('on'); scrim.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true'); }
    function openPage(i) {
      CS.clear(drawer);
      var isPage = i < N, det = {};
      if (isPage && D.detail[i]) { try { det = JSON.parse(D.detail[i]); } catch (e) { det = {}; } }
      var href = CS.safeHref(urls[i]);
      drawer.appendChild(h('div', { class: 'drawer-h' }, h('div', { class: 'url' }, urls[i]),
        href ? h('a', { class: 'icon-btn', href: href, target: '_blank', rel: 'noopener noreferrer', title: 'Open the URL in a new tab', 'aria-label': 'Open URL' }, CS.icon('ext', 16)) : null,
        h('button', { class: 'icon-btn', onclick: closeDrawer, title: 'Close', 'aria-label': 'Close' }, CS.icon('x', 16))));
      var b = h('div', { class: 'drawer-b' });
      drawer.appendChild(b);
      var f = isPage ? P.flags[i] : 0;
      function sect(title, count, open, content) {
        var d = h('details', open ? { open: true } : null, h('summary', null, title, count !== null && count !== undefined ? h('span', { class: 'c' }, count) : null), h('div', { class: 'dbody' }, content));
        b.appendChild(d); return d;
      }
      function kvs(rows) { return h('dl', { class: 'kv' }, rows.filter(function (r) { return r[1] !== null && r[1] !== undefined && r[1] !== ''; }).map(function (r) { return [h('dt', null, r[0]), h('dd', null, r[1])]; })); }
      if (!isPage) { sect('Issues', null, true, h('div', null, pageIssues(i).map(function (k) { return issueRow(k); }))); drawer.classList.add('on'); scrim.classList.add('on'); return; }
      var stats = det.stats || [];
      sect('Overview', null, true, kvs([
        ['Status', h('span', null, CS.statusPill(P.status[i], f), ' ', det.statusText || '')], ['Indexable', f & F.INDEXABLE ? 'Yes' : 'No — ' + (det.indexability || '')],
        ['Title', titleOf(i) || h('span', { class: 'muted' }, 'missing')], ['Meta description', det.desc || h('span', { class: 'muted' }, 'missing')],
        ['H1', P.h1[i] >= 0 ? strs[P.h1[i]] : h('span', { class: 'muted' }, 'missing')], ['Canonical', det.canonicals ? det.canonicals.join(', ') : ''], ['Meta robots', det.metaRobots], ['Language', det.lang],
        ['Depth', P.depth[i] < 0 ? 'unreachable by links' : P.depth[i]], ['Response time', CS.ms(P.rt[i])], ['Size', CS.bytes(P.size[i])], ['Content type', P.ct[i] >= 0 ? strs[P.ct[i]] : ''],
        ['Words', P.words[i] >= 0 ? n(P.words[i]) : ''], ['Text / HTML', stats[1] !== null && stats[1] !== undefined ? stats[1] + '%' : ''], ['In sitemap', f & F.SITEMAP ? 'Yes' : 'No'], ['Error', det.error]]));
      var is = pageIssues(i);
      sect('Issues', is.length, is.length > 0, is.length ? h('div', null, is.map(issueRow)) : h('p', { class: 'note', style: 'margin:0' }, 'No issues found on this page.'));
      // redirect chain
      var chain = [i], cur = i, guard = 0;
      while (guard++ < 12 && det && (P.flags[cur] & F.REDIRECT)) {
        var dd = cur === i ? det : safeParse(D.detail[cur]); var nxt = dd.redirectTo ? urlIdx.get(dd.redirectTo) : undefined;
        if (nxt === undefined) { chain.push(dd.redirectTo || '?'); break; }
        if (chain.indexOf(nxt) >= 0) { chain.push('(loop) ' + urls[nxt]); break; }
        chain.push(nxt); cur = nxt;
      }
      if (chain.length > 1) sect('Redirect chain', chain.length - 1 + ' hop' + (chain.length > 2 ? 's' : ''), true, h('div', { class: 'chain' }, chain.map(function (x) { return typeof x === 'number' ? h('div', null, CS.statusPill(P.status[x], P.flags[x]), h('span', { class: 'url' }, urls[x])) : h('div', null, h('span', { class: 'url' }, String(x))); })));
      // links
      var LIx = linkIndex(), L = D.links;
      var inl = [], outl = [], t;
      for (t = LIx.ic[i]; t < LIx.ic[i + 1]; t++) inl.push(LIx.ia[t]);
      for (t = LIx.oc[i]; t < LIx.oc[i + 1]; t++) outl.push(LIx.oa[t]);
      function linkRows(list, dirOut) {
        var more = list.length > 40;
        return h('div', null, list.slice(0, 40).map(function (li) { var o = L[li * 4 + (dirOut ? 1 : 0)], an = L[li * 4 + 2], fl = L[li * 4 + 3];
          return h('div', { class: 'list-row' }, h('div', { class: 'grow' }, urlLink(o), h('div', { class: 'note' }, fl & 4 ? 'redirect' : an > 0 ? (strs[an - 1] ? '“' + strs[an - 1] + '”' : 'empty anchor') : '', fl & 1 ? ' · nofollow' : '')));
        }), more ? h('p', { class: 'note' }, '… and ' + n(list.length - 40) + ' more (see links.csv)') : null, !list.length ? h('p', { class: 'note', style: 'margin:0' }, 'None recorded.') : null);
      }
      sect('Inlinks', P.inl[i], false, linkRows(inl, false));
      sect('Outlinks (to crawled pages)', P.outi[i] + ' internal · ' + P.oute[i] + ' external', false, linkRows(outl, true));
      if (det.headers) sect('Response headers', Object.keys(det.headers).length, false, kvs(Object.keys(det.headers).map(function (k) { return [k, det.headers[k]]; })));
      if (det.sd) sect('Structured data', det.sd.length, false, h('div', null, det.sd.map(function (x) { return h('div', { style: 'margin-bottom:10px' }, h('div', null, h('span', { class: 'tag' }, x.format), ' ', h('b', null, x.types.join(', ') || 'untyped')), x.error ? h('div', { class: 'note', style: 'color:var(--err)' }, x.error) : null, h('pre', { class: 'code' }, prettyJson(x.json))); })));
      if (det.headings) sect('Headings', det.headings.length, false, h('div', null, det.headings.map(function (x) { return h('div', { style: 'padding-left:' + (x[0] - 1) * 14 + 'px;font-size:13px' }, h('span', { class: 'tag', style: 'margin-right:6px' }, 'H' + x[0]), x[1]); })));
      if (det.hreflang) sect('Hreflang', det.hreflang.length, false, kvs(det.hreflang));
      drawer.classList.add('on'); scrim.classList.add('on'); drawer.setAttribute('aria-hidden', 'false'); drawer.querySelector('.drawer-b').scrollTop = 0;
    }
    function safeParse(s2) { try { return JSON.parse(s2); } catch (e) { return {}; } }
    function prettyJson(s2) { try { return JSON.stringify(JSON.parse(s2), null, 1); } catch (e) { return s2; } }
    function issueRow(k) {
      var c = checkOf[D.issues.c[k]];
      return h('div', { class: 'list-row' }, CS.sevBadge(c.sev), h('div', { class: 'grow' }, h('b', null, c.title), h('div', { class: 'note' }, D.issues.m[k]), h('div', { class: 'note' }, 'Fix: ' + c.fix)));
    }

    // ---------- register ----------
    addSection('overview', 'Overview', 'overview', null, renderOverview);
    addSection('issues', 'Issues', 'issues', { text: n(D.summary.issuesTotal), err: errCount > 0 }, renderIssues);
    addSection('pages', 'Pages', 'pages', { text: n(N) }, renderPages);
    addSection('links', 'Links', 'links', null, renderLinks);
    addSection('sitemap', 'Sitemap & site', 'sitemap', null, renderSitemap);
    addSection('structured', 'Structured data', 'structured', null, renderSD);
    addSection('ai', 'AI readiness', 'ai', D.ai ? { text: String(D.ai.score) } : null, renderAI);
    if (D.diff && g.DiffViewer) addSection('diff', 'Changes', 'diff', null, function (el) { g.DiffViewer.render(el, D.diff, { open: openPage }); });
    if (opts.getRoute) current = opts.getRoute();
    var initial = (opts.getRoute ? opts.getRoute() : (location.hash.match(/^#\/(\w+)/) || [])[1]) || 'overview';
    show(initial, null, true);
    if (!opts.getRoute) window.addEventListener('hashchange', function () { var m = location.hash.match(/^#\/(\w+)/); if (m && m[1] !== current) show(m[1], null, true); });
    return { show: show, openPage: openPage, destroy: function () { drawer.remove(); scrim.remove(); CS.clear(root); } };
  }
  g.CrawlViewer = { mount: mount };
})(window);
