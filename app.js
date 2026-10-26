/* Mein Portfolio: Depot-App mit Claude. Daten bleiben auf dem Gerät (localStorage). */
(function () {
  'use strict';
  const APP_VERSION = '1.2.0';
  const FEED_URL = 'data/feed.json'; // vom Claude-Dashboard veröffentlicht
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELS = {
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 (empfohlen)', inp: 2, out: 10 },
    'claude-haiku-5-5': { label: 'Claude Haiku 5.5 (am günstigsten)', inp: 0.1, out: 0.5 },
    'claude-opus-5-5': { label: 'Claude Opus 5.5 (am stärksten, teurer)', inp: 4, out: 20 },
  };
  const SEARCH_USD = 0.01; // 10 $ je 1.000 Suchen
  const K_DATA = 'pf.data.v1', K_KEY = 'pf.key', K_UI = 'pf.ui';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfQ = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 5 });
  const nfP = (v) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: v < 20 ? 3 : 2 }).format(v);
  const TZ = { timeZone: 'Europe/Berlin' };
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const pct = (v) => (v == null || !isFinite(v) ? 'k. A.' : (v > 0 ? '+' : '') + nf2.format(v) + ' %');
  const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('de-DE', { ...TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[\s €$%+]/g, ''); if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : null; };
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const link = (url, txt, cls) => { const u = safeUrl(url); if (!u) return el('span', cls || '', txt); const a = el('a', cls || '', txt); a.href = u; a.target = '_blank'; a.rel = 'noopener'; return a; };
  const slug = (s) => String(s || 'pos').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pos';

  // ---------- Speicher ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const emptyData = () => ({ version: 1, positions: [], quotes: {}, quotes_at: null, news: null, calendar: null, chat: [], last_cost: null, feed_at: null });
  let data = Object.assign(emptyData(), store.get(K_DATA, {}));
  let ui = Object.assign({ hide: false, view: 'depot', model: 'claude-sonnet-5-5' }, store.get(K_UI, {}));
  if (!MODELS[ui.model]) ui.model = 'claude-sonnet-5-5';
  const save = () => { if (!store.set(K_DATA, data)) toast('Speichern auf diesem Gerät nicht möglich.'); };
  const saveUi = () => store.set(K_UI, ui);
  const getKey = () => { try { return localStorage.getItem(K_KEY) || ''; } catch (_) { return ''; } };

  // ---------- Berechnung ----------
  function calc() {
    const rows = data.positions.map((p) => {
      const q = data.quotes[p.id] || {};
      const qty = Number(p.qty) || 0, price = num(q.eur_price);
      const value = price != null ? Math.round(qty * price * 100) / 100 : null;
      let d1 = num(q.change_pct);
      const prevPrice = num(q.prev_eur);
      if (d1 == null && price != null && prevPrice) d1 = (price / prevPrice - 1) * 100;
      const prev = value != null && d1 != null ? value / (1 + d1 / 100) : null;
      const cost = num(p.cost_eur);
      const pl = value != null && cost > 0 ? value - cost : null;
      const d5 = num(q.d5);
      return { p, q, qty, price, value, d1, d5, prev, cost, pl, plp: pl != null ? pl / cost * 100 : null };
    }).sort((a, b) => (b.value || 0) - (a.value || 0));
    const priced = rows.filter((r) => r.value != null);
    const total = priced.reduce((s, r) => s + r.value, 0);
    const withPrev = priced.filter((r) => r.prev != null);
    const tNow = withPrev.reduce((s, r) => s + r.value, 0), tPrev = withPrev.reduce((s, r) => s + r.prev, 0);
    const withCost = priced.filter((r) => r.cost > 0);
    const cost = withCost.reduce((s, r) => s + r.cost, 0), vC = withCost.reduce((s, r) => s + r.value, 0);
    const with5 = priced.filter((r) => r.d5 != null);
    const n5 = with5.reduce((s, r) => s + r.value, 0), b5 = with5.reduce((s, r) => s + r.value / (1 + r.d5 / 100), 0);
    return { rows, priced, total, d1: tPrev ? (tNow / tPrev - 1) * 100 : null, dayEur: tNow - tPrev, cost, pl: withCost.length ? vC - cost : null,
      d5: b5 ? (n5 / b5 - 1) * 100 : null, d5Eur: n5 - b5, miss5: priced.filter((r) => r.d5 == null).map((r) => r.p.name),
      plp: withCost.length && cost ? (vC - cost) / cost * 100 : null, missingPrice: rows.filter((r) => r.value == null) };
  }
  const money = (v, signed) => (ui.hide ? '• • • •' : v == null ? 'k. A.' : (signed && v > 0 ? '+' : '') + nf2.format(v) + ' €');

  // ---------- Darstellung ----------
  const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
  let busy = null; // 'quotes' | 'news' | 'chat'

  function renderHeader() {
    const c = calc();
    const hb = $('btn-hide'); hb.setAttribute('aria-pressed', ui.hide ? 'true' : 'false');
    hb.innerHTML = (ui.hide ? ICON_EYE_OFF : ICON_EYE) + '<span>' + (ui.hide ? 'Werte anzeigen' : 'Werte ausblenden') + '</span>';
    const rb = $('btn-refresh'); rb.disabled = !!busy; rb.innerHTML = ICON_REFRESH + '<span>' + (busy === 'feed' || busy === 'quotes' ? 'Lädt' : 'Aktualisieren') + '</span>';
    const cb = $('btn-claude-quotes'); if (cb) { cb.disabled = !!busy; cb.textContent = busy === 'quotes' ? 'Claude sucht …' : 'Selbst mit Claude suchen'; }
    $('k-val').textContent = c.priced.length ? money(c.total) : '–';
    $('k-val-sub').textContent = c.priced.length ? c.priced.length + ' Positionen' + (c.missingPrice.length ? ', ' + c.missingPrice.length + ' ohne Kurs' : '') : 'noch keine Kurse';
    const kp = $('k-pl'); kp.textContent = c.plp != null ? pct(c.plp) : '–'; kp.className = 'val ' + tone(c.plp);
    $('k-pl-sub').textContent = c.pl != null ? money(c.pl, true) : 'Kaufpreise fehlen';
    const kd = $('k-d1'); kd.textContent = c.d1 != null ? pct(c.d1) : '–'; kd.className = 'val ' + tone(c.d1);
    $('k-d1-sub').textContent = c.d1 != null ? money(c.dayEur, true) : ' ';
    const k5 = $('k-d5'); k5.textContent = c.d5 != null ? pct(c.d5) : '–'; k5.className = 'val ' + tone(c.d5);
    $('k-d5-sub').textContent = c.d5 == null ? 'kommt mit nächster Aktualisierung' : c.miss5.length ? 'ohne ' + c.miss5.map(shortName).join(', ') : money(c.d5Eur, true);
    const ev = upcoming()[0];
    $('k-next').textContent = ev ? eventTitle(ev) : '–';
    $('k-next-sub').textContent = ev ? eventWhen(ev) : (data.calendar ? 'keine Termine in den nächsten Wochen' : 'kommt mit nächster Aktualisierung');
  }

  // ---------- Termine ----------
  const shortName = (n) => String(n || '').replace(/^Vanguard FTSE /, 'Vanguard ').replace(/ (UCITS|ETF|Inc\.|Oyj|AG|PLC|Group|International|Corp\.).*$/, '');
  const berlinToday = () => new Date().toLocaleDateString('sv-SE', TZ);
  function upcoming() {
    const today = berlinToday();
    const nowHM = new Date().toLocaleTimeString('de-DE', { ...TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    return [...(data.calendar?.events || [])].filter((e) => e && (e.date > today || (e.date === today && !(e.time && e.time < nowHM))))
      .sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  }
  function eventTitle(e) {
    const p = e.holding && data.positions.find((x) => x.id === e.holding);
    const t = e.title || 'Termin', n = p ? shortName(p.name) : '';
    return (n && !t.toLowerCase().startsWith(n.toLowerCase()) ? n + ': ' : '') + t + (e.confirmed === false ? ' *' : '');
  }
  function eventWhen(e) {
    const d = new Date(e.date + 'T12:00:00');
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + (e.time ? ', ' + e.time + ' Uhr' : '');
  }

  function setStatus(text, state) {
    $('st-text').textContent = text;
    $('st-dot').className = 'dot' + (state ? ' ' + state : '');
  }
  function idleStatus() {
    const parts = [];
    parts.push(data.quotes_at ? 'Kurse ' + fmtTime(data.quotes_at) : 'Noch keine Kurse');
    if (data.feed_at) parts.push('Dashboard ' + fmtTime(data.feed_at));
    if (data.news?.generated_at) parts.push('News ' + fmtTime(data.news.generated_at));
    if (data.last_cost != null) parts.push('zuletzt ca. ' + data.last_cost.toFixed(2).replace('.', ',') + ' $');
    setStatus(parts.join(' · '), data.quotes_at ? 'live' : '');
  }

  function renderDepot() {
    const list = $('pos-list'); list.replaceChildren(); $('pos-total').replaceChildren();
    const c = calc();
    if (!c.rows.length) {
      const li = el('li'); const box = el('div', 'empty');
      box.append(el('b', '', 'Noch keine Positionen'), el('span', '', 'Importiere deine Datei portfolio.json unter Einstellungen oder füge eine Position hinzu.'));
      const b1 = el('button', 'btn primary', 'Zu den Einstellungen'); b1.type = 'button'; b1.onclick = () => show('settings');
      const b2 = el('button', 'btn', '+ Position'); b2.type = 'button'; b2.onclick = () => openPos(null);
      const act = el('div', 'actions'); act.append(b1, b2); box.append(act); li.append(box); list.append(li); return;
    }
    c.rows.forEach((r) => {
      const li = el('li'); const b = el('button', 'row'); b.type = 'button';
      b.setAttribute('aria-label', r.p.name + ' bearbeiten');
      b.append(el('span', 'nm', r.p.name), el('span', 'val', money(r.value)));
      b.append(el('span', 'l2', (ui.hide ? '• Stk' : nfQ.format(r.qty) + ' Stk') + ' · ' + (r.price != null ? nfP(r.price) + ' €' : 'kein Kurs')));
      const r2 = el('span', 'r2 ' + tone(r.pl)); r2.textContent = r.pl != null ? (ui.hide ? '' : money(r.pl, true) + '  ') + pct(r.plp) : 'Kaufpreis fehlt'; b.append(r2);
      const l3 = el('span', 'l3');
      l3.append(el('span', 'chip ' + tone(r.d1), '1T ' + pct(r.d1)));
      if (r.q.venue) l3.append(el('span', '', r.q.venue));
      if (r.q.as_of) l3.append(el('span', '', fmtTime(r.q.as_of)));
      if (r.q.warn) l3.append(el('span', 'chip warn', 'prüfen'));
      b.append(l3);
      b.onclick = () => openPos(r.p.id);
      li.append(b); list.append(li);
    });
    const t = el('div', 'total');
    t.append(el('span', 'nm', 'Gesamt'), el('span', 'val', money(c.total)));
    t.append(el('span', 'l2 mut', 'Kaufpreis ' + money(c.cost || null)));
    const r2 = el('span', 'r2 ' + tone(c.pl)); r2.textContent = c.pl != null ? (ui.hide ? '' : money(c.pl, true) + '  ') + pct(c.plp) : ''; t.append(r2);
    const l3 = el('span', 'l2 mut'); l3.textContent = 'Heute ' + pct(c.d1) + (c.d1 != null && !ui.hide ? ' (' + money(c.dayEur, true) + ')' : ''); l3.style.gridColumn = '1 / -1'; t.append(l3);
    $('pos-total').append(t);
  }

  function renderNews() {
    const box = $('news-body'); box.replaceChildren();
    const btn = $('btn-news'); btn.disabled = !!busy; btn.textContent = busy === 'news' ? 'Claude sucht …' : 'Selbst mit Claude suchen';
    const evs = upcoming();
    if (evs.length) {
      const g = el('div', 'group'); g.id = 'termine'; g.append(el('h3', '', 'Nächste Termine'));
      const ul = el('ul', 'news');
      evs.slice(0, 8).forEach((e) => {
        const li = el('li'); const w = el('div', 'when');
        w.append(el('span', '', eventWhen(e)));
        const kind = { zins: 'Zins', makro: 'Makro', earnings: 'Zahlen', ir: 'IR' }[e.type];
        if (kind) w.append(el('span', 'chip' + (e.type === 'earnings' ? ' up' : ''), kind));
        li.append(w, link(e.url, eventTitle(e), 'h'));
        if (e.note) li.append(el('p', '', e.note));
        ul.append(li);
      });
      g.append(ul);
      if (evs.some((e) => e.confirmed === false)) g.append(el('p', 'note', '* vorläufig oder Uhrzeit offen'));
      box.append(g);
    }
    const n = data.news;
    if (!n) { const e = el('div', 'empty'); e.append(el('b', '', 'Noch keine News'), el('span', '', 'Die News kommen automatisch vom Claude-Dashboard, meist werktags ab 7:30 Uhr. Mit „Selbst mit Claude suchen“ holst du sie sofort, das kostet etwa 0,20 bis 0,50 $ API-Guthaben.')); box.append(e); return; }
    const sec = (title, items) => {
      if (!items || !items.length) return;
      const g = el('div', 'group'); g.append(el('h3', '', title));
      const ul = el('ul', 'news');
      [...items].sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''))).forEach((it) => {
        const li = el('li'); const w = el('div', 'when');
        if (it.published_at) w.append(el('span', '', fmtTime(it.published_at) || it.published_at));
        if (it.source) w.append(el('span', '', it.source));
        if (it.kind === 'analyst') w.append(el('span', 'chip', 'Analyst'));
        if (it.rating) w.append(el('span', 'chip ' + (/(buy|kauf|overweight|outperform)/i.test(it.rating) ? 'up' : /(sell|verkauf|underweight|underperform)/i.test(it.rating) ? 'down' : ''), it.rating + (it.target ? ' · ' + it.target : '')));
        li.append(w, link(it.url, it.headline || 'Meldung', 'h'));
        if (it.summary) li.append(el('p', '', it.summary));
        ul.append(li);
      });
      g.append(ul); box.append(g);
    };
    box.append(el('p', 'note', 'Stand ' + fmtTime(n.generated_at) + (n.by === 'feed' ? ', vom Claude-Dashboard' : '') + '. Zusammenfassungen von Claude, Links zu den Quellen.'));
    sec('Markt', n.market);
    const byId = Object.fromEntries(data.positions.map((p) => [p.id, p.name]));
    (n.positions || []).forEach((g) => sec(byId[g.id] || g.name || g.id, g.items));
  }

  // Einfache, sichere Formatierung für Claude-Antworten
  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
    const inline = (parent, s) => {
      const re = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https:\/\/[^\s)]+\)|https:\/\/[^\s)]+)/g; let last = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > last) parent.append(document.createTextNode(s.slice(last, m.index)));
        const t = m[0];
        if (t.startsWith('**')) parent.append(el('b', '', t.slice(2, -2)));
        else if (t.startsWith('[')) { const mm = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(t); parent.append(link(mm[2], mm[1])); }
        else parent.append(link(t, t));
        last = m.index + t.length;
      }
      if (last < s.length) parent.append(document.createTextNode(s.slice(last)));
    };
    blocks.forEach((b) => {
      const lines = b.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) return;
      if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
        const ul = el('ul'); lines.forEach((l) => { const li = el('li'); inline(li, l.replace(/^\s*([-*•]|\d+\.)\s+/, '')); ul.append(li); }); frag.append(ul);
      } else {
        const p = el('p'); lines.forEach((l, i) => { if (i) p.append(el('br')); inline(p, l.replace(/^#+\s*/, '')); }); frag.append(p);
      }
    });
    return frag;
  }

  function renderChat() {
    const list = $('chat-list'); list.replaceChildren();
    if (!data.chat.length) {
      const m = el('div', 'msg ai'); m.append(renderMarkdown('Hallo! Frag mich etwas zu deinem Depot, zum Beispiel wie eine Aktie diese Woche lief oder was hinter einer Kursbewegung steckt. Ich kenne deine Positionen, Kaufpreise und die zuletzt geholten Kurse und News.'));
      list.append(m);
    }
    data.chat.forEach((c) => {
      const m = el('div', 'msg ' + (c.role === 'user' ? 'me' : 'ai'));
      if (c.role === 'user') m.textContent = c.text; else m.append(renderMarkdown(c.text));
      if (c.sources && c.sources.length) {
        const s = el('div', 'src'); s.append(el('span', '', 'Quellen'));
        c.sources.slice(0, 6).forEach((x) => s.append(link(x.url, x.title || x.url)));
        m.append(s);
      }
      if (c.cost != null) m.append(el('div', 'cost', 'ca. ' + c.cost.toFixed(3).replace('.', ',') + ' $'));
      list.append(m);
    });
    if (busy === 'chat') { const m = el('div', 'msg ai mut', 'Claude denkt nach …'); m.id = 'chat-wait'; list.append(m); }
    const sg = $('chat-suggest'); sg.replaceChildren();
    if (!data.chat.length) ['Wie lief mein Depot diese Woche?', 'Warum ist Nokia so gefallen?', 'Welche Termine stehen bei meinen Aktien an?'].forEach((q) => {
      const b = el('button', '', q); b.type = 'button'; b.onclick = () => { $('chat-input').value = q; sendChat(); }; sg.append(b);
    });
    $('chat-send').disabled = !!busy;
    if (ui.view === 'chat') requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
  }

  function renderSettings() {
    const sel = $('set-model'); if (!sel.options.length) Object.entries(MODELS).forEach(([k, m]) => { const o = el('option', '', m.label); o.value = k; sel.append(o); });
    sel.value = ui.model;
    const m = MODELS[ui.model]; $('model-hint').textContent = 'Preis je 1 Mio. Token: ' + nf2.format(m.inp) + ' $ Eingabe, ' + nf2.format(m.out) + ' $ Ausgabe, dazu 0,01 $ je Websuche.';
    const k = getKey(); $('key-state').textContent = k ? 'Schlüssel gespeichert (endet auf …' + k.slice(-4) + ').' : 'Noch kein Schlüssel gespeichert. Kurse und News kommen trotzdem automatisch vom Claude-Dashboard. Den Schlüssel brauchst du nur für den Chat und für „Selbst mit Claude suchen“.';
    $('app-version').textContent = 'Version ' + APP_VERSION + '. Deine Daten liegen nur auf diesem Gerät.';
  }

  function render() { renderHeader(); renderDepot(); renderNews(); renderChat(); renderSettings(); if (!busy) idleStatus(); }

  function show(view) {
    ui.view = view; saveUi();
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === view ? 'true' : 'false'));
    window.scrollTo({ top: 0 });
    if (view === 'chat') renderChat();
  }

  let toastTimer;
  function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { e.hidden = true; }, 3500); }
  function banner(text, err) { const b = $('banner'); if (!text) { b.hidden = true; return; } b.className = 'banner' + (err ? ' err' : ''); b.textContent = text; b.hidden = false; }

  // ---------- Claude ----------
  function apiError(status, body) {
    const msg = body?.error?.message || '';
    if (/credit balance/i.test(msg)) return 'Kein API-Guthaben mehr. In der Claude Console aufladen oder auf das monatliche Guthaben warten.';
    if (status === 401) return 'Der API-Schlüssel ist ungültig. Prüfe ihn unter Einstellungen.';
    if (status === 403) return 'Der Schlüssel hat keine Berechtigung für diese Anfrage (' + (msg || 'gesperrt') + ').';
    if (status === 429) return 'Zu viele Anfragen in kurzer Zeit. Warte eine Minute und versuche es noch einmal.';
    if (status === 529 || status === 503) return 'Claude ist gerade überlastet. Versuche es in ein paar Minuten noch einmal.';
    return 'Fehler von Claude (' + status + '): ' + (msg || 'unbekannt');
  }

  async function callClaude({ system, prompt, history, maxSearch, maxTokens, onStep }) {
    const key = getKey();
    if (!key) throw new Error('Kein API-Schlüssel gespeichert. Trag ihn unter Einstellungen ein.');
    const model = ui.model;
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearch,
      user_location: { type: 'approximate', country: 'DE', timezone: 'Europe/Berlin' } }];
    let messages = [...(history || []), { role: 'user', content: prompt }];
    const usage = { inp: 0, out: 0, search: 0 }; const content = [];
    for (let step = 0; step < 6; step++) {
      let res;
      try {
        res = await fetch(API_URL, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }) });
      } catch (e) { throw new Error('Keine Verbindung zu Claude. Bist du online?'); }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(apiError(res.status, body));
      const u = body.usage || {};
      usage.inp += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      usage.out += u.output_tokens || 0; usage.search += u.server_tool_use?.web_search_requests || 0;
      content.push(...(body.content || []));
      onStep && onStep(step + 1, content.filter((b) => b.type === 'server_tool_use').length);
      if (body.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: body.content }]; continue; }
      break;
    }
    const m = MODELS[model];
    const cost = usage.inp / 1e6 * m.inp + usage.out / 1e6 * m.out + usage.search * SEARCH_USD;
    const texts = content.filter((b) => b.type === 'text');
    const text = texts.map((b) => b.text).join('');
    const sources = []; const seen = new Set();
    texts.forEach((b) => (b.citations || []).forEach((c) => { if (c.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ url: c.url, title: c.title }); } }));
    return { text, sources, cost, usage };
  }

  function extractJson(text) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/g; let m, last = null;
    while ((m = fence.exec(text))) last = m[1];
    const cand = last || (text.includes('{') ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : '');
    try { return JSON.parse(cand); } catch (_) { throw new Error('Claude hat keine lesbaren Daten geliefert. Versuche es noch einmal.'); }
  }
  const nowText = () => new Date().toLocaleString('de-DE', { ...TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const posList = () => data.positions.map((p) => ({ id: p.id, name: p.name, isin: p.isin || null, wkn: p.wkn || null, art: p.type || 'aktie' }));

  // ---------- Daten vom Claude-Dashboard (kostenlos, data/feed.json im selben Repository) ----------
  const tms = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
  let lastFeedCheck = 0;
  async function loadFeed(manual) {
    if (busy) return;
    lastFeedCheck = Date.now();
    if (manual) { busy = 'feed'; renderHeader(); setStatus('Lade Daten vom Dashboard …', 'run'); }
    try {
      let res;
      try { res = await fetch(FEED_URL + '?t=' + Date.now(), { cache: 'no-store' }); } catch (_) { throw new Error('offline'); }
      if (!res.ok) throw new Error('nofeed');
      const f = await res.json();
      if (!f || typeof f.quotes !== 'object') throw new Error('nofeed');
      const byIsin = {}; Object.entries(f.quotes).forEach(([k, q]) => { if (q && q.isin) byIsin[q.isin] = k; });
      let n = 0;
      data.positions.forEach((p) => {
        const key = f.quotes[p.id] ? p.id : byIsin[p.isin]; const q = key && f.quotes[key];
        if (!q || !(num(q.eur_price) > 0)) return;
        const old = data.quotes[p.id];
        if (old && old.by !== 'feed' && tms(old.as_of) > tms(q.as_of)) return; // eigener, neuerer Kurs bleibt
        const same = old && old.by === 'feed' && tms(old.as_of) >= tms(q.as_of) && num(old.eur_price) === num(q.eur_price);
        data.quotes[p.id] = { eur_price: num(q.eur_price), prev_eur: num(q.prev_eur), change_pct: num(q.change_pct), d5: num(q.d5), venue: q.venue || 'Dashboard',
          as_of: q.as_of || f.quotes_at, source: q.source || null, url: safeUrl(q.url), warn: false, by: 'feed' };
        if (!same) n++;
      });
      if (n) data.quotes_at = f.quotes_at || f.generated_at;
      if (f.news && tms(f.news.generated_at) > tms(data.news?.generated_at)) {
        const idMap = {}; data.positions.forEach((p) => { idMap[p.id] = p.id; if (p.isin) Object.entries(f.quotes).forEach(([k, q]) => { if (q.isin === p.isin) idMap[k] = p.id; }); });
        const clean = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && x.headline).map((x) => ({ ...x, url: safeUrl(x.url) }));
        data.news = { generated_at: f.news.generated_at, by: 'feed', market: clean(f.news.market),
          positions: (f.news.positions || []).filter((g) => idMap[g.id]).map((g) => ({ id: idMap[g.id], items: clean(g.items) })) };
      }
      if (f.calendar && Array.isArray(f.calendar.events)) data.calendar = { generated_at: f.calendar.generated_at || f.generated_at, events: f.calendar.events.map((e) => ({ ...e, url: safeUrl(e.url) })) };
      data.feed_at = f.generated_at || null; save();
      if (manual) toast(n ? n + ' Kurse vom Dashboard übernommen' : 'Schon aktuell. Das Dashboard aktualisiert werktags um 12:45, 17:45 und 22:45 Uhr.');
    } catch (e) {
      if (manual) toast(e.message === 'offline' ? 'Keine Verbindung. Es bleibt der letzte Stand.' : 'Noch keine Daten vom Dashboard gefunden.');
    } finally { if (busy === 'feed') busy = null; render(); }
  }

  async function refreshQuotes() {
    if (busy) return;
    if (!data.positions.length) { toast('Erst Positionen anlegen oder importieren.'); return; }
    busy = 'quotes'; banner(''); renderHeader(); renderNews(); renderChat();
    const t0 = Date.now(); const tick = setInterval(() => setStatus('Claude sucht Kurse … ' + Math.round((Date.now() - t0) / 1000) + ' s', 'run'), 1000);
    setStatus('Claude sucht Kurse …', 'run');
    try {
      const system = 'Du holst aktuelle Kurse für ein privates Depot bei einer deutschen Bank und antwortest am Ende nur mit einem JSON-Block.\n' +
        'Regeln:\n- Nutze die Websuche. Übernimm nur Zahlen, die auf gefundenen Seiten stehen. Nichts schätzen, nichts aus dem Gedächtnis. Fehlt ein Wert, setze null.\n' +
        '- eur_price: letzter Kurs in Euro an einem deutschen Börsenplatz, so wie die Bank das Depot bewertet. Bevorzugt Tradegate, sonst Lang & Schwarz, gettex oder Stuttgart. Bei Fonds der Kurs in München oder gettex, sonst der Rücknahmepreis.\n' +
        '- prev_eur: Schlusskurs des vorherigen Handelstags am selben Börsenplatz. change_pct: Tagesveränderung in Prozent am selben Platz. d5: Veränderung in Prozent über 1 Woche bzw. 5 Handelstage, nur wenn auf der Seite angegeben.\n' +
        '- venue: Börsenplatz. as_of: Zeitpunkt des Kurses als ISO 8601 mit Offset in deutscher Zeit. source und url: die Seite, auf der der Kurs steht.\n' +
        '- Halte dich kurz, keine Erklärungen außerhalb des JSON.\n' +
        'Format: ```json {"quotes":[{"id":"...","eur_price":0,"prev_eur":0,"change_pct":0,"d5":0,"venue":"","as_of":"","source":"","url":""}],"hinweis":""} ```';
      const prompt = 'Jetzt ist ' + nowText() + ' (deutsche Zeit). Hole die Kurse für diese Positionen:\n' + JSON.stringify(posList());
      const r = await callClaude({ system, prompt, maxSearch: Math.min(4 + data.positions.length * 2, 20), maxTokens: 4000 });
      const j = extractJson(r.text);
      let n = 0;
      (j.quotes || []).forEach((q) => {
        const p = data.positions.find((x) => x.id === q.id); const price = num(q.eur_price);
        if (!p || !(price > 0)) return;
        const old = data.quotes[p.id]; const oldPrice = num(old?.eur_price);
        const warn = oldPrice ? Math.abs(price / oldPrice - 1) > 0.25 : false;
        data.quotes[p.id] = { eur_price: price, prev_eur: num(q.prev_eur), change_pct: num(q.change_pct), d5: num(q.d5), venue: q.venue || null, as_of: q.as_of || new Date().toISOString(),
          source: q.source || null, url: safeUrl(q.url), warn, by: 'claude' };
        n++;
      });
      data.quotes_at = new Date().toISOString(); data.last_cost = r.cost; save();
      toast(n + ' von ' + data.positions.length + ' Kursen aktualisiert');
      if (n < data.positions.length) banner('Für ' + (data.positions.length - n) + ' Position(en) hat Claude keinen Kurs gefunden. Es bleibt der alte Kurs stehen.' + (j.hinweis ? ' ' + j.hinweis : ''));
    } catch (e) { banner(e.message, true); }
    finally { clearInterval(tick); busy = null; render(); }
  }

  async function refreshNews() {
    if (busy) return;
    const stocks = data.positions.filter((p) => (p.type || 'aktie') === 'aktie');
    if (!data.positions.length) { toast('Erst Positionen anlegen oder importieren.'); return; }
    busy = 'news'; banner(''); renderNews(); renderHeader();
    const t0 = Date.now(); const tick = setInterval(() => setStatus('Claude sucht News … ' + Math.round((Date.now() - t0) / 1000) + ' s', 'run'), 1000);
    setStatus('Claude sucht News …', 'run');
    try {
      const system = 'Du sammelst News für ein privates Depot und antwortest am Ende nur mit einem JSON-Block.\n' +
        'Regeln:\n- Zeitraum: die letzten 5 Tage. Nutze die Websuche, nimm nur Meldungen mit Datum, nichts erfinden.\n' +
        '- Markt: 4 bis 6 wichtige Finanzmarkt-Meldungen. Je Aktie: 2 bis 4 Meldungen, davon wenn vorhanden auch Analystenstimmen (kind "analyst" mit rating und target, z. B. "Buy", "250 USD").\n' +
        '- summary auf Deutsch, in eigenen Worten, ein bis zwei Sätze, keine wörtlichen Zitate.\n' +
        '- Links müssen aus Deutschland erreichbar sein. published_at als ISO 8601 mit Offset.\n' +
        'Format: ```json {"market":[{"headline":"","summary":"","source":"","url":"","published_at":""}],"positions":[{"id":"","items":[{"headline":"","summary":"","source":"","url":"","published_at":"","kind":"news","rating":null,"target":null}]}]} ```';
      const prompt = 'Jetzt ist ' + nowText() + '. Einzelaktien im Depot: ' + JSON.stringify(stocks.map((p) => ({ id: p.id, name: p.name, isin: p.isin }))) +
        '. Fonds und ETFs (nur Markt-News, keine eigenen Meldungen nötig): ' + JSON.stringify(data.positions.filter((p) => !stocks.includes(p)).map((p) => p.name));
      const r = await callClaude({ system, prompt, maxSearch: Math.min(4 + stocks.length * 2, 16), maxTokens: 6000 });
      const j = extractJson(r.text);
      const clean = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && x.headline).map((x) => ({ ...x, url: safeUrl(x.url) }));
      data.news = { generated_at: new Date().toISOString(), market: clean(j.market), positions: (j.positions || []).map((g) => ({ id: g.id, items: clean(g.items) })) };
      data.last_cost = r.cost; save(); toast('News aktualisiert');
    } catch (e) { banner(e.message, true); }
    finally { clearInterval(tick); busy = null; render(); }
  }

  function depotSnapshot() {
    const c = calc();
    return {
      stand_kurse: data.quotes_at, depotwert_eur: Math.round(c.total * 100) / 100, kaufpreis_gesamt_eur: Math.round(c.cost * 100) / 100,
      seit_kauf_eur: c.pl != null ? Math.round(c.pl * 100) / 100 : null, seit_kauf_pct: c.plp != null ? Math.round(c.plp * 100) / 100 : null,
      positionen: c.rows.map((r) => ({ name: r.p.name, isin: r.p.isin, art: r.p.type, stueck: r.qty, kurs_eur: r.price, wert_eur: r.value,
        kaufpreis_gesamt_eur: r.cost, seit_kauf_pct: r.plp != null ? Math.round(r.plp * 100) / 100 : null, tag_pct: r.d1 != null ? Math.round(r.d1 * 100) / 100 : null, boerse: r.q.venue })),
      news: data.news ? { stand: data.news.generated_at, markt: (data.news.market || []).map((x) => x.headline), aktien: (data.news.positions || []).map((g) => ({ id: g.id, titel: g.items.map((x) => x.headline + (x.rating ? ' (' + x.rating + ')' : '')) })) } : null,
    };
  }

  async function sendChat() {
    const inp = $('chat-input'); const q = inp.value.trim();
    if (!q || busy) return;
    busy = 'chat'; inp.value = ''; autoGrow(); banner('');
    const history = data.chat.slice(-16).map((c) => ({ role: c.role, content: c.text }));
    data.chat.push({ role: 'user', text: q, at: new Date().toISOString() }); save(); renderChat(); renderHeader();
    try {
      const system = 'Du bist Claude im Depot-Assistenten dieser App. Antworte auf Deutsch, locker und direkt, meist in wenigen kurzen Absätzen.\n' +
        'Du bist kein Finanzberater: Erkläre Fakten, Zusammenhänge und Abwägungen, aber gib keine verbindlichen Kauf- oder Verkaufsanweisungen.\n' +
        'Für aktuelle Ereignisse nutze die Websuche und nenne die Quelle. Rechne mit den Depotdaten unten und erfinde keine Zahlen.\n' +
        'Jetzt ist ' + nowText() + '.\nDepotdaten (aus der App, nur für diese Antwort):\n' + JSON.stringify(depotSnapshot());
      const r = await callClaude({ system, prompt: q, history, maxSearch: 4, maxTokens: 1500 });
      data.chat.push({ role: 'assistant', text: r.text || 'Ich habe keine Antwort erhalten.', sources: r.sources, cost: r.cost, at: new Date().toISOString() });
      data.chat = data.chat.slice(-40); data.last_cost = r.cost; save();
    } catch (e) {
      data.chat.pop(); inp.value = q; banner(e.message, true);
    } finally { busy = null; render(); }
  }

  // ---------- Positionen bearbeiten ----------
  let editId = null, delArmed = false, delTimer;
  function openPos(id) {
    editId = id; const p = data.positions.find((x) => x.id === id) || { name: '', isin: '', wkn: '', qty: '', cost_eur: '', type: 'aktie' };
    $('dlg-pos-title').textContent = id ? p.name : 'Neue Position';
    $('pf-name').value = p.name || ''; $('pf-isin').value = p.isin || ''; $('pf-wkn').value = p.wkn || '';
    $('pf-qty').value = p.qty ?? ''; $('pf-cost').value = p.cost_eur ?? ''; $('pf-type').value = p.type || 'aktie';
    const q = id ? data.quotes[id] : null; $('pf-price').value = q?.eur_price ?? '';
    $('pos-del').hidden = !id; delArmed = false; $('pos-del').classList.remove('armed'); $('pos-del').textContent = 'Löschen';
    $('dlg-pos').showModal();
  }
  $('pos-close').onclick = () => $('dlg-pos').close();
  $('pos-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('pf-name').value.trim(), qty = num($('pf-qty').value);
    if (!name || !(qty >= 0)) { toast('Name und Stückzahl angeben.'); return; }
    const rec = { name, isin: $('pf-isin').value.trim().toUpperCase() || null, wkn: $('pf-wkn').value.trim().toUpperCase() || null, qty,
      cost_eur: num($('pf-cost').value), type: $('pf-type').value };
    let id = editId;
    if (id) Object.assign(data.positions.find((x) => x.id === id), rec);
    else { id = slug(rec.isin || name); while (data.positions.some((x) => x.id === id)) id += '-2'; data.positions.push({ id, ...rec, added_at: new Date().toISOString() }); }
    const price = num($('pf-price').value), old = data.quotes[id];
    if (price > 0 && num(old?.eur_price) !== price) data.quotes[id] = { eur_price: price, prev_eur: null, change_pct: null, venue: 'manuell', as_of: new Date().toISOString(), by: 'manuell' };
    save(); $('dlg-pos').close(); render(); toast('Gespeichert');
  });
  $('pos-del').onclick = () => {
    if (!delArmed) { delArmed = true; $('pos-del').classList.add('armed'); $('pos-del').textContent = 'Wirklich löschen?'; clearTimeout(delTimer); delTimer = setTimeout(() => { delArmed = false; $('pos-del').classList.remove('armed'); $('pos-del').textContent = 'Löschen'; }, 3000); return; }
    data.positions = data.positions.filter((x) => x.id !== editId); delete data.quotes[editId]; save(); $('dlg-pos').close(); render(); toast('Position gelöscht');
  };

  // ---------- Import und Export ----------
  function importObject(o) {
    if (!o || !Array.isArray(o.positions)) throw new Error('Die Datei enthält keine Positionen.');
    const positions = o.positions.filter((p) => p && p.name).map((p) => ({ id: slug(p.id || p.isin || p.name), name: String(p.name), isin: p.isin || null, wkn: p.wkn || null,
      qty: num(p.qty) || 0, cost_eur: num(p.cost_eur), type: ['aktie', 'etf', 'fonds'].includes(p.type) ? p.type : 'aktie', added_at: p.added_at || new Date().toISOString() }));
    const quotes = {};
    Object.entries(o.quotes || {}).forEach(([k, q]) => { const price = num(q?.eur_price); if (price > 0) quotes[slug(k)] = { ...q, eur_price: price, url: safeUrl(q.url) }; });
    data = Object.assign(emptyData(), { positions, quotes, quotes_at: o.quotes_at || null, news: o.news || null });
    setTimeout(() => loadFeed(false), 50);
    save(); render(); toast(positions.length + ' Positionen importiert'); show('depot');
  }
  $('imp-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try { importObject(JSON.parse(await f.text())); } catch (e) { banner('Import fehlgeschlagen: ' + e.message, true); }
    ev.target.value = '';
  });
  const exportText = () => JSON.stringify({ app: 'mein-portfolio', version: 1, exported_at: new Date().toISOString(), positions: data.positions, quotes: data.quotes, quotes_at: data.quotes_at, news: data.news });
  $('btn-export').onclick = () => { $('exp-text').value = exportText(); $('exp-text').select(); };
  $('btn-copy').onclick = async () => {
    const t = exportText(); $('exp-text').value = t;
    try { await navigator.clipboard.writeText(t); toast('Export kopiert'); } catch (_) { $('exp-text').select(); toast('Text markiert, jetzt kopieren'); }
  };
  $('btn-import-text').onclick = () => {
    const t = $('exp-text').value.trim();
    if (!t) { toast('Füge den Export-Text zuerst in das Feld ein.'); $('exp-text').readOnly = false; $('exp-text').focus(); return; }
    try { importObject(JSON.parse(t)); } catch (e) { banner('Import fehlgeschlagen: ' + e.message, true); }
  };
  $('exp-text').addEventListener('focus', () => { $('exp-text').readOnly = false; });
  let wipeArmed = false;
  $('btn-wipe').onclick = () => {
    if (!wipeArmed) { wipeArmed = true; $('btn-wipe').classList.add('armed'); $('btn-wipe').textContent = 'Wirklich alles löschen?'; setTimeout(() => { wipeArmed = false; $('btn-wipe').classList.remove('armed'); $('btn-wipe').textContent = 'Alle Daten löschen'; }, 3000); return; }
    data = emptyData(); save(); render(); toast('Alle Daten gelöscht');
  };

  // ---------- Einstellungen ----------
  $('btn-save-key').onclick = () => {
    const k = $('set-key').value.trim();
    if (k && !/^sk-ant-/.test(k)) { toast('Ein Claude-Schlüssel beginnt mit sk-ant-'); return; }
    try { if (k) localStorage.setItem(K_KEY, k); } catch (_) { toast('Speichern nicht möglich'); return; }
    $('set-key').value = ''; renderSettings(); toast(k ? 'Schlüssel gespeichert' : 'Keine Änderung');
  };
  $('set-model').onchange = (ev) => { ui.model = ev.target.value; saveUi(); renderSettings(); };
  $('btn-test-key').onclick = async () => {
    const k = getKey(); if (!k) { toast('Erst einen Schlüssel speichern.'); return; }
    $('key-state').textContent = 'Teste Verbindung …';
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'Sag nur: ok' }] }) });
      const body = await res.json().catch(() => null);
      $('key-state').textContent = res.ok ? 'Verbindung klappt. Claude ist bereit.' : apiError(res.status, body);
    } catch (_) { $('key-state').textContent = 'Keine Verbindung zu Claude. Bist du online?'; }
  };

  // ---------- Bedienung ----------
  $('btn-hide').onclick = () => { ui.hide = !ui.hide; saveUi(); render(); };
  $('btn-refresh').onclick = () => loadFeed(true);
  $('btn-claude-quotes').onclick = refreshQuotes;
  $('btn-news').onclick = refreshNews;
  $('btn-add').onclick = () => openPos(null);
  $('k-next-btn').onclick = () => { show('news'); requestAnimationFrame(() => { const t = $('termine'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start' }); }); };
  document.querySelectorAll('nav.tabs button').forEach((b) => { b.onclick = () => show(b.dataset.view); });
  const autoGrow = () => { const t = $('chat-input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
  $('chat-input').addEventListener('input', autoGrow);
  $('chat-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(pointer: fine)').matches) { ev.preventDefault(); sendChat(); } });
  $('chat-form').addEventListener('submit', (ev) => { ev.preventDefault(); sendChat(); });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastFeedCheck > 10 * 60e3) loadFeed(false); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render(); show(ui.view); loadFeed(false);
})();
