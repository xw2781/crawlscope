/* crawlscope local UI (vanilla JS single-page app) */
(function () {
  'use strict';
  var CS = window.CS, h = CS.h, n = CS.n;
  CS.themeInit();
  var token = (document.querySelector('meta[name=cs-token]') || {}).content || '';
  var app = document.getElementById('app');
  var job = null, es = null, recentFeed = [], rateHist = [], viewer = null, internalHash = false;
  var liveHooks = [];

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'x-crawlscope-token': token };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')'); return j; });
    });
  }
  function toast(msg, err) { var t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3500); }

  // ---------- shell ----------
  var nav = h('nav', { class: 'nav' });
  var side = h('aside', { class: 'cs-side' }, h('div', { class: 'brand' }, CS.logo(30), h('div', null, 'crawlscope', h('small', null, 'local workspace'))), nav,
    h('div', { class: 'side-foot' }, h('div', { id: 'foot-info' }, ''), CS.themeToggle()));
  var main = h('main', { class: 'cs-main ui-main' });
  app.appendChild(h('div', { class: 'cs' }, side, main));
  CS.installTips(app);
  var navDefs = [['#/', 'Crawls', 'list'], ['#/new', 'New crawl', 'plus'], ['#/live', 'Live', 'play'], ['#/compare', 'Compare', 'diff']];
  var navLinks = {};
  navDefs.forEach(function (d) { var a = h('a', { href: d[0] }, CS.icon(d[2]), d[1]); if (d[0] === '#/live') a.appendChild(h('span', { class: 'badge', id: 'live-badge', style: 'display:none' }, '●')); nav.appendChild(a); navLinks[d[0]] = a; });
  api('/api/info').then(function (i) { document.getElementById('foot-info').textContent = 'v' + i.version; }).catch(function () {});

  function setActive(key) { Object.keys(navLinks).forEach(function (k) { navLinks[k].classList.toggle('on', k === key); }); }

  // ---------- SSE ----------
  function connectEvents() {
    es = new EventSource('/api/events');
    es.addEventListener('state', function (e) {
      var prev = job; job = JSON.parse(e.data);
      if (job) { rateHist.push(job.rate || 0); if (rateHist.length > 90) rateHist.shift(); }
      var b = document.getElementById('live-badge');
      if (b) b.style.display = job && (job.status === 'running' || job.status === 'stopping') ? '' : 'none';
      if (prev && job && (prev.status === 'running' || prev.status === 'stopping') && !(job.status === 'running' || job.status === 'stopping')) toast(job.status === 'error' ? 'Crawl failed: ' + job.error : 'Crawl finished', job.status === 'error');
      liveHooks.forEach(function (f) { f(); });
    });
    es.addEventListener('recent', function (e) { recentFeed = JSON.parse(e.data); liveHooks.forEach(function (f) { f(); }); });
  }
  connectEvents();

  // ---------- views ----------
  function pageHead(title, sub, right) { return h('div', { class: 'page-h' }, h('div', { style: 'flex:1;min-width:240px' }, h('h1', null, title), sub ? h('p', null, sub) : null), right); }
  function reset() {
    liveHooks = [];
    if (viewer) { try { viewer.destroy(); } catch (e) { /* ignore */ } viewer = null; }
    CS.clear(main);
  }

  function viewCrawls() {
    reset(); setActive('#/');
    main.appendChild(pageHead('Crawls', 'Saved crawls in your workspace. Select two to compare.', h('a', { class: 'btn pri', href: '#/new' }, CS.icon('plus', 16), 'New crawl')));
    var box = h('div'); main.appendChild(box);
    var picked = [];
    var cmpBtn = h('button', { class: 'btn', disabled: true, onclick: function () { location.hash = '#/compare?a=' + encodeURIComponent(picked[0]) + '&b=' + encodeURIComponent(picked[1]); } }, CS.icon('diff', 16), 'Compare selected');
    function paint(list) {
      CS.clear(box);
      if (job && (job.status === 'running' || job.status === 'stopping')) box.appendChild(h('div', { class: 'banner' }, h('span', { class: 'pulse' }), h('b', null, 'Crawling ' + job.url), h('span', { class: 'muted' }, n(job.crawled) + ' pages so far'), h('span', { style: 'flex:1' }), h('a', { class: 'btn sm', href: '#/live' }, 'Watch live')));
      if (!list.length) { box.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('p', null, 'No crawls yet in this workspace.'), h('a', { class: 'btn pri', href: '#/new' }, 'Start your first crawl')))); return; }
      var rows = list.map(function (c) {
        var cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + c.name, onchange: function () { if (cb.checked) picked.push(c.name); else picked = picked.filter(function (x) { return x !== c.name; }); if (picked.length > 2) { picked.shift(); } cmpBtn.disabled = picked.length !== 2; cmpBtn.textContent = ''; cmpBtn.appendChild(CS.icon('diff', 16)); cmpBtn.appendChild(document.createTextNode(picked.length === 2 ? 'Compare selected' : 'Select 2 to compare (' + picked.length + ')')); rows.forEach(function (r) { r.cb.checked = picked.indexOf(r.name) >= 0; }); } });
        var row = h('div', { class: 'crawl-row' }, cb, CS.ring(c.healthScore, { size: 52, stroke: 6, label: 'Health' }),
          h('div', { style: 'min-width:0' }, h('a', { href: '#/crawl/' + encodeURIComponent(c.name) + '/overview', style: 'font-weight:680;font-size:15px;word-break:break-all' }, c.seed), h('div', { class: 'note' }, CS.date(c.startedAt) + ' · ' + CS.dur(c.durationMs) + ' · ' + n(c.pages) + ' pages' + (c.status === 'partial' ? ' · partial' : ''))),
          h('div', { class: 'hide-s' }, h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, c.bySeverity.error ? h('span', { class: 'sev error' }, c.bySeverity.error) : null, c.bySeverity.warning ? h('span', { class: 'sev warning' }, c.bySeverity.warning) : null, c.bySeverity.notice ? h('span', { class: 'sev notice' }, c.bySeverity.notice) : null, !c.issues ? h('span', { class: 'sev ok' }, 'clean') : null)),
          h('div', { class: 'hide-s note' }, c.aiReadinessScore !== null ? 'AI readiness ' + c.aiReadinessScore : ''),
          h('div', { style: 'display:flex;gap:6px' }, h('a', { class: 'btn sm', href: '#/crawl/' + encodeURIComponent(c.name) + '/overview' }, 'Open'), h('a', { class: 'btn sm', href: '/api/crawls/' + encodeURIComponent(c.name) + '/export/report.html?inline=1', target: '_blank', rel: 'noopener', title: 'Open standalone report.html' }, CS.icon('ext', 14))));
        rows.push({ name: c.name, cb: cb }); rows[rows.length - 1].el = row;
        return row;
      });
      rows = rows.filter(function () { return true; });
      var real = list.map(function (c, i) { return rows[i]; });
      box.appendChild(h('div', { class: 'no-print', style: 'margin-bottom:10px' }, cmpBtn));
      cmpBtn.textContent = ''; cmpBtn.appendChild(CS.icon('diff', 16)); cmpBtn.appendChild(document.createTextNode('Select 2 to compare (0)'));
      box.appendChild(h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, real));
    }
    api('/api/crawls').then(function (r) { job = r.job || job; paint(r.crawls); }).catch(function (e) { box.appendChild(h('div', { class: 'callout warn' }, e.message)); });
    liveHooks.push(function () { /* banner refresh on next visit */ });
  }

  function field(label, input, hint, cls) { return h('label', { class: 'field ' + (cls || '') }, h('span', null, label), input, hint ? h('small', null, hint) : null); }
  function viewNew() {
    reset(); setActive('#/new');
    main.appendChild(pageHead('New crawl', 'Crawls are polite by default: robots.txt is honoured and requests are rate-limited per host.'));
    var running = job && (job.status === 'running' || job.status === 'stopping');
    if (running) main.appendChild(h('div', { class: 'banner' }, h('span', { class: 'pulse' }), 'A crawl is already running.', h('span', { style: 'flex:1' }), h('a', { class: 'btn sm', href: '#/live' }, 'Watch live')));
    var f = {};
    function inp(name, attrs) { f[name] = h('input', Object.assign({ class: 'input', name: name }, attrs)); return f[name]; }
    function ta(name, ph) { f[name] = h('textarea', { class: 'input', name: name, rows: 3, placeholder: ph, style: 'font-family:var(--mono);font-size:12px;resize:vertical' }); return f[name]; }
    function chk(name, label, hint, checked) { f[name] = h('input', { type: 'checkbox', name: name, checked: checked ? true : null }); return h('label', { class: 'check' }, f[name], h('span', null, label, hint ? h('small', null, hint) : null)); }
    var ignoreRow = h('div', { style: 'display:none;margin-top:8px' });
    f.respectRobots = h('input', { type: 'checkbox', checked: true, onchange: function () { ignoreRow.style.display = f.respectRobots.checked ? 'none' : 'block'; } });
    f.iOwn = h('input', { type: 'checkbox' });
    ignoreRow.appendChild(h('label', { class: 'check' }, f.iOwn, h('span', null, 'I own this site or have permission to crawl it ignoring robots.txt')));
    var err = h('div', { class: 'callout warn', style: 'display:none' });
    var submit = h('button', { class: 'btn pri', type: 'submit', disabled: running ? true : null }, CS.icon('play', 15), 'Start crawl');
    var form = h('form', { class: 'card', onsubmit: function (e) {
      e.preventDefault(); err.style.display = 'none'; submit.disabled = true;
      var body = {
        url: f.url.value, maxPages: f.maxPages.value, maxDepth: f.maxDepth.value, concurrency: f.concurrency.value, delayMs: f.delayMs.value, timeoutMs: f.timeoutMs.value,
        include: f.include.value, exclude: f.exclude.value, sitemapUrls: f.sitemapUrls.value, userAgent: f.userAgent.value,
        respectRobots: f.respectRobots.checked, iOwnThisSite: f.iOwn.checked, respectNofollow: f.respectNofollow.checked, subdomains: f.subdomains.checked,
        externalCheck: f.externalCheck.checked, aiBotsCheck: f.aiBotsCheck.checked, slowMs: f.slowMs.value, verySlowMs: f.verySlowMs.value
      };
      api('/api/crawls', { method: 'POST', body: body }).then(function (r) { job = r.job; recentFeed = []; rateHist = []; location.hash = '#/live'; }).catch(function (x) { err.textContent = x.message; err.style.display = 'block'; submit.disabled = false; });
    } },
      h('div', { class: 'form-grid' },
        field('Start URL', inp('url', { type: 'text', placeholder: 'https://example.com', required: true, autofocus: true, autocomplete: 'off' }), 'Only this site (and subdomains, if enabled) is crawled.', 'full'),
        field('Max pages', inp('maxPages', { type: 'number', min: 1, value: '500', placeholder: 'unlimited' }), 'Empty = unlimited'), field('Max depth', inp('maxDepth', { type: 'number', min: 0, placeholder: 'unlimited' })),
        field('Concurrency', inp('concurrency', { type: 'number', min: 1, max: 32, value: '4' })), field('Delay per host (ms)', inp('delayMs', { type: 'number', min: 0, value: '250' })),
        field('Request timeout (ms)', inp('timeoutMs', { type: 'number', min: 500, value: '15000' })), field('Slow page ≥ (ms)', inp('slowMs', { type: 'number', min: 1, placeholder: '1000' })), field('Very slow ≥ (ms)', inp('verySlowMs', { type: 'number', min: 1, placeholder: '3000' })),
        field('User-Agent', inp('userAgent', { type: 'text', placeholder: 'default: crawlscope/<version>' }), null, 'full'),
        field('Include (regex, one per line)', ta('include', 'e.g. /blog/'), null, 'wide'), field('Exclude (regex, one per line)', ta('exclude', 'e.g. \\?utm_'), null, 'wide'),
        field('Extra sitemap URLs', ta('sitemapUrls', 'https://example.com/sitemap.xml'), null, 'full'),
        h('div', { class: 'full', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px' },
          chk('respectNofollow', 'Respect rel=nofollow', 'Do not follow nofollow links or nofollow pages'), chk('subdomains', 'Include subdomains'), chk('externalCheck', 'Check external links', 'HEAD-checks outbound links; never crawls them'), chk('aiBotsCheck', 'Resolve llms.txt links', 'Verifies URLs listed in llms.txt')),
        h('div', { class: 'full' }, h('label', { class: 'check' }, f.respectRobots, h('span', null, 'Respect robots.txt', h('small', null, 'Recommended. Turn off only for sites you own.'))), ignoreRow)),
      h('hr', { class: 'sep' }), err, h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:12px' }, submit, h('a', { class: 'btn', href: '#/' }, 'Cancel')));
    main.appendChild(form);
  }

  function spark(vals) {
    var W = 300, H = 56, max = Math.max(1, Math.max.apply(null, vals));
    var pts = vals.map(function (v, i) { return (vals.length < 2 ? 0 : i / (vals.length - 1)) * W + ',' + (H - 4 - (v / max) * (H - 10)); });
    return CS.s('svg', { viewBox: '0 0 ' + W + ' ' + H, style: 'width:100%;height:56px', class: 'chart', role: 'img', 'aria-label': 'Pages per second over time' },
      CS.s('line', { x1: 0, x2: W, y1: H - 2, y2: H - 2, stroke: 'var(--line-2)' }),
      vals.length > 1 ? CS.s('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }) : null);
  }
  function viewLive() {
    reset(); setActive('#/live');
    var body = h('div'); main.appendChild(pageHead('Live crawl', 'Progress streams from the crawler over Server-Sent Events.')); main.appendChild(body);
    function paint() {
      CS.clear(body);
      if (!job) { body.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('p', null, 'No crawl has been started in this session.'), h('a', { class: 'btn pri', href: '#/new' }, 'Start a crawl')))); return; }
      var running = job.status === 'running' || job.status === 'stopping';
      var pct = job.maxPages ? Math.min(100, Math.round((job.crawled / job.maxPages) * 100)) : null;
      var stateTag = running ? h('span', { class: 'sev notice' }, job.status === 'stopping' ? 'Stopping…' : CS.cap(job.phase)) : job.status === 'done' ? h('span', { class: 'sev ok' }, 'Finished') : job.status === 'stopped' ? h('span', { class: 'sev warning' }, 'Stopped (partial)') : h('span', { class: 'sev error' }, 'Failed');
      var actions = running ? h('button', { class: 'btn danger', onclick: function () { api('/api/job/stop', { method: 'POST', body: {} }).catch(function (e) { toast(e.message, true); }); }, disabled: job.status === 'stopping' ? true : null }, CS.icon('stop', 14), 'Stop crawl')
        : job.result ? h('a', { class: 'btn pri', href: '#/crawl/' + encodeURIComponent(job.result) + '/overview' }, 'Open results') : h('a', { class: 'btn', href: '#/new' }, 'New crawl');
      body.appendChild(h('div', { class: 'card', style: 'margin-bottom:16px' }, h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px' }, running ? h('span', { class: 'pulse' }) : null, h('b', { style: 'font-size:16px;word-break:break-all' }, job.url), stateTag, h('span', { style: 'flex:1' }), actions),
        h('div', { class: 'progress' + (pct === null && running ? ' ind' : ''), role: 'progressbar', 'aria-valuenow': pct === null ? null : pct }, h('i', { style: pct === null ? '' : 'width:' + pct + '%' })),
        pct !== null ? h('div', { class: 'note', style: 'margin-top:6px' }, pct + '% of the ' + n(job.maxPages) + '-page limit') : null,
        job.error ? h('div', { class: 'callout warn', style: 'margin-top:12px' }, job.error) : null));
      body.appendChild(h('div', { class: 'live-stats' },
        [['Pages crawled', n(job.crawled)], ['In queue', n(job.queued)], ['Rate', (job.rate || 0).toFixed(1) + '/s'], ['Errors', n(job.errors)], ['Elapsed', CS.dur(job.elapsedMs || 0)]].map(function (k) { return h('div', { class: 'card kpi' }, h('b', { class: 'num', style: k[0] === 'Errors' && job.errors ? 'color:var(--err)' : '' }, k[1]), h('span', null, k[0])); })));
      body.appendChild(h('div', { class: 'grid g-21' }, h('div', { class: 'card' }, h('h3', { class: 'card-h' }, 'Latest requests', h('span', { class: 'r' }, job.active + ' in flight')),
        h('div', { class: 'feed' }, recentFeed.slice().reverse().map(function (p) { return h('div', null, CS.statusPill(p.status, 0), h('span', { class: 'u' }, p.url), h('span', { class: 'muted' }, p.ms === null ? '' : CS.ms(p.ms))); }))), h('div', { class: 'card' }, h('h3', { class: 'card-h' }, 'Pages per second'), spark(rateHist), h('p', { class: 'note' }, 'Last request: ' + (job.lastUrl || '–')))));
    }
    liveHooks.push(paint);
    api('/api/job').then(function (r) { job = r.job; paint(); }).catch(function () { paint(); });
  }

  function viewCrawl(name, section) {
    reset(); setActive('#/');
    var loading = h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Loading crawl…'));
    main.appendChild(h('div', { class: 'page-h' }, h('a', { class: 'btn sm', href: '#/' }, '← Crawls')));
    main.appendChild(loading);
    var enc = encodeURIComponent(name);
    var exportsMenu = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [['report.html', 'HTML'], ['pages.csv', 'Pages CSV'], ['issues.csv', 'Issues CSV'], ['links.csv', 'Links CSV'], ['crawl.json', 'JSON']].map(function (x) {
      return h('a', { class: 'btn sm', href: '/api/crawls/' + enc + '/export/' + x[0], download: name + '-' + x[0], title: 'Download ' + x[0] }, CS.icon('download', 13), x[1]);
    }));
    fetch('/api/crawls/' + enc).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); }).then(function (D) {
      loading.remove();
      var holder = h('div'); main.appendChild(holder);
      viewer = CrawlViewer.mount(holder, D, {
        layout: 'tabs', noTheme: true, toolbar: exportsMenu,
        getRoute: function () { return section || 'overview'; },
        setRoute: function (sec) { section = sec; internalHash = true; location.hash = '#/crawl/' + enc + '/' + sec; }
      });
    }).catch(function (e) { CS.clear(loading).appendChild(h('div', { class: 'empty' }, 'Could not load crawl: ' + e.message)); });
  }

  function viewCompare(params) {
    reset(); setActive('#/compare');
    main.appendChild(pageHead('Compare crawls', 'Pick a baseline (A) and a newer crawl (B).'));
    var out = h('div');
    var selA = h('select', { class: 'input', 'aria-label': 'Crawl A' }), selB = h('select', { class: 'input', 'aria-label': 'Crawl B' });
    var go = h('button', { class: 'btn pri', onclick: run }, CS.icon('diff', 16), 'Compare');
    var open = h('a', { class: 'btn', target: '_blank', rel: 'noopener', style: 'display:none' }, CS.icon('ext', 14), 'Standalone HTML');
    main.appendChild(h('div', { class: 'card', style: 'margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center' }, h('b', null, 'A'), selA, h('b', null, 'B'), selB, go, open));
    main.appendChild(out);
    function run() {
      CS.clear(out).appendChild(h('div', { class: 'empty' }, 'Comparing…'));
      var q = 'a=' + encodeURIComponent(selA.value) + '&b=' + encodeURIComponent(selB.value);
      open.href = '/api/diff/html?' + q; open.style.display = '';
      api('/api/diff?' + q).then(function (d) { CS.clear(out); DiffViewer.render(out, d, {}); }).catch(function (e) { CS.clear(out).appendChild(h('div', { class: 'callout warn' }, e.message)); });
    }
    api('/api/crawls').then(function (r) {
      var list = r.crawls;
      if (list.length < 2) { out.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'You need at least two crawls to compare.'))); go.disabled = true; return; }
      [selA, selB].forEach(function (s) { list.forEach(function (c) { s.appendChild(h('option', { value: c.name }, c.seed + ' · ' + CS.date(c.startedAt))); }); });
      selA.value = params.a || list[1].name; selB.value = params.b || list[0].name;
      if (params.a && params.b) run();
    });
  }

  // ---------- router ----------
  function route() {
    if (internalHash) { internalHash = false; return; }
    var hash = location.hash || '#/';
    var qi = hash.indexOf('?'), pathPart = qi < 0 ? hash : hash.slice(0, qi), params = {};
    if (qi >= 0) hash.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    var m;
    if (pathPart === '#/new') viewNew();
    else if (pathPart === '#/live') viewLive();
    else if (pathPart === '#/compare') viewCompare(params);
    else if ((m = /^#\/crawl\/([^/]+)(?:\/(\w+))?$/.exec(pathPart))) viewCrawl(decodeURIComponent(m[1]), m[2] || 'overview');
    else viewCrawls();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  api('/api/job').then(function (r) { job = r.job; var b = document.getElementById('live-badge'); if (b && job && job.status === 'running') b.style.display = ''; }).catch(function () {}).then(route);
})();
