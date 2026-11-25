/* Markt-Radar: täglicher Marktüberblick mit automatischer Analyse.
   Daten: data/market.json (Analyse) und data/market_series.json (Kursverläufe), beide von tools/market.py per GitHub Action.
   Favoriten, Kurs-Wecker und Vergleich bleiben nur auf diesem Gerät (localStorage). */
(function () {
  'use strict';
  const RAW = 'https://raw.githubusercontent.com/johannes0100-ops/mein-portfolio/main/';
  const URLS = { market: [RAW + 'data/market.json', 'data/market.json'], series: [RAW + 'data/market_series.json', 'data/market_series.json'], feed: ['data/feed.json'] };
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const PRICES = { 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-opus-5-5': [4, 20] };

  // ---------- Hilfen ----------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; };
  const nf = (d0, d1) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d0, maximumFractionDigits: d1 == null ? d0 : d1 });
  const NF = { 0: nf(0), 1: nf(1), 2: nf(2), 3: nf(3), 4: nf(4) };
  const fmtN = (v, d) => (v == null || !isFinite(v) ? 'k. A.' : NF[d].format(v));
  const fmtP = (v, d = 2) => (v == null || !isFinite(v) ? 'k. A.' : (v > 0 ? '+' : v < 0 ? '−' : '') + NF[d].format(Math.abs(v)) + ' %');
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const TZ = { timeZone: 'Europe/Berlin' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERIOD = { d1: 'heute', w1: '1 Woche', m1: '1 Monat', m3: '3 Monate', m6: '6 Monate', ytd: 'seit 1.1.', y1: '1 Jahr', y2: '2 Jahre' };

  function decimals(it, v) {
    if (it.kind === 'fx') return 4;
    if (it.kind === 'yield' || it.kind === 'vol') return 2;
    const a = Math.abs(v);
    if (a >= 10000 && it.kind === 'crypto') return 0;
    if (a >= 1) return 2;
    if (a >= 0.1) return 3;
    return 4;
  }
  function unit(it) {
    if (it.kind === 'yield') return '%';
    if (it.kind === 'index' || it.kind === 'vol') return 'Pkt.';
    if (it.kind === 'fx') return it.sym === 'DX-Y.NYB' ? 'Pkt.' : '';
    const c = it.ccy || '';
    return { EUR: '€', USD: '$', GBp: 'Pence', GBP: '£', CHF: 'CHF', DKK: 'DKK', JPY: '¥', HKD: 'HK$' }[c] || c;
  }
  const fmtPx = (it, v) => (v == null ? 'k. A.' : fmtN(v, decimals(it, v)));
  const fmtPxU = (it, v) => { const u = unit(it); return fmtPx(it, v) + (u ? ' ' + u : ''); };
  // Zinsen und VIX: Tagesveränderung in Punkten statt Prozent
  const chgText = (it) => { const a = it.a; if (!a) return 'k. A.'; if (it.kind === 'yield' && a.d1_abs != null) return (a.d1_abs >= 0 ? '+' : '−') + fmtN(Math.abs(a.d1_abs), 2) + ' Pkt.'; return fmtP(a.d1); };

  // ---------- Zustand ----------
  let M = null, S = null, FEED = null, byId = {}, seriesCache = {};
  const ui = Object.assign({ tab: 'heute', heat: 'd1', sort: 'group', col: 'm1', group: 'all', q: '', cmpR: 252 }, store.get('mr.ui', {}));
  let favs = new Set(store.get('mr.favs', []));
  let alerts = store.get('mr.alerts', []);
  let cmp = store.get('mr.cmp', ['^GDAXI', '^GSPC', 'GC=F', 'BTC-EUR']);
  const saveUi = () => store.set('mr.ui', { heat: ui.heat, sort: ui.sort, col: ui.col, group: ui.group, cmpR: ui.cmpR, tab: ui.tab });

  // ---------- Laden ----------
  async function getJson(list, fresh) {
    let last;
    for (const u of list) {
      try {
        const r = await fetch(u + (fresh ? (u.includes('?') ? '&' : '?') + 't=' + Date.now() : ''), { cache: fresh ? 'no-store' : 'default' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last || new Error('nicht erreichbar');
  }
  async function load(fresh) {
    setStatus('run');
    try {
      const m = await getJson(URLS.market, fresh);
      // Die neuere Datei gewinnt (Rohdatei auf GitHub ist oft frischer als die Seite)
      if (!M || !m.generated_at || m.generated_at >= (M.generated_at || '')) M = m;
      byId = {}; M.items.forEach((it) => { byId[it.sym] = it; });
      if (S && S.generated_at !== M.generated_at) { S = null; seriesCache = {}; }
    } catch (e) {
      setStatus('err', e);
      if (!M) { $('hero').innerHTML = ''; const h = el('div', 'empty'); h.innerHTML = '<b>Noch keine Marktdaten.</b><br>Die Datei <code>data/market.json</code> fehlt. Sie entsteht automatisch, sobald die GitHub Action „Markt-Radar“ einmal gelaufen ist (unter Actions → Markt-Radar → Run workflow).'; $('hero').append(h); }
      return;
    }
    if (!FEED) getJson(URLS.feed).then((f) => { FEED = f; renderCal(); }).catch(() => {});
    renderAll();
    setStatus('ok');
    checkAlerts();
  }
  async function loadSeries() {
    if (S) return S;
    S = await getJson(URLS.series, false);
    seriesCache = {};
    return S;
  }
  function series(sym) {
    if (seriesCache[sym]) return seriesCache[sym];
    const r = S && S.series[sym]; if (!r) return null;
    const t = [r.t0]; let d = new Date(r.t0 + 'T12:00:00Z');
    for (const g of r.g) { d = new Date(d.getTime() + g * 864e5); t.push(d.toISOString().slice(0, 10)); }
    return (seriesCache[sym] = { t, c: r.c });
  }

  // ---------- Status ----------
  function berlinNow() { const p = new Intl.DateTimeFormat('en-GB', { ...TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()); const g = (k) => p.find((x) => x.type === k).value; return { wd: g('weekday'), min: +g('hour') * 60 + +g('minute') }; }
  function markets() {
    const { wd, min } = berlinNow(); const wk = !['Sat', 'Sun'].includes(wd);
    return [
      { n: 'Xetra', on: wk && min >= 540 && min < 1050 },
      { n: 'New York', on: wk && min >= 930 && min < 1320 },
      { n: 'Krypto', on: true },
    ];
  }
  function ago(iso) {
    const t = Date.parse(iso || ''); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'gerade eben'; if (m < 60) return 'vor ' + m + ' Min.';
    const h = Math.round(m / 60); if (h < 24) return 'vor ' + h + ' Std.';
    return new Date(t).toLocaleString('de-DE', { ...TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function setStatus(st, err) {
    const s = $('status'); s.textContent = '';
    if (st === 'run') { const m = el('span', 'mk'); m.append(el('span', 'dot run'), document.createTextNode('Lade …')); s.append(m); if (!M) return; }
    if (st === 'err') { const m = el('span', 'mk down', 'Keine Verbindung' + (M ? ' – zeige letzten Stand' : '')); s.append(m); }
    if (M) {
      const m = el('span', 'mk'); m.append(document.createTextNode('Stand: ' + ago(M.generated_at))); m.title = new Date(M.generated_at).toLocaleString('de-DE', TZ); s.append(m);
    }
    markets().forEach((x) => { const m = el('span', 'mk'); m.append(el('span', 'dot' + (x.on ? ' on' : '')), document.createTextNode(x.n + (x.on ? ' offen' : ' zu'))); s.append(m); });
  }

  // ---------- Kleine Bausteine ----------
  function spark(vals, w, h, col) {
    const s = sv('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (!vals || vals.length < 2) return s;
    const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - ((v - mn) / r) * (h - 4)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    s.append(sv('path', { d: d + `L${w} ${h}L0 ${h}Z`, fill: col, opacity: '.10', stroke: 'none' }));
    s.append(sv('path', { d, fill: 'none', stroke: col, 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
    return s;
  }
  const lineColor = (v) => (v >= 0 ? 'var(--up)' : 'var(--down)');
  function lightEl(it) { const l = el('span', 'light ' + ((it.a && it.a.light) || '')); l.setAttribute('aria-hidden', 'true'); return l; }
  function tile(it) {
    const b = el('button', 'tile'); b.type = 'button'; b.onclick = () => openDetail(it.sym);
    const a = it.a; if (!a) { b.append(el('span', 'nm', it.short), el('span', 'faint', 'keine Daten')); return b; }
    const top = el('div', 'top'); top.append(el('span', 'nm', it.short), el('span', 'ch ' + tone(a.d1), chgText(it)));
    const px = el('div', 'px', fmtPxU(it, a.price));
    const tr = el('div', 'tr'); tr.append(lightEl(it), el('span', '', a.trend + (a.temp !== 'normal' && it.kind !== 'vol' ? ' · ' + a.temp_txt : '')));
    b.append(top, px, tr, spark(it.spark, 200, 30, lineColor((it.spark || [0, 0]).at(-1) - (it.spark || [0, 0])[0])));
    b.setAttribute('aria-label', it.name + ', ' + fmtPxU(it, a.price) + ', heute ' + chgText(it) + ', ' + a.trend);
    return b;
  }
  function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { e.hidden = true; }, 3500); }

  // ---------- Heute ----------
  function renderAll() {
    renderHero(); renderMood(); renderIdx(); renderHeat(); renderMovers(); renderOther(); renderReport(); renderEvents(); renderCal();
    renderChips(); renderList(); renderCmpSelect(); renderAlerts(); renderKiPresets();
    if (ui.tab === 'vergleich') renderCmp();
  }
  function renderHero() {
    const h = $('hero'); h.textContent = '';
    const r = M.report || {};
    h.append(el('div', 'kicker', 'Der Markt in 30 Sekunden · ' + new Date(M.generated_at).toLocaleDateString('de-DE', { ...TZ, weekday: 'long', day: 'numeric', month: 'long' })));
    h.append(el('h2', '', r.headline || 'Marktüberblick'));
    const ul = el('ul'); (r.bullets || []).forEach((b) => ul.append(el('li', '', b))); h.append(ul);
  }
  function moodColor(v) { return v < 25 ? 'var(--down)' : v < 45 ? 'color-mix(in srgb, var(--down) 55%, var(--warn))' : v <= 55 ? 'var(--warn)' : v <= 75 ? 'color-mix(in srgb, var(--up) 60%, var(--warn))' : 'var(--up)'; }
  function renderMood() {
    const box = $('mood'); box.textContent = '';
    const md = M.mood || {}; const v = md.value;
    const g = el('div');
    const s = sv('svg', { class: 'gauge', viewBox: '0 0 200 112', role: 'img', 'aria-label': 'Stimmung ' + (v == null ? 'unbekannt' : Math.round(v) + ' von 100, ' + md.label) });
    const arc = (a0, a1, col) => { const p = (a) => [100 + 80 * Math.cos(Math.PI * (1 - a)), 100 - 80 * Math.sin(Math.PI * (1 - a))]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return sv('path', { d: `M${x0} ${y0}A80 80 0 0 1 ${x1} ${y1}`, fill: 'none', stroke: col, 'stroke-width': '16' }); };
    [[0, .25, 'var(--down)'], [.25, .45, 'color-mix(in srgb, var(--down) 55%, var(--warn))'], [.45, .55, 'var(--warn)'], [.55, .75, 'color-mix(in srgb, var(--up) 60%, var(--warn))'], [.75, 1, 'var(--up)']].forEach(([a, b, c]) => s.append(arc(a + .004, b - .004, c)));
    if (v != null) {
      const a = Math.PI * (1 - v / 100);
      s.append(sv('line', { x1: 100, y1: 100, x2: 100 + 66 * Math.cos(a), y2: 100 - 66 * Math.sin(a), stroke: 'var(--ink)', 'stroke-width': '3.5', 'stroke-linecap': 'round' }));
      s.append(sv('circle', { cx: 100, cy: 100, r: 6, fill: 'var(--ink)' }));
    }
    const t1 = sv('text', { x: 14, y: 111, 'font-size': '9', fill: 'var(--muted)' }); t1.textContent = 'Angst'; s.append(t1);
    const t2 = sv('text', { x: 186, y: 111, 'font-size': '9', fill: 'var(--muted)', 'text-anchor': 'end' }); t2.textContent = 'Gier'; s.append(t2);
    g.append(s);
    const gv = el('div', 'gauge-val'); const b = el('b', '', v == null ? '–' : Math.round(v)); const sp = el('span', '', md.label || ''); sp.style.color = v == null ? '' : moodColor(v);
    gv.append(b, sp);
    if (md.week != null) gv.append(el('div', 'faint', 'vor 1 Woche: ' + Math.round(md.week) + (md.month != null ? ' · vor 1 Monat: ' + Math.round(md.month) : '')));
    g.append(gv);
    const comps = el('div', 'comps');
    (md.components || []).forEach((c) => {
      const r = el('div', 'comp'); r.title = c.desc;
      const m = el('div', 'meter'); const i = el('i'); i.style.width = c.value + '%'; i.style.background = moodColor(c.value); m.append(i);
      r.append(el('span', 'lab', c.label), m, el('span', 'v', Math.round(c.value)));
      comps.append(r);
    });
    comps.append(el('div', 'faint', 'Jeder Balken: 0 = Angst, 100 = Gier. Fahre über einen Balken für die Erklärung.'));
    comps.lastChild.style.fontSize = '11.5px';
    box.append(g, comps);
    const hist = md.history || [];
    const ch = $('mood-chart'); ch.textContent = '';
    if (hist.length > 10) {
      drawChart(ch, { t: hist.map((x) => x[0]), lines: [{ v: hist.map((x) => x[1]), color: 'var(--accent)', label: 'Stimmung', area: true }], h: 130, yDomain: [0, 100], yTicks: [0, 25, 50, 75, 100],
        bands: [{ from: 0, to: 25, color: 'var(--down)' }, { from: 75, to: 100, color: 'var(--up)' }], fmt: (v) => fmtN(v, 0), title: 'Stimmung im letzten Jahr' });
    }
  }
  function renderIdx() {
    const box = $('idx-tiles'); box.textContent = '';
    M.items.filter((i) => i.group === 'idx').forEach((it) => box.append(tile(it)));
  }
  function renderOther() {
    const box = $('other-tiles'); box.textContent = '';
    ['GC=F', 'SI=F', 'BZ=F', 'NG=F', 'BTC-EUR', 'ETH-EUR', 'EURUSD=X', 'EURCHF=X', '^TNX', '^VIX'].forEach((s) => byId[s] && box.append(tile(byId[s])));
  }
  const HEAT_SCALE = { d1: 3, w1: 6, m1: 10, ytd: 30, y1: 40 };
  function heatBg(v, p) {
    if (v == null) return 'var(--chip)';
    const k = Math.min(1, Math.abs(v) / HEAT_SCALE[p]);
    return `color-mix(in srgb, ${v >= 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(12 + k * 68)}%, var(--panel))`;
  }
  function renderHeat() {
    const p = ui.heat;
    document.querySelectorAll('#heat-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === p)));
    const box = $('heat'); box.textContent = '';
    const st = M.items.filter((i) => i.a && (['de', 'us', 'eu', 'depot'].includes(i.group))).sort((a, b) => (b.a[p] ?? -1e9) - (a.a[p] ?? -1e9));
    st.forEach((it) => {
      const v = it.a[p]; const k = v == null ? 0 : Math.min(1, Math.abs(v) / HEAT_SCALE[p]);
      const c = el('button', 'hcell' + (it.depot ? ' dep' : '')); c.type = 'button';
      c.style.background = heatBg(v, p); if (k > .55) c.style.color = '#fff';
      c.append(el('b', '', it.short), el('span', '', fmtP(v, 1)));
      c.title = it.name + ': ' + fmtP(v) + ' (' + PERIOD[p] + ')'; c.onclick = () => openDetail(it.sym);
      box.append(c);
    });
    const lg = $('heat-legend'); lg.textContent = '';
    const s = HEAT_SCALE[p];
    [[-s, 'stark im Minus'], [-s / 4, 'leicht im Minus'], [s / 4, 'leicht im Plus'], [s, 'stark im Plus']].forEach(([v, t]) => { const x = el('span'); const w = el('span', 'sw'); w.style.background = heatBg(v, p); x.append(w, document.createTextNode(t)); lg.append(x); });
    const x = el('span'); const w = el('span', 'sw'); w.style.boxShadow = 'inset 0 0 0 2px var(--accent)'; x.append(w, document.createTextNode('in deinem Depot')); lg.append(x);
    const up = st.filter((i) => (i.a[p] || 0) > 0).length; lg.append(el('span', '', `· ${up} von ${st.length} im Plus`));
  }
  function moverRow(it, p) {
    const b = el('button', 'ev'); b.type = 'button'; b.onclick = () => openDetail(it.sym);
    const i = el('i', it.a[p] >= 0 ? 'pos' : 'neg');
    const d = el('div'); d.style.display = 'flex'; d.style.justifyContent = 'space-between'; d.style.gap = '8px';
    const l = el('span'); l.append(el('b', '', it.short), el('span', 'faint', ' ' + groupLabel(it.group)));
    d.append(l, el('span', 'num ' + tone(it.a[p]), fmtP(it.a[p])));
    b.append(i, d); return b;
  }
  function renderMovers() {
    const p = ui.heat;
    $('win-meta').textContent = $('los-meta').textContent = $('sec-meta').textContent = PERIOD[p];
    const st = M.items.filter((i) => i.a && i.a[p] != null && ['de', 'us', 'eu', 'depot'].includes(i.group)).sort((a, b) => b.a[p] - a.a[p]);
    const w = $('winners'), l = $('losers'); w.textContent = l.textContent = '';
    st.slice(0, 6).forEach((it) => w.append(moverRow(it, p)));
    st.slice(-6).reverse().forEach((it) => l.append(moverRow(it, p)));
    const sec = M.items.filter((i) => i.group === 'sec' && i.a && i.a[p] != null).sort((a, b) => b.a[p] - a.a[p]);
    const box = $('sectors'); box.textContent = '';
    const mx = Math.max(...sec.map((i) => Math.abs(i.a[p])), 0.5);
    sec.forEach((it) => {
      const v = it.a[p]; const r = el('button', 'brow'); r.type = 'button'; r.onclick = () => openDetail(it.sym);
      const tr = el('div', 'btrack'); const bar = el('i'); const wd = Math.abs(v) / mx * 50;
      bar.style.width = wd + '%'; bar.style.left = v >= 0 ? '50%' : (50 - wd) + '%'; bar.style.background = v >= 0 ? 'var(--up)' : 'var(--down)'; tr.append(bar);
      r.append(el('span', 'bn', it.short), tr, el('span', 'bv ' + tone(v), fmtP(v, 1))); box.append(r);
    });
  }
  function renderReport() {
    const box = $('report'); box.textContent = '';
    (M.report.paragraphs || []).forEach((p) => { const d = el('div'); d.append(el('h3', '', p.title), el('p', '', p.text)); box.append(d); });
    $('rep-meta').textContent = 'automatisch erstellt · ' + ago(M.generated_at);
  }
  function allEvents() {
    const out = [];
    M.items.forEach((it) => (it.a && it.a.events || []).forEach((e) => out.push({ it, e, w: e.w + (it.group === 'idx' ? 2 : 0) + (it.depot || favs.has(it.sym) ? 3 : 0) })));
    return out.sort((a, b) => b.w - a.w);
  }
  function renderEvents() {
    const box = $('events'); box.textContent = '';
    const ev = allEvents(); $('ev-meta').textContent = ev.length + ' Signale';
    if (!ev.length) { box.append(el('div', 'empty', 'Heute nichts Ungewöhnliches.')); return; }
    const show = (n) => {
      box.textContent = '';
      ev.slice(0, n).forEach(({ it, e }) => {
        const b = el('button', 'ev'); b.type = 'button'; b.onclick = () => openDetail(it.sym);
        const d = el('div'); d.append(el('b', '', it.short + ': '), document.createTextNode(e.text));
        if (it.depot) { d.append(document.createTextNode(' ')); d.append(el('span', 'badge dep', 'Depot')); }
        b.append(el('i', e.tone), d); box.append(b);
      });
      if (ev.length > n) { const m = el('button', 'btn ghost small', 'Alle ' + ev.length + ' zeigen'); m.style.margin = '8px 14px 12px'; m.onclick = () => show(ev.length); box.append(m); }
    };
    show(10);
  }
  function renderCal() {
    const evs = ((FEED && FEED.calendar) || {}).events || [];
    const today = new Date().toLocaleDateString('sv-SE', TZ);
    const list = evs.filter((e) => e.date >= today).slice(0, 8);
    $('cal-panel').hidden = !list.length;
    const box = $('cal'); box.textContent = '';
    list.forEach((e) => { const d = el('div'); const dt = new Date(e.date + 'T12:00:00Z'); d.append(el('span', 'd', dt.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + (e.time ? ' ' + e.time : '')), el('span', '', e.title)); box.append(d); });
  }

  // ---------- Alle Werte ----------
  const groupLabel = (g) => ((M && M.groups.find((x) => x.id === g)) || {}).label || '';
  function renderChips() {
    const box = $('chips'); box.textContent = '';
    const add = (id, label) => { const c = el('button', 'chip', label); c.type = 'button'; c.setAttribute('aria-pressed', String(ui.group === id)); c.onclick = () => { ui.group = id; saveUi(); renderChips(); renderList(); }; box.append(c); };
    add('all', 'Alle'); add('fav', '★ Favoriten (' + favs.size + ')');
    M.groups.forEach((g) => add(g.id, g.label));
  }
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let xs = M.items.filter((it) => {
      if (ui.group === 'fav' && !favs.has(it.sym)) return false;
      if (ui.group !== 'all' && ui.group !== 'fav' && it.group !== ui.group && !(ui.group === 'depot' && it.depot)) return false;
      if (q && !(it.name + ' ' + it.short + ' ' + it.sym + ' ' + groupLabel(it.group)).toLowerCase().includes(q)) return false;
      return true;
    });
    const s = ui.sort;
    if (s !== 'group') {
      const desc = !s.startsWith('-'); const k = s.replace('-', '');
      xs = xs.filter((i) => i.a).sort((a, b) => { const va = a.a[k] ?? -1e9, vb = b.a[k] ?? -1e9; return desc ? vb - va : va - vb; });
    }
    return xs;
  }
  function starBtn(sym, after) {
    const b = el('button', 'star' + (favs.has(sym) ? ' on' : ''), favs.has(sym) ? '★' : '☆'); b.type = 'button';
    b.setAttribute('aria-label', favs.has(sym) ? 'Aus Favoriten entfernen' : 'Zu Favoriten');
    b.onclick = (e) => { e.stopPropagation(); toggleFav(sym); if (after) after(); };
    return b;
  }
  function toggleFav(sym) { favs.has(sym) ? favs.delete(sym) : favs.add(sym); store.set('mr.favs', [...favs]); renderChips(); renderList(); toast(favs.has(sym) ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt'); }
  function renderList() {
    if (!M) return;
    $('col-head').textContent = 'Heute / ' + PERIOD[ui.col];
    const box = $('list'); box.textContent = '';
    const xs = filtered();
    if (!xs.length) { box.append(el('div', 'empty', ui.group === 'fav' ? 'Noch keine Favoriten. Tippe bei einem Wert auf den Stern ☆.' : 'Nichts gefunden.')); return; }
    let lastG = null;
    xs.forEach((it) => {
      if (ui.sort === 'group' && it.group !== lastG && ui.group === 'all') { lastG = it.group; const h = el('div', '', groupLabel(it.group)); h.style.cssText = 'padding:12px 14px 4px;font-size:11.5px;font-weight:600;color:var(--accent);text-transform:uppercase;letter-spacing:.07em;border-top:1px solid var(--line)'; box.append(h); }
      const r = el('div', 'row'); r.tabIndex = 0; r.setAttribute('role', 'button'); r.onclick = () => openDetail(it.sym); r.onkeydown = (e) => { if (e.key === 'Enter') openDetail(it.sym); };
      const a = it.a;
      const nm = el('div', 'nm'); const b = el('b', '', it.name); nm.append(b);
      const sub = el('span', '', groupLabel(it.group) + (it.depot ? ' · in deinem Depot' : '')); nm.append(sub);
      r.append(starBtn(it.sym), nm);
      if (!a) { r.append(el('span', 'faint', 'keine Daten')); box.append(r); return; }
      r.append(spark(it.spark, 84, 28, lineColor(it.spark.at(-1) - it.spark[0])));
      const px = el('div', 'px', fmtPx(it, a.price)); const u = unit(it); if (u) px.append(el('small', 'faint', ' ' + u));
      r.append(px);
      const ch = el('div', 'ch'); ch.append(el('span', tone(a.d1), chgText(it)), el('small', tone(a[ui.col]), PERIOD[ui.col] + ' ' + fmtP(a[ui.col], 1)));
      r.append(ch);
      const tr = el('div', 'tr'); tr.append(lightEl(it), el('span', '', a.trend));
      if (a.temp === 'hot' || a.temp === 'warm') tr.append(el('span', 'badge hot', 'heiß'));
      if (a.temp === 'cold' || a.temp === 'cool') tr.append(el('span', 'badge cold', 'ausverkauft'));
      r.append(tr);
      box.append(r);
    });
  }

  // ---------- Diagramm ----------
  function niceTicks(mn, mx, n) {
    const span = mx - mn || Math.abs(mx) || 1; const step0 = span / n; const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
    const out = []; for (let v = Math.ceil(mn / step) * step; v <= mx + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
  }
  function drawChart(host, o) {
    host.textContent = '';
    const draw = () => {
      host.textContent = '';
      const W = Math.max(260, host.clientWidth - 8), H = o.h || 260, L = 6, R = 62, T = 10, B = 22;
      const n = o.t.length; if (n < 2) return;
      let mn = Infinity, mx = -Infinity;
      if (o.yDomain) [mn, mx] = o.yDomain; else {
        o.lines.forEach((l) => l.v.forEach((v) => { if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
        (o.band ? [o.band.lo, o.band.hi] : []).forEach((a) => a.forEach((v) => { if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
        const pad = (mx - mn) * 0.06 || Math.abs(mx) * 0.02 || 1; mn -= pad; mx += pad;
      }
      const X = (i) => L + (i / (n - 1)) * (W - L - R), Y = (v) => T + (1 - (v - mn) / (mx - mn)) * (H - T - B);
      const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || 'Diagramm' });
      (o.bands || []).forEach((b) => s.append(sv('rect', { x: L, y: Y(b.to), width: W - L - R, height: Math.abs(Y(b.from) - Y(b.to)), fill: b.color, opacity: '.08' })));
      const ticks = o.yTicks || niceTicks(mn, mx, 4);
      ticks.forEach((v) => { if (v < mn || v > mx) return; s.append(sv('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'var(--line)', 'stroke-width': '1' }));
        const t = sv('text', { x: W - R + 6, y: Y(v) + 4, 'font-size': '10.5', fill: 'var(--faint)', 'font-family': 'var(--f-num)' }); t.textContent = (o.axisFmt || o.fmt)(v); s.append(t); });
      (o.hlines || []).forEach((h) => s.append(sv('line', { x1: L, x2: W - R, y1: Y(h.y), y2: Y(h.y), stroke: h.color, 'stroke-dasharray': '4 3', 'stroke-width': '1' })));
      const nx = Math.min(5, Math.floor(W / 110));
      for (let k = 0; k <= nx; k++) { const i = Math.round(k * (n - 1) / nx); const t = sv('text', { x: X(i), y: H - 5, 'font-size': '10.5', fill: 'var(--faint)', 'text-anchor': k === 0 ? 'start' : k === nx ? 'end' : 'middle' }); t.textContent = fmtDate(o.t[i], n > 300); s.append(t); }
      if (o.band) {
        let d = '', d2 = '';
        o.band.hi.forEach((v, i) => { if (v != null) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); });
        for (let i = n - 1; i >= 0; i--) { const v = o.band.lo[i]; if (v != null) d2 += 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }
        if (d) s.append(sv('path', { d: d + d2 + 'Z', fill: o.band.color, opacity: '.10' }));
      }
      o.lines.forEach((l, li) => {
        let d = ''; let started = false;
        l.v.forEach((v, i) => { if (v == null) { started = false; return; } d += (started ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); started = true; });
        if (l.area && d) { const first = l.v.findIndex((v) => v != null); s.append(sv('path', { d: d + `L${X(n - 1)} ${H - B}L${X(first)} ${H - B}Z`, fill: l.color, opacity: '.08' })); }
        s.append(sv('path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.width || (li === 0 ? 2 : 1.4), 'stroke-dasharray': l.dash || '', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      });
      // Hover
      const vline = sv('line', { y1: T, y2: H - B, stroke: 'var(--muted)', 'stroke-width': '1', 'stroke-dasharray': '3 3', visibility: 'hidden' }); s.append(vline);
      const dots = o.lines.map((l) => { const c = sv('circle', { r: 4, fill: l.color, stroke: 'var(--panel)', 'stroke-width': '2', visibility: 'hidden' }); s.append(c); return c; });
      const tip = el('div', 'tip'); tip.hidden = true;
      const ov = sv('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' }); s.append(ov);
      const move = (ev) => {
        const r = s.getBoundingClientRect(); const x = (ev.clientX - r.left) * (W / r.width);
        const i = Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - R) * (n - 1))));
        vline.setAttribute('x1', X(i)); vline.setAttribute('x2', X(i)); vline.setAttribute('visibility', 'visible');
        tip.textContent = ''; tip.append(el('div', 'faint', fmtDate(o.t[i], true, true)));
        o.lines.forEach((l, k) => { const v = l.v[i]; if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; } dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('visibility', 'visible');
          if (l.label) { const row = el('div'); const sw = el('span'); sw.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${l.color}`; row.append(sw, document.createTextNode(l.label + ': '), el('b', 'num', (l.fmt || o.fmt)(v))); tip.append(row); } });
        tip.hidden = false;
        const px = (X(i) / W) * r.width; tip.style.left = Math.min(Math.max(4, px + 12), r.width - tip.offsetWidth - 4) + 'px'; tip.style.top = '4px';
      };
      const leave = () => { vline.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hidden = true; };
      ov.addEventListener('pointermove', move); ov.addEventListener('pointerdown', move); ov.addEventListener('pointerleave', leave);
      host.append(s, tip);
    };
    draw();
    if (host._ro) host._ro.disconnect();
    let lastW = host.clientWidth;
    host._ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 4) { lastW = host.clientWidth; draw(); } });
    host._ro.observe(host);
  }
  function fmtDate(iso, withYear, long) {
    const d = new Date(iso + 'T12:00:00Z');
    if (long) return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    return d.toLocaleDateString('de-DE', withYear ? { month: 'short', year: '2-digit' } : { day: '2-digit', month: 'short' });
  }

  // ---------- Indikatoren (für Charts) ----------
  const smaA = (a, n) => { const o = Array(a.length).fill(null); let s = 0; a.forEach((x, i) => { s += x; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }); return o; };
  function bollA(a, n = 20) { const m = smaA(a, n); const lo = [], hi = []; a.forEach((_, i) => { if (m[i] == null) { lo.push(null); hi.push(null); return; } let s = 0; for (let k = i - n + 1; k <= i; k++) s += (a[k] - m[i]) ** 2; const sd = Math.sqrt(s / n); lo.push(m[i] - 2 * sd); hi.push(m[i] + 2 * sd); }); return { lo, hi }; }
  function rsiA(a, n = 14) { const o = Array(a.length).fill(null); if (a.length <= n) return o; let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= n; l /= n; o[n] = l ? 100 - 100 / (1 + g / l) : 100; for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } return o; }

  // ---------- Detail ----------
  const dstate = { range: 252, sma20: false, sma50: true, sma200: true, boll: false };
  let openSym = null;
  async function openDetail(sym, noPush) {
    const it = byId[sym]; if (!it) return;
    openSym = sym;
    if (!noPush) history.pushState({ d: sym }, '', '#wert=' + encodeURIComponent(sym));
    const sh = $('sheet'), box = $('sheet-in'); box.textContent = ''; sh.hidden = false; document.body.style.overflow = 'hidden';
    const a = it.a || {};
    // Kopf
    const head = el('div', 'dhead');
    const l = el('div'); const h2 = el('h2', '', it.name); h2.id = 'd-title';
    l.append(h2, el('div', 'sub', [groupLabel(it.group), it.exchange, it.sym, it.depot ? 'in deinem Depot' : ''].filter(Boolean).join(' · ')));
    const pr = el('div'); pr.style.textAlign = 'right';
    pr.append(el('div', 'dprice', fmtPxU(it, a.price)), el('div', 'num ' + tone(a.d1), chgText(it) + ' heute'));
    if (it.time) pr.append(el('div', 'faint', 'Kurs ' + ago(it.time)));
    const acts = el('div', 'actions'); acts.style.width = '100%';
    const fav = el('button', 'btn ghost small', favs.has(sym) ? '★ Favorit' : '☆ Favorit'); fav.onclick = () => { toggleFav(sym); fav.textContent = favs.has(sym) ? '★ Favorit' : '☆ Favorit'; };
    const al = el('button', 'btn ghost small', '⏰ Kurs-Wecker'); al.onclick = () => { closeDetail(); switchTab('alarme'); $('al-sym').value = sym; $('al-price').value = ''; $('al-price').placeholder = 'z. B. ' + fmtPx(it, a.price); $('al-price').focus(); };
    const cm = el('button', 'btn ghost small', '⇄ Vergleichen'); cm.onclick = () => { if (!cmp.includes(sym)) { cmp = [sym, ...cmp].slice(0, 5); store.set('mr.cmp', cmp); } closeDetail(); switchTab('vergleich'); };
    const ki = el('button', 'btn ghost small', '✦ KI erklären'); ki.onclick = () => { closeDetail(); switchTab('ki'); $('ki-q').value = `Erklär mir ${it.name}: Was ist da gerade los und warum? Was sagen die Signale?`; sendKi(); };
    const cl = el('button', 'btn small', 'Schließen'); cl.onclick = () => closeDetail();
    acts.append(fav, al, cm, ki, cl);
    head.append(l, pr, acts);
    box.append(head);
    if (!it.a) { box.append(el('div', 'panel empty', 'Für diesen Wert gibt es gerade keine Daten.')); return; }

    // Ampel-Urteil
    const vp = el('div', 'panel verdict');
    const amp = el('div', 'amp' + (a.light === 'blue' ? ' blue' : '')); amp.setAttribute('aria-hidden', 'true');
    ['r', 'y', 'g'].forEach((c) => amp.append(el('i', c + ((a.light === 'red' && c === 'r') || (a.light === 'yellow' && c === 'y') || (a.light === 'green' && c === 'g') || (a.light === 'blue' && c === (a.score > 20 ? 'g' : a.score < -20 ? 'r' : 'y')) ? ' on' : ''))));
    const vt = el('div'); const vb = el('b', '', a.trend); vt.append(vb, el('div', '', a.summary));
    const sc = el('div', 'faint'); sc.style.fontSize = '12px'; sc.style.marginTop = '4px';
    sc.textContent = 'Trend-Wert ' + Math.round(a.score) + ' von −100 bis +100 · Temperatur: ' + (a.temp_txt || 'normal') + ' · Schwankung: ' + a.risk_txt;
    const hb = el('button', 'help', '?'); hb.dataset.help = 'ampel'; hb.style.marginLeft = '6px'; sc.append(hb);
    vt.append(sc); vp.append(amp, vt); box.append(vp);

    // Chart
    const cp = el('div', 'panel');
    const php = el('div', 'ph'); php.append(el('h2', '', 'Kursverlauf'));
    const seg = el('div', 'seg'); [[21, '1M'], [63, '3M'], [126, '6M'], [252, '1J'], [9999, '2J']].forEach(([r, t]) => { const b = el('button', '', t); b.type = 'button'; b.setAttribute('aria-pressed', String(dstate.range === r)); b.onclick = () => { dstate.range = r; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(); }; seg.append(b); });
    php.append(seg); cp.append(php);
    const tg = el('div', 'cbar'); const tgl = el('div', 'toggles');
    [['sma20', '20 Tage', 'var(--c3)'], ['sma50', '50 Tage', 'var(--c2)'], ['sma200', '200 Tage', 'var(--c4)'], ['boll', 'Bollinger-Band', 'var(--c5)']].forEach(([k, t, c]) => {
      const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = dstate[k]; cb.onchange = () => { dstate[k] = cb.checked; paint(); };
      const sw = el('span', 'sw'); sw.style.background = c; lab.append(cb, sw, document.createTextNode(k === 'boll' ? t : 'Ø ' + t)); tgl.append(lab);
    });
    const hb2 = el('button', 'help', '?'); hb2.dataset.help = 'sma'; tgl.append(hb2);
    tg.append(tgl); cp.append(tg);
    const ch = el('div', 'chart'); ch.append(el('div', 'empty', 'Lade Kursverlauf …')); cp.append(ch);
    const rh = el('div', 'ph'); rh.style.borderTop = '1px solid var(--line)'; const rt = el('h2', '', 'RSI – Temperatur '); const hb3 = el('button', 'help', '?'); hb3.dataset.help = 'rsi'; rt.append(hb3); rh.append(rt, el('span', 'meta', 'über 70 = heißgelaufen · unter 30 = ausverkauft')); cp.append(rh);
    const rc = el('div', 'chart'); cp.append(rc);
    box.append(cp);

    // Kennzahlen
    const mp = el('div', 'panel'); const mh = el('div', 'ph'); mh.append(el('h2', '', 'Kennzahlen einfach erklärt')); mp.append(mh);
    const mg = el('div', 'metrics');
    const met = (lab, val, ex, help, cls) => { const m = el('div', 'metric'); const lb = el('div', 'lab'); lb.append(el('span', '', lab)); if (help) { const b = el('button', 'help', '?'); b.dataset.help = help; lb.append(b); } m.append(lb, el('div', 'val ' + (cls || ''), val)); if (ex) m.append(el('div', 'ex', ex)); mg.append(m); };
    ['w1', 'm1', 'm3', 'ytd', 'y1', 'y2'].forEach((k) => met(PERIOD[k], fmtP(a[k]), a[k] == null ? '' : 'aus 1.000 € wären ' + fmtN(1000 * (1 + a[k] / 100), 0) + ' €', k === 'ytd' ? 'ytd' : null, tone(a[k])));
    met('52-Wochen-Hoch', fmtPx(it, a.hi52), 'aktuell ' + fmtP(a.from_hi, 1) + ' davon entfernt', 'hi52');
    met('52-Wochen-Tief', fmtPx(it, a.lo52), 'aktuell ' + fmtP(a.from_lo, 1) + ' darüber', 'hi52');
    met('Größter Rückgang (1 J.)', fmtP(a.mdd1y, 1), 'so tief ging es zwischendurch vom Hoch', 'mdd', 'down');
    met('Schwankung (Volatilität)', fmtN(a.vol20, 0) + ' %', a.risk_txt + (a.vol1y ? ' · üblich: ' + fmtN(a.vol1y, 0) + ' %' : ''), 'vol');
    met('Typische Tagesbewegung', '± ' + fmtN(a.dsig, 1) + ' %', 'so viel bewegt es sich an einem normalen Tag', 'vol');
    met('RSI (14 Tage)', fmtN(a.rsi, 0), a.temp_txt, 'rsi', a.rsi >= 70 ? 'down' : a.rsi <= 30 ? 'up' : '');
    met('Ø 50 Tage', fmtPx(it, a.sma50), a.sma50 ? (a.price > a.sma50 ? 'Kurs liegt darüber ✓' : 'Kurs liegt darunter ✗') : '', 'sma');
    met('Ø 200 Tage', fmtPx(it, a.sma200), a.sma200 ? (a.price > a.sma200 ? 'Kurs liegt darüber ✓ (langfristig gut)' : 'Kurs liegt darunter ✗ (langfristig schwach)') : '', 'sma');
    met('Spanne 4 Wochen', fmtPx(it, a.range20_lo) + ' – ' + fmtPx(it, a.range20_hi), 'Tief und Hoch der letzten 20 Handelstage', 'range');
    met('MACD (Schwung)', a.macd_hist == null ? 'k. A.' : a.macd_hist > 0 ? 'nimmt zu ▲' : 'lässt nach ▼', '', 'macd', a.macd_hist > 0 ? 'up' : 'down');
    if (a.vol_ratio) met('Handelsvolumen', fmtN(a.vol_ratio, 1) + '×', 'im Vergleich zum Durchschnitt', 'volume');
    mp.append(mg); box.append(mp);

    // Signale
    if (a.events && a.events.length) {
      const ep = el('div', 'panel'); const eh = el('div', 'ph'); eh.append(el('h2', '', 'Signale')); ep.append(eh);
      const ev = el('div', 'events'); a.events.forEach((e) => { const r = el('div', 'ev'); r.append(el('i', e.tone), el('div', '', e.text)); ev.append(r); }); ep.append(ev); box.append(ep);
    }

    // Was wäre wenn
    const wp = el('div', 'panel'); const wh = el('div', 'ph'); wh.append(el('h2', '', 'Was wäre, wenn …?')); wh.append(el('span', 'meta', 'Rechner mit echten Kursen')); wp.append(wh);
    const wb = el('div', 'pb whatif');
    const fr = el('div', 'frow');
    const mode = el('select'); [['once', 'Einmal angelegt'], ['plan', 'Monatlicher Sparplan']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; mode.append(o); });
    const amt = el('input'); amt.type = 'number'; amt.value = '1000'; amt.min = '1'; amt.setAttribute('aria-label', 'Betrag in Euro');
    const per = el('select'); [[21, 'vor 1 Monat'], [63, 'vor 3 Monaten'], [126, 'vor 6 Monaten'], [252, 'vor 1 Jahr'], [9999, 'vor 2 Jahren']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; per.append(o); }); per.value = '252';
    fr.append(mode, amt, per); const res = el('div', 'res'); wb.append(fr, res);
    wb.append(el('div', 'faint', 'Ohne Gebühren, Steuern, Dividenden und Wechselkurs. Vergangene Entwicklung ist keine Garantie für die Zukunft.'));
    wb.lastChild.style.fontSize = '11.5px';
    wp.append(wb); box.append(wp);
    box.append(el('p', 'foot', 'Automatische Auswertung von Kursdaten – keine Anlageberatung. Signale beschreiben die Vergangenheit, nicht die Zukunft.'));

    let ser = null;
    function paint() {
      if (!ser) return;
      const n = ser.c.length; const st = Math.max(0, n - dstate.range);
      const c = ser.c, t = ser.t.slice(st);
      const lines = [{ v: c.slice(st), color: 'var(--c1)', label: 'Kurs', area: true }];
      if (dstate.sma20) lines.push({ v: smaA(c, 20).slice(st), color: 'var(--c3)', label: 'Ø 20', width: 1.3 });
      if (dstate.sma50) lines.push({ v: smaA(c, 50).slice(st), color: 'var(--c2)', label: 'Ø 50', width: 1.3 });
      if (dstate.sma200) lines.push({ v: smaA(c, 200).slice(st), color: 'var(--c4)', label: 'Ø 200', width: 1.3 });
      let band = null; if (dstate.boll) { const b = bollA(c); band = { lo: b.lo.slice(st), hi: b.hi.slice(st), color: 'var(--c5)' }; }
      drawChart(ch, { t, lines, band, h: 280, fmt: (v) => fmtPx(it, v), axisFmt: (v) => fmtN(v, Math.abs(v) >= 1000 ? 0 : Math.min(decimals(it, v), 2)), title: 'Kursverlauf ' + it.name });
      drawChart(rc, { t, lines: [{ v: rsiA(c).slice(st), color: 'var(--c5)', label: 'RSI' }], h: 110, yDomain: [0, 100], yTicks: [30, 50, 70], fmt: (v) => fmtN(v, 0),
        bands: [{ from: 70, to: 100, color: 'var(--down)' }, { from: 0, to: 30, color: 'var(--up)' }], title: 'RSI' });
    }
    function calc() {
      res.textContent = '';
      if (!ser) { res.append(el('span', 'faint', 'Lade Kurse …')); return; }
      const n = ser.c.length; const k = Math.min(n - 1, +per.value); const st = n - 1 - k; const A = Math.max(0, +amt.value || 0);
      const p0 = ser.c[st], p1 = ser.c[n - 1];
      if (mode.value === 'once') {
        const v = A * p1 / p0; const g = v - A;
        res.append(document.createTextNode('Aus ' + fmtN(A, 0) + ' € am ' + fmtDate(ser.t[st], true, true) + ' wären heute '), el('b', tone(g), fmtN(v, 2) + ' €'), document.createTextNode(' geworden (' + (g >= 0 ? '+' : '−') + fmtN(Math.abs(g), 2) + ' €, ' + fmtP((p1 / p0 - 1) * 100, 1) + ').'));
      } else {
        let units = 0, paid = 0, lastM = '';
        for (let i = st; i < n; i++) { const m = ser.t[i].slice(0, 7); if (m !== lastM) { lastM = m; units += A / ser.c[i]; paid += A; } }
        const v = units * p1; const g = v - paid;
        res.append(document.createTextNode('Mit ' + fmtN(A, 0) + ' € jeden Monat seit ' + fmtDate(ser.t[st], true, true) + ' hättest du ' + fmtN(paid, 0) + ' € eingezahlt. Wert heute: '), el('b', tone(g), fmtN(v, 2) + ' €'), document.createTextNode(' (' + (g >= 0 ? '+' : '−') + fmtN(Math.abs(g), 2) + ' €).'));
      }
    }
    [mode, amt, per].forEach((x) => x.addEventListener('input', calc));
    calc();
    try { await loadSeries(); } catch (e) { ch.textContent = ''; ch.append(el('div', 'empty', 'Kursverlauf nicht erreichbar.')); return; }
    if (openSym !== sym) return;
    ser = series(sym);
    if (!ser) { ch.textContent = ''; ch.append(el('div', 'empty', 'Kein Kursverlauf vorhanden.')); return; }
    paint(); calc();
  }
  function closeDetail(fromPop) {
    if ($('sheet').hidden) return;
    $('sheet').hidden = true; document.body.style.overflow = ''; openSym = null;
    if (!fromPop && history.state && history.state.d) history.back();
  }
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeDetail(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeDetail(); } });
  window.addEventListener('popstate', () => { const m = location.hash.match(/^#wert=(.+)$/); if (m && byId[decodeURIComponent(m[1])]) openDetail(decodeURIComponent(m[1]), true); else closeDetail(true); });

  // ---------- Vergleich ----------
  function renderCmpSelect() {
    const s = $('cmp-add'), a = $('al-sym'); const keepA = a.value;
    [s, a].forEach((x) => { x.textContent = ''; });
    M.groups.forEach((g) => {
      const og = document.createElement('optgroup'); og.label = g.label; const og2 = og.cloneNode();
      M.items.filter((i) => i.group === g.id && i.a).forEach((i) => { const o = el('option', '', i.name); o.value = i.sym; og.append(o); og2.append(o.cloneNode(true)); });
      s.append(og); a.append(og2);
    });
    if (keepA) a.value = keepA;
  }
  const CMPC = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
  async function renderCmp() {
    document.querySelectorAll('#cmp-range button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.r === ui.cmpR)));
    cmp = cmp.filter((s) => byId[s]);
    const chips = $('cmp-chips'); chips.textContent = '';
    cmp.forEach((s, k) => { const c = el('button', 'chip'); c.type = 'button'; c.setAttribute('aria-pressed', 'true'); c.style.borderColor = CMPC[k]; const sw = el('span'); sw.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${CMPC[k]}`; c.append(sw, document.createTextNode(byId[s].short + '  ✕')); c.onclick = () => { cmp = cmp.filter((x) => x !== s); store.set('mr.cmp', cmp); renderCmp(); }; chips.append(c); });
    const host = $('cmp-chart'); const tb = $('cmp-table'); tb.textContent = '';
    if (!cmp.length) { host.textContent = ''; host.append(el('div', 'empty', 'Wähle oben Werte aus, die du vergleichen willst.')); return; }
    host.textContent = ''; host.append(el('div', 'empty', 'Lade …'));
    try { await loadSeries(); } catch (e) { host.textContent = ''; host.append(el('div', 'empty', 'Kursverläufe nicht erreichbar.')); return; }
    // gemeinsame Zeitachse: Datum des ersten Werts, Kurse der anderen zum letzten Stand an diesem Tag
    const sers = cmp.map((s) => series(s)).filter(Boolean);
    const days = [...new Set(sers.flatMap((x) => x.t))].sort();
    const allCrypto = cmp.every((s) => byId[s].kind === 'crypto');
    const firstDay = sers.map((x) => x.t[0]).sort().at(-1);
    const back = new Date(Date.now() - Math.round(ui.cmpR * 365 / 252) * 864e5).toISOString().slice(0, 10);
    const startDay = back > firstDay ? back : firstDay;
    const D = days.filter((d) => d >= startDay && (allCrypto || ![0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())));
    const lines = sers.map((x, k) => {
      let j = 0, base = null; const v = [];
      D.forEach((d) => { while (j + 1 < x.t.length && x.t[j + 1] <= d) j++; if (x.t[j] > d) { v.push(null); return; } if (base == null) base = x.c[j]; v.push((x.c[j] / base - 1) * 100); });
      return { v, color: CMPC[k], label: byId[cmp[k]].short, fmt: (y) => fmtP(y, 1) };
    });
    drawChart(host, { t: D, lines, h: 320, fmt: (v) => fmtP(v, 0), hlines: [{ y: 0, color: 'var(--muted)' }], title: 'Vergleich' });
    // Tabelle
    const hd = el('tr'); ['Wert', 'Ergebnis', 'Schwankung', 'Größter Rückgang', 'Trend'].forEach((h, i) => { const th = el('th', '', h); th.style.cssText = `padding:8px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--sub);text-align:${i ? 'right' : 'left'};white-space:nowrap`; hd.append(th); }); tb.append(hd);
    lines.forEach((l, k) => {
      const vals = l.v.filter((x) => x != null); const last = vals.at(-1);
      let peak = -Infinity, dd = 0; vals.forEach((x) => { const lv = 1 + x / 100; peak = Math.max(peak, lv); dd = Math.min(dd, lv / peak - 1); });
      const it = byId[cmp[k]];
      const tr = el('tr'); const cells = [it.name, fmtP(last, 1), fmtN(it.a.vol1y, 0) + ' %', fmtP(dd * 100, 1), it.a.trend];
      cells.forEach((c, i) => { const td = el('td', i === 1 ? tone(last) : '', c); td.style.cssText = `padding:8px 14px;border-top:1px solid var(--line);text-align:${i ? 'right' : 'left'};white-space:nowrap;${i && i < 4 ? 'font-family:var(--f-num)' : ''}`; if (!i) { const sw = el('span'); sw.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:8px;background:${l.color}`; td.prepend(sw); } tr.append(td); });
      tb.append(tr);
    });
  }
  $('cmp-add-btn').onclick = () => { const s = $('cmp-add').value; if (!s) return; if (cmp.includes(s)) { toast('Schon im Vergleich'); return; } if (cmp.length >= 5) { toast('Höchstens 5 Werte – entferne erst einen'); return; } cmp.push(s); store.set('mr.cmp', cmp); renderCmp(); };
  document.querySelectorAll('#cmp-range button').forEach((b) => { b.onclick = () => { ui.cmpR = +b.dataset.r; saveUi(); renderCmp(); }; });

  // ---------- Kurs-Wecker ----------
  function renderAlerts() {
    const box = $('al-list'); box.textContent = '';
    if (!alerts.length) { box.append(el('div', 'empty', 'Noch kein Wecker gestellt.')); }
    alerts.forEach((x) => {
      const it = byId[x.sym]; const r = el('div', 'ev');
      const cur = it && it.a ? it.a.price : null;
      r.append(el('i', x.hit ? 'pos' : 'info'));
      const d = el('div'); d.style.cssText = 'display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center';
      const t = el('span'); t.append(el('b', '', it ? it.short : x.sym), document.createTextNode(' ' + (x.dir === 'above' ? 'steigt über ' : 'fällt unter ') + (it ? fmtPxU(it, x.price) : x.price)));
      if (cur != null) t.append(el('span', 'faint', ' · jetzt ' + fmtPx(it, cur) + ' (' + fmtP((x.price / cur - 1) * 100, 1) + ' entfernt)'));
      if (x.hit) t.append(document.createTextNode(' '), el('span', 'badge pos', '✓ erreicht ' + ago(x.hit)));
      const del = el('button', 'btn ghost small', 'Löschen'); del.onclick = () => { alerts = alerts.filter((y) => y !== x); store.set('mr.alerts', alerts); renderAlerts(); checkAlerts(); };
      d.append(t, del); r.append(d); box.append(r);
    });
    const st = $('al-notify-st');
    if (!('Notification' in window)) { $('al-notify').hidden = true; st.textContent = 'Mitteilungen werden von diesem Browser nicht unterstützt.'; }
    else st.textContent = Notification.permission === 'granted' ? 'Mitteilungen sind erlaubt.' : Notification.permission === 'denied' ? 'Mitteilungen sind blockiert (in den Browser-Einstellungen änderbar).' : '';
  }
  function checkAlerts() {
    if (!M) return;
    let changed = false; const hits = [];
    alerts.forEach((x) => {
      const it = byId[x.sym]; if (!it || !it.a) return;
      const p = it.a.price; const ok = x.dir === 'above' ? p >= x.price : p <= x.price;
      if (ok && !x.hit) { x.hit = new Date().toISOString(); changed = true; hits.push({ x, it }); }
      if (x.hit && Date.now() - Date.parse(x.hit) < 3 * 864e5) hits.push({ x, it, old: true });
    });
    if (changed) store.set('mr.alerts', alerts);
    const box = $('alerts-hit'); box.textContent = '';
    const seen = new Set(); const show = hits.filter((h) => !seen.has(h.x) && seen.add(h.x));
    box.hidden = !show.length;
    if (show.length) {
      const b = el('div', 'alertbar'); b.append(el('b', '', '⏰ Kurs-Wecker'));
      show.forEach(({ x, it }) => { const l = el('div'); l.append(document.createTextNode(it.short + ' ist ' + (x.dir === 'above' ? 'über ' : 'unter ') + fmtPxU(it, x.price) + (x.dir === 'above' ? ' gestiegen' : ' gefallen') + ' (jetzt ' + fmtPxU(it, it.a.price) + '). ')); const a = el('a', '', 'Ansehen'); a.href = '#'; a.onclick = (e) => { e.preventDefault(); openDetail(it.sym); }; l.append(a); b.append(l); });
      box.append(b);
    }
    hits.filter((h) => !h.old).forEach(({ x, it }) => { try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Kurs-Wecker: ' + it.short, { body: it.short + ' ' + (x.dir === 'above' ? 'über ' : 'unter ') + fmtPxU(it, x.price) + ' – jetzt ' + fmtPxU(it, it.a.price), icon: 'icons/icon-192.png' }); } catch (_) {} });
    if (changed) renderAlerts();
  }
  $('al-add').onclick = () => {
    const sym = $('al-sym').value; const p = parseFloat(String($('al-price').value).replace(',', '.'));
    if (!sym || !isFinite(p) || p <= 0) { toast('Bitte einen Kurs eintragen'); return; }
    alerts.push({ sym, dir: $('al-dir').value, price: p, created: new Date().toISOString() }); store.set('mr.alerts', alerts);
    $('al-price').value = ''; renderAlerts(); checkAlerts(); toast('Wecker gestellt');
  };
  $('al-sym').onchange = () => { const it = byId[$('al-sym').value]; if (it && it.a) $('al-price').placeholder = 'jetzt ' + fmtPx(it, it.a.price); };
  $('al-notify').onclick = async () => { try { await Notification.requestPermission(); } catch (_) {} renderAlerts(); };

  // ---------- KI ----------
  function kiContext() {
    const items = M.items.filter((i) => i.a).map((i) => ({ n: i.name, g: groupLabel(i.group), kurs: +i.a.price.toPrecision(6), einheit: unit(i), heute: i.a.d1, woche: i.a.w1, monat: i.a.m1, seit_1_1: i.a.ytd, jahr: i.a.y1, trend: i.a.trend, rsi: i.a.rsi != null ? Math.round(i.a.rsi) : null, vom_hoch: i.a.from_hi, signale: (i.a.events || []).map((e) => e.text), depot: i.depot || undefined }));
    return { stand: M.generated_at, stimmung: { wert: M.mood.value, label: M.mood.label, teile: M.mood.components.map((c) => c.label + ' ' + Math.round(c.value)) }, bericht: M.report, werte: items };
  }
  function getKey() { try { return localStorage.getItem('pf.key') || ''; } catch (_) { return ''; } }
  function model() { const u = store.get('pf.ui', {}); return PRICES[u.model] ? u.model : 'claude-sonnet-5-5'; }
  const PRESETS = ['Erklär mir den heutigen Börsentag in einfachen Worten.', 'Warum ist die Stimmung gerade so, wie sie ist?', 'Was sind heute die wichtigsten Nachrichten für die Börse?', 'Wie stehen meine Depotwerte im Vergleich zum Markt da?', 'Welche Branchen laufen gerade gut und warum?', 'Erklär mir als Anfänger, was ein ETF ist und warum viele damit starten.'];
  function renderKiPresets() {
    const box = $('ki-presets'); if (box.childElementCount) return;
    PRESETS.forEach((p) => { const c = el('button', 'chip', p); c.type = 'button'; c.onclick = () => { $('ki-q').value = p; sendKi(); }; box.append(c); });
    const k = getKey(); $('ki-meta').textContent = k ? 'Schlüssel aus der Depot-App · ' + model().replace('claude-', '').replace(/-/g, ' ') : 'kein API-Schlüssel';
  }
  function md(text) {
    const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n'); let html = '', inList = false;
    lines.forEach((l) => { const m = l.match(/^\s*[-*•]\s+(.*)/); if (m) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + m[1] + '</li>'; return; } if (inList) { html += '</ul>'; inList = false; } const h = l.match(/^#{1,4}\s+(.*)/); if (h) html += '<p><b>' + h[1] + '</b></p>'; else if (l.trim()) html += '<p>' + l + '</p>'; });
    if (inList) html += '</ul>'; return html;
  }
  let kiHistory = [];
  async function sendKi() {
    const q = $('ki-q').value.trim(); if (!q) return;
    const out = $('ki-out'); const key = getKey();
    if (!key) { out.prepend(Object.assign(el('div', 'answer'), { innerHTML: '<p><b>Für „KI fragen“ brauchst du einen Claude-API-Schlüssel.</b></p><p>Trag ihn in der Depot-App unter Einstellungen ein (<a href="index.html">Mein Depot</a> → Zahnrad). Er wird nur auf diesem Gerät gespeichert und gilt dann auch hier.</p>' })); return; }
    const btn = $('ki-send'); btn.disabled = true; $('ki-state').textContent = 'Claude denkt nach und sucht im Web …';
    const qa = el('div', 'kirow'); const qd = el('div', 'faint', 'Du: ' + q); const ad = el('div', 'answer', '…'); qa.append(qd, ad); out.prepend(qa);
    const system = 'Du bist ein geduldiger Börsen-Erklärer für Einsteiger ohne Vorwissen. Antworte auf Deutsch, kurz, klar und freundlich, ohne Fachchinesisch (Fachbegriffe kurz erklären). '
      + 'Nutze die mitgelieferten Marktdaten (automatisch berechnet aus Yahoo-Finance-Kursen) als Grundlage und suche im Web nach aktuellen Gründen und Nachrichten, wenn danach gefragt wird. '
      + 'Gib keine persönlichen Kauf- oder Verkaufsempfehlungen; ordne ein und erkläre stattdessen. Nenne Zahlen mit deutschem Komma. Heute ist ' + new Date().toLocaleString('de-DE', { ...TZ, dateStyle: 'full', timeStyle: 'short' }) + '.';
    const prompt = (kiHistory.length ? '' : 'Aktuelle Marktdaten (JSON):\n' + JSON.stringify(kiContext()) + '\n\n') + 'Frage: ' + q;
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'DE', timezone: 'Europe/Berlin' } }];
    let messages = [...kiHistory, { role: 'user', content: prompt }]; const content = []; let inp = 0, outp = 0, srch = 0;
    try {
      for (let step = 0; step < 5; step++) {
        const res = await fetch(API_URL, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: model(), max_tokens: 1500, system, tools, messages }) });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error && body.error.message) || 'Fehler ' + res.status);
        const u = body.usage || {}; inp += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); outp += u.output_tokens || 0; srch += (u.server_tool_use || {}).web_search_requests || 0;
        content.push(...body.content);
        if (body.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: body.content }]; continue; }
        break;
      }
      const texts = content.filter((b) => b.type === 'text'); const text = texts.map((b) => b.text).join('');
      ad.innerHTML = md(text || '(keine Antwort)');
      const seen = new Set(); const src = el('div', 'srcs');
      texts.forEach((b) => (b.citations || []).forEach((c) => { if (c.url && /^https:\/\//.test(c.url) && !seen.has(c.url)) { seen.add(c.url); const a = el('a', '', c.title || new URL(c.url).hostname); a.href = c.url; a.target = '_blank'; a.rel = 'noopener'; src.append(a); } }));
      if (seen.size) ad.append(src);
      kiHistory = [...kiHistory, { role: 'user', content: prompt }, { role: 'assistant', content: text || '…' }];
      if (kiHistory.length > 8) kiHistory = [...kiHistory.slice(0, 2), ...kiHistory.slice(-6)];
      const p = PRICES[model()]; const cost = inp / 1e6 * p[0] + outp / 1e6 * p[1] + srch * 0.01;
      $('ki-state').textContent = 'Kosten ca. ' + cost.toFixed(3).replace('.', ',') + ' $';
    } catch (e) { ad.textContent = 'Das hat nicht geklappt: ' + e.message; $('ki-state').textContent = ''; }
    btn.disabled = false; $('ki-q').value = '';
  }
  $('ki-send').onclick = sendKi;
  $('ki-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendKi(); });

  // ---------- Lexikon ----------
  const LX = [
    ['ampel', 'Trend-Ampel', ['Die Ampel fasst zusammen, in welche Richtung sich ein Kurs gerade bewegt. Grün = Aufwärtstrend, Gelb = seitwärts/unklar, Rot = Abwärtstrend. Bei Zinsen, Währungen und dem VIX ist die Ampel blau, weil „steigt“ dort nicht automatisch gut oder schlecht ist.', 'Berechnet wird ein Trend-Wert von −100 bis +100 aus: Lage zur 50- und 200-Tage-Linie, Richtung der 50-Tage-Linie, Entwicklung der letzten 3 Monate, MACD und heutiger Bewegung.', 'Wichtig: Die Ampel beschreibt die Vergangenheit. Sie ist keine Kauf- oder Verkaufsempfehlung.']],
    ['mood', 'Stimmungsbarometer (Angst & Gier)', ['Zeigt, ob Anleger gerade eher ängstlich (0) oder gierig (100) sind. Es setzt sich aus sechs Teilen zusammen: Schwung des S&P 500, Anteil der Aktien im Aufwärtstrend, neue Hochs gegen neue Tiefs, VIX, Aktien gegen sichere Anleihen und riskante gegen sichere Anleihen.', 'Viele Profis lesen es „gegen den Strich“: Extreme Angst war oft eher eine Chance, extreme Gier eher ein Warnsignal.'], 'Beispiel: Fällt der Markt eine Woche stark und der VIX springt hoch, rutscht das Barometer in Richtung „Angst“.'],
    ['index', 'Index (DAX, S&P 500 …)', ['Ein Index misst, wie sich eine Gruppe von Aktien insgesamt entwickelt. Der DAX enthält die 40 größten deutschen Firmen, der S&P 500 die 500 größten in den USA, der Nasdaq 100 vor allem Technologie-Firmen.', 'Indizes zeigen „den Markt“. Steigt der DAX, ging es den großen deutschen Aktien im Schnitt gut.']],
    ['etf', 'ETF', ['Ein ETF ist ein Fonds, der einen Index nachbildet und an der Börse gehandelt wird. Mit einem MSCI-World-ETF kaufst du auf einen Schlag über 1.000 Firmen aus aller Welt.', 'Vorteile: günstig, breit gestreut, einfach. Darum starten viele Einsteiger mit einem ETF-Sparplan.']],
    ['sma', 'Gleitende Durchschnitte (Ø 50 / Ø 200 Tage)', ['Der Durchschnittskurs der letzten 50 bzw. 200 Handelstage. Die Linie glättet das tägliche Auf und Ab und zeigt die Grundrichtung.', 'Faustregel: Liegt der Kurs über der 200-Tage-Linie, gilt der langfristige Trend als intakt. Fällt er darunter, ist das ein Warnzeichen, das viele Anleger beachten.'], 'Ø 20 Tage = kurzfristig, Ø 50 = mittelfristig, Ø 200 = langfristig.'],
    ['golden', 'Golden Cross / Death Cross', ['Golden Cross: Die 50-Tage-Linie steigt über die 200-Tage-Linie – gilt als Zeichen, dass ein Aufwärtstrend beginnt.', 'Death Cross: Die 50-Tage-Linie fällt unter die 200-Tage-Linie – gilt als Zeichen für einen Abwärtstrend. Beide Signale kommen recht spät und sind keine Garantie.']],
    ['rsi', 'RSI (Relative-Stärke-Index)', ['Ein „Thermometer“ von 0 bis 100: Wie stark waren die Gewinne gegenüber den Verlusten in den letzten 14 Tagen?', 'Über 70 = heißgelaufen (viel gestiegen in kurzer Zeit, oft folgt eine Pause). Unter 30 = ausverkauft (viel gefallen, oft folgt eine Gegenbewegung). In starken Trends kann der RSI aber lange extrem bleiben.']],
    ['macd', 'MACD (Schwung)', ['Vergleicht einen kurzen (12 Tage) mit einem längeren (26 Tage) Durchschnitt. Dreht der MACD nach oben, nimmt der Aufwärtsschwung zu; dreht er nach unten, lässt er nach.']],
    ['vol', 'Volatilität (Schwankung)', ['Wie stark ein Kurs typischerweise hin und her springt, aufs Jahr gerechnet. 15 % = eher ruhig (z. B. großer Index), 30 % = normal für Einzelaktien, über 50 % = sehr wild (z. B. Krypto).', '„Typische Tagesbewegung“ sagt dir, was an einem normalen Tag passiert. Bewegt sich etwas viel stärker, ist das ungewöhnlich und oft nachrichtengetrieben.']],
    ['hi52', '52-Wochen-Hoch und -Tief', ['Der höchste und niedrigste Kurs im letzten Jahr. Werte nahe am Hoch sind in Form („Stärke zieht Stärke an“), Werte nahe am Tief sind gerade unbeliebt.']],
    ['mdd', 'Größter Rückgang (Drawdown)', ['Wie tief es vom letzten Höchststand zwischendurch maximal nach unten ging. Zeigt, welche Durststrecken man aushalten musste. Wichtig für die Frage: Hätte ich das nervlich ausgehalten?']],
    ['ytd', 'Seit Jahresbeginn (YTD)', ['YTD heißt „Year to Date“: Veränderung seit dem letzten Kurs des Vorjahres.']],
    ['range', 'Unterstützung und Widerstand', ['Bereiche, an denen ein Kurs öfter abprallt. Hier vereinfacht: Tief und Hoch der letzten 4 Wochen. Bricht der Kurs darüber oder darunter aus, beginnt oft eine neue Bewegung.']],
    ['volume', 'Handelsvolumen', ['Wie viele Aktien gehandelt wurden. Doppelt so viel wie üblich bedeutet: Es gibt Neuigkeiten oder großes Interesse. Kursbewegungen mit hohem Volumen gelten als aussagekräftiger.']],
    ['boll', 'Bollinger-Bänder', ['Ein Band um den 20-Tage-Durchschnitt, das sich bei hoher Schwankung weitet und bei Ruhe zusammenzieht. Kurse außerhalb des Bands sind statistisch ungewöhnlich.']],
    ['vix', 'VIX – das Angstbarometer', ['Misst, wie viel Schwankung Profis für den S&P 500 in den nächsten 30 Tagen erwarten. Unter 15 = sehr entspannt, 15–20 = normal, über 30 = deutliche Angst, über 40 = Panik.']],
    ['yield', 'Zinsen / Rendite von Anleihen', ['Die Rendite von US-Staatsanleihen ist einer der wichtigsten Preise der Welt. Steigen die Zinsen, werden sichere Anlagen attraktiver und Aktien – vor allem Technologie – geraten oft unter Druck. Fallende Zinsen helfen Aktien meist.']],
    ['fx', 'Währungen (EUR/USD)', ['EUR/USD 1,10 heißt: 1 Euro kostet 1,10 Dollar. Steigt der Wert, wird der Euro stärker – US-Aktien werden für Euro-Anleger dann rechnerisch etwas weniger wert.']],
    ['sector', 'Branchen (Sektoren)', ['Der Markt wird in Branchen eingeteilt: Technologie, Banken, Energie usw. Laufen „sichere“ Branchen (Versorger, Gesundheit, Basiskonsum) besser als „riskante“ (Technik, Konsum), sind Anleger eher vorsichtig.', 'Die Branchen hier werden über US-Branchen-ETFs gemessen.']],
    ['heat', 'Wärmekarte', ['Jede Kachel ist eine Aktie. Grün = im Plus, Rot = im Minus. Je kräftiger die Farbe, desto größer die Bewegung. Oben kannst du den Zeitraum wechseln. Aktien mit blauem Rahmen hast du im Depot.']],
    ['signals', 'Auffälligkeiten / Signale', ['Automatisch erkannte Besonderheiten: neue Jahreshochs oder -tiefs, Kreuzungen der 200-Tage-Linie, Golden und Death Cross, extreme RSI-Werte, ungewöhnlich große Tagesbewegungen und ungewöhnlich hohes Handelsvolumen. Sie sind ein Anlass zum Hinschauen, kein Handelssignal.']],
    ['diversify', 'Streuung (Diversifikation)', ['„Nicht alle Eier in einen Korb legen.“ Wer auf viele Firmen, Branchen und Länder verteilt, ist weniger abhängig vom Pech einer einzelnen Firma.']],
    ['sparplan', 'Sparplan und Durchschnittskosten', ['Bei einem Sparplan investierst du jeden Monat den gleichen Betrag. Bei hohen Kursen bekommst du weniger Anteile, bei niedrigen mehr. So musst du nicht den „richtigen Zeitpunkt“ erwischen. Probier es im „Was wäre, wenn“-Rechner jedes Werts aus.']],
    ['crypto', 'Krypto (Bitcoin & Co.)', ['Digitale Währungen ohne Zentralbank. Sehr schwankungsreich: Rückgänge von 50 % und mehr kamen mehrfach vor. Wird rund um die Uhr gehandelt, auch am Wochenende.']],
    ['gold', 'Gold und Rohstoffe', ['Gold gilt als „sicherer Hafen“ in Krisen. Öl zeigt, wie stark die Weltwirtschaft läuft (und beeinflusst Inflation). Kupfer wird „Dr. Copper“ genannt, weil es oft die Konjunktur vorwegnimmt.']],
  ];
  function renderLex() {
    const box = $('lexikon'); box.textContent = ''; const q = ($('lx-q').value || '').toLowerCase();
    LX.filter(([, t, ps, eg]) => !q || (t + ' ' + ps.join(' ') + ' ' + (eg || '')).toLowerCase().includes(q)).forEach(([id, t, ps, eg]) => {
      const d = el('details', 'lx'); d.id = 'lx-' + id; d.append(el('summary', '', t)); const b = el('div'); ps.forEach((p) => b.append(el('p', '', p))); if (eg) b.append(el('p', 'eg', eg)); d.append(b); box.append(d);
    });
  }
  $('lx-q').addEventListener('input', renderLex);
  // Erklär-Knöpfe „?“
  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.help');
    if (!b) { if (popEl && !e.target.closest('.pop')) closePop(); return; }
    e.stopPropagation(); closePop();
    const entry = LX.find((x) => x[0] === b.dataset.help); if (!entry) return;
    popEl = el('div', 'pop'); popEl.append(el('b', '', entry[1])); entry[2].forEach((p) => popEl.append(el('p', '', p)));
    const more = el('a', '', 'Im Lexikon öffnen'); more.href = '#'; more.onclick = (ev) => { ev.preventDefault(); closePop(); closeDetail(); switchTab('lexikon'); const d = $('lx-' + entry[0]); if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); } }; popEl.append(more);
    document.body.append(popEl);
    const r = b.getBoundingClientRect(); const w = popEl.offsetWidth;
    popEl.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left - w / 2)) + 'px';
    const top = r.bottom + 8; popEl.style.top = (top + popEl.offsetHeight > window.innerHeight - 10 ? Math.max(10, r.top - popEl.offsetHeight - 8) : top) + 'px';
  }, true);

  // ---------- Reiter ----------
  function switchTab(t) {
    ui.tab = t; saveUi();
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + t; });
    if (t === 'vergleich' && M) renderCmp();
    if (t === 'lexikon') renderLex();
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
  document.querySelectorAll('#heat-seg button').forEach((b) => { b.onclick = () => { ui.heat = b.dataset.p; saveUi(); renderHeat(); renderMovers(); }; });
  $('q').addEventListener('input', () => { ui.q = $('q').value; renderList(); });
  $('sort').value = ui.sort; $('sort').onchange = () => { ui.sort = $('sort').value; saveUi(); renderList(); };
  $('col').value = ui.col; $('col').onchange = () => { ui.col = $('col').value; saveUi(); renderList(); };
  $('btn-reload').onclick = () => load(true);

  // ---------- Start ----------
  switchTab(['heute', 'werte', 'vergleich', 'alarme', 'ki', 'lexikon'].includes(ui.tab) ? ui.tab : 'heute');
  load(false).then(() => { const m = location.hash.match(/^#wert=(.+)$/); if (m && byId[decodeURIComponent(m[1])]) { history.replaceState(null, '', location.pathname); openDetail(decodeURIComponent(m[1])); } });
  setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 5 * 60 * 1000);
  setInterval(() => { if (M) setStatus('ok'); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && M && Date.now() - Date.parse(M.generated_at) > 10 * 60 * 1000) load(true); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
})();
