/* crawlscope web: shared DOM helpers, icons, charts. No dependencies. Everything is built with
   createElement/textContent so crawled (untrusted) strings can never become markup. */
(function (g) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function apply(el, attrs) {
    if (!attrs) return el;
    for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    return el;
  }
  function add(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) add(el, c);
      else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function h(tag, attrs) { return add(apply(document.createElement(tag), attrs), Array.prototype.slice.call(arguments, 2)); }
  function s(tag, attrs) { return add(apply(document.createElementNS(NS, tag), attrs), Array.prototype.slice.call(arguments, 2)); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  var ICONS = {
    overview: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10',
    issues: 'M12 3l10 18H2L12 3zM12 10v5M12 18v.5',
    pages: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
    links: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
    sitemap: 'M12 3v5M5 21v-5h14v5M12 8v8M5 16v-3h14v3M9 3h6v5H9z',
    structured: 'M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16',
    ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    diff: 'M7 4v12M7 16l-3-3M7 16l3-3M17 20V8M17 8l-3 3M17 8l3 3',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.5-4.5',
    sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
    x: 'M6 6l12 12M18 6L6 18',
    download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
    play: 'M7 4l13 8-13 8z',
    stop: 'M6 6h12v12H6z',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    plus: 'M12 5v14M5 12h14',
    copy: 'M9 9h11v11H9zM5 15V4h11',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6'
  };
  function icon(name, size) {
    var sv = s('svg', { viewBox: '0 0 24 24', width: size || 18, height: size || 18, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' });
    sv.appendChild(s('path', { d: ICONS[name] || '' }));
    return sv;
  }
  function logo(size) {
    var z = size || 30;
    return s('svg', { viewBox: '0 0 32 32', width: z, height: z, 'aria-hidden': 'true' },
      s('defs', null, s('linearGradient', { id: 'cs-lg', x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: '0', 'stop-color': 'var(--accent)' }), s('stop', { offset: '1', 'stop-color': 'var(--accent-2)' }))),
      s('rect', { x: 1, y: 1, width: 30, height: 30, rx: 9, fill: 'url(#cs-lg)' }),
      s('circle', { cx: 16, cy: 16, r: 8.5, fill: 'none', stroke: '#fff', 'stroke-opacity': '.55', 'stroke-width': 1.6 }),
      s('circle', { cx: 16, cy: 16, r: 4, fill: 'none', stroke: '#fff', 'stroke-width': 1.8 }),
      s('path', { d: 'M16 3v6M16 23v6M3 16h6M23 16h6', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
      s('circle', { cx: 16, cy: 16, r: 1.6, fill: '#fff' }));
  }

  // ---------- formatting ----------
  var nf = new Intl.NumberFormat('en-US');
  function n(v) { return v === null || v === undefined ? '–' : nf.format(v); }
  function bytes(b) {
    if (b === null || b === undefined || b < 0) return '–';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function ms(v) { return v === null || v === undefined || v < 0 ? '–' : v >= 10000 ? (v / 1000).toFixed(1) + ' s' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms'; }
  function dur(v) { var sec = Math.round(v / 1000); if (sec < 60) return sec + 's'; var m = Math.floor(sec / 60); return m + 'm ' + (sec % 60) + 's'; }
  function date(iso) { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } }
  function cap(sv) { return sv.charAt(0).toUpperCase() + sv.slice(1); }
  function urlEl(u, cls) {
    var m = /^(https?:\/\/[^/]+)(.*)$/.exec(u);
    return h('span', { class: 'url ' + (cls || '') }, m ? [h('span', { class: 'host' }, m[1]), m[2] || '/'] : u);
  }
  function safeHref(u) { return /^https?:\/\//i.test(u) ? u : null; }
  function scoreTone(sc) { return sc >= 85 ? 'var(--ok)' : sc >= 60 ? 'var(--warn-fill)' : 'var(--err)'; }
  function scoreLabel(sc) { return sc >= 85 ? 'Healthy' : sc >= 60 ? 'Needs attention' : 'At risk'; }
  function sevBadge(sev) { return h('span', { class: 'sev ' + sev }, cap(sev)); }
  function statusPill(code, flags) {
    var blocked = flags & 16;
    if (blocked) return h('span', { class: 'pill-s st0', 'data-tip': 'Blocked by robots.txt' }, 'robots');
    if (!code) return h('span', { class: 'pill-s st0', 'data-tip': 'Request failed' }, 'error');
    return h('span', { class: 'pill-s st' + Math.floor(code / 100) }, code);
  }

  // ---------- tooltip (event delegation on [data-tip]) ----------
  var tipEl = null;
  function ensureTip() { if (!tipEl) { tipEl = h('div', { class: 'tip', role: 'tooltip' }); document.body.appendChild(tipEl); } return tipEl; }
  function installTips(root) {
    root.addEventListener('mouseover', function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || !root.contains(t)) return;
      var tip = ensureTip(); tip.textContent = t.getAttribute('data-tip'); tip.classList.add('on'); place(e);
    });
    root.addEventListener('mousemove', function (e) { if (tipEl && tipEl.classList.contains('on')) place(e); });
    root.addEventListener('mouseout', function (e) {
      var t = e.target.closest && e.target.closest('[data-tip]');
      if (t && tipEl) tipEl.classList.remove('on');
    });
  }
  function place(e) {
    var w = tipEl.offsetWidth, x = e.clientX + 14, y = e.clientY + 16;
    if (x + w > innerWidth - 8) x = e.clientX - w - 10;
    tipEl.style.left = Math.max(6, x) + 'px'; tipEl.style.top = y + 'px';
  }

  // ---------- charts ----------
  function ring(score, o) {
    o = o || {};
    var size = o.size || 132, sw = o.stroke || 12, r = (size - sw) / 2, c = 2 * Math.PI * r, cx = size / 2;
    var pct = Math.max(0, Math.min(100, score)) / 100;
    var color = o.color || scoreTone(score);
    var el = s('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size, role: 'img', 'aria-label': (o.label || 'Score') + ' ' + score + ' out of 100', class: 'chart' });
    el.appendChild(s('circle', { cx: cx, cy: cx, r: r, fill: 'none', stroke: 'var(--bg-2)', 'stroke-width': sw }));
    el.appendChild(s('circle', { cx: cx, cy: cx, r: r, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-dasharray': (c * pct) + ' ' + c, transform: 'rotate(-90 ' + cx + ' ' + cx + ')' }));
    el.appendChild(s('text', { x: cx, y: cx + (o.sub ? 2 : 9), 'text-anchor': 'middle', style: 'font-size:' + Math.round(size * 0.29) + 'px;font-weight:720;fill:var(--ink);letter-spacing:-0.03em' }, String(score)));
    if (o.sub) el.appendChild(s('text', { x: cx, y: cx + size * 0.2, 'text-anchor': 'middle', style: 'font-size:11px;fill:var(--muted)' }, o.sub));
    return el;
  }
  function topRounded(x, y, w, hh, r) {
    r = Math.min(r, w / 2, hh);
    return 'M' + x + ',' + (y + hh) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + hh) + 'Z';
  }
  /** vertical bar chart. bars: [{label, value, color, tip}] */
  function colChart(bars, o) {
    o = o || {};
    var W = o.w || 440, H = o.h || 190, padL = 6, padR = 6, padT = 18, padB = 26;
    var max = Math.max(1, Math.max.apply(null, bars.map(function (b) { return b.value; })));
    var gap = bars.length > 14 ? 3 : 8, bw = Math.max(4, (W - padL - padR - gap * (bars.length - 1)) / bars.length);
    var plotH = H - padT - padB;
    var sv = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.label || 'Bar chart', style: 'width:100%;height:auto;display:block' });
    [0.5, 1].forEach(function (f) { sv.appendChild(s('line', { x1: padL, x2: W - padR, y1: padT + plotH * (1 - f), y2: padT + plotH * (1 - f), stroke: 'var(--line)', 'stroke-dasharray': f < 1 ? '2 4' : null })); });
    sv.appendChild(s('line', { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, stroke: 'var(--line-2)' }));
    bars.forEach(function (b, i) {
      var x = padL + i * (bw + gap), bh = b.value ? Math.max(3, (b.value / max) * plotH) : 0, y = padT + plotH - bh;
      var gEl = s('g', { 'data-tip': b.tip || (b.label + ': ' + nf.format(b.value)) });
      gEl.appendChild(s('rect', { x: x - gap / 2, y: padT, width: bw + gap, height: plotH + padB, fill: 'transparent' }));
      if (bh) gEl.appendChild(s('path', { class: 'bar', d: topRounded(x, y, bw, bh, 4), fill: b.color || 'var(--accent)' }));
      if (b.value && (bars.length <= 9 || b.value === max)) gEl.appendChild(s('text', { x: x + bw / 2, y: y - 5, 'text-anchor': 'middle', style: 'fill:var(--ink-2);font-weight:600' }, nf.format(b.value)));
      if (bars.length <= 14 || i % 2 === 0) gEl.appendChild(s('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, b.label));
      sv.appendChild(gEl);
    });
    return sv;
  }
  function hbars(rows) {
    var max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.value; })));
    return h('div', null, rows.map(function (r) {
      var row = h('div', { class: 'hbar', 'data-tip': r.tip || null },
        r.href || r.onclick ? h('button', { class: 'link-btn', onclick: r.onclick }, r.label) : h('span', null, r.label),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + (r.value / max) * 100 + '%;background:' + (r.color || 'var(--accent)') })),
        h('span', { class: 'v' }, nf.format(r.value)));
      return row;
    }));
  }
  function stack(parts) {
    var total = parts.reduce(function (a, p) { return a + p.value; }, 0) || 1;
    return h('div', { class: 'stack', role: 'img' }, parts.filter(function (p) { return p.value > 0; }).map(function (p) {
      return h('i', { style: 'width:' + (p.value / total) * 100 + '%;background:' + p.color, 'data-tip': p.label + ': ' + nf.format(p.value) });
    }));
  }

  // ---------- theme ----------
  function themeInit() {
    var saved = null;
    try { saved = localStorage.getItem('crawlscope-theme'); } catch (e) { /* file:// may block */ }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  }
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function themeToggle() {
    var btn = h('button', { class: 'icon-btn', title: 'Toggle light/dark theme', 'aria-label': 'Toggle theme' });
    function paint() { clear(btn).appendChild(icon(isDark() ? 'sun' : 'moon')); }
    btn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('crawlscope-theme', next); } catch (e) { /* ignore */ }
      paint();
    });
    paint();
    return btn;
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    var a = h('a', { href: url, download: name }); document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  g.CS = { h: h, s: s, clear: clear, icon: icon, logo: logo, n: n, bytes: bytes, ms: ms, dur: dur, date: date, cap: cap, urlEl: urlEl, safeHref: safeHref, scoreTone: scoreTone, scoreLabel: scoreLabel, sevBadge: sevBadge, statusPill: statusPill, installTips: installTips, ring: ring, colChart: colChart, hbars: hbars, stack: stack, themeInit: themeInit, themeToggle: themeToggle, download: download };
})(typeof window !== 'undefined' ? window : globalThis);
