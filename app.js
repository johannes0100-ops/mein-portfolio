/* Mein Portfolio: Depot-App im gleichen Aufbau wie das Claude-Dashboard am PC.
   Kurse, News, Termine und Sell-Side kommen kostenlos aus data/feed.json und data/live.json.
   Stück, Kaufpreise, Chat und API-Schlüssel bleiben nur auf diesem Gerät (localStorage). */
(function () {
  'use strict';
  const APP_VERSION = '2.0.0';
  const FEED_URL = 'data/feed.json'; // vom Claude-Dashboard veröffentlicht
  // Live-Kurse (Tradegate-Geldkurs) per GitHub Action. Direkt aus dem Repository, damit sie nicht auf den Seiten-Neubau warten.
  const LIVE_URLS = ['https://raw.githubusercontent.com/johannes0100-ops/mein-portfolio/main/data/live.json', 'data/live.json'];
  // Beim Tippen auf die Knöpfe direkt über die GitHub-API: immer der neueste Stand, ohne die bis zu 10 Minuten Zwischenspeicher der Seite.
  // Nur dann, weil die API ohne Anmeldung etwa 60 Abrufe pro Stunde erlaubt.
  const GH_API = 'https://api.github.com/repos/johannes0100-ops/mein-portfolio/contents/';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELS = {
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 (empfohlen)', inp: 2, out: 10 },
    'claude-haiku-5-5': { label: 'Claude Haiku 5.5 (am günstigsten)', inp: 0.1, out: 0.5 },
    'claude-opus-5-5': { label: 'Claude Opus 5.5 (am stärksten, teurer)', inp: 4, out: 20 },
  };
  const SEARCH_USD = 0.01; // 10 $ je 1.000 Suchen
  const K_DATA = 'pf.data.v1', K_KEY = 'pf.key', K_UI = 'pf.ui';
  const NEWS_IN_APP = ['08:40', '13:40']; // wann neue News vom Dashboard in der App ankommen (Dashboard-Läufe 7:20 und 13:20)

  // ---------- Hilfen ----------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfQty = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 5 });
  const fmtP = (v) => (v == null || isNaN(v) ? 'k. A.' : (v > 0 ? '+' : '') + nf2.format(v) + ' %');
  const fmtPrice = (v) => (v == null ? 'k. A.' : new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: v < 20 ? 3 : 2 }).format(v));
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const TZ = { timeZone: 'Europe/Berlin' };
  const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('de-DE', { ...TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const fmtClock = (d) => new Date(d).toLocaleTimeString('de-DE', { ...TZ, hour: '2-digit', minute: '2-digit' });
  const nfEur = (v) => nf2.format(v) + ' €';
  const signEur = (v) => (v > 0 ? '+' : '') + nfEur(v);
  const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/[\s €$%+]/g, ''); if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : null; };
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const link = (url, txt, cls) => { const u = safeUrl(url); if (!u) return el('span', cls || '', txt); const a = el('a', cls || '', txt); a.href = u; a.target = '_blank'; a.rel = 'noopener'; return a; };
  const slug = (s) => String(s || 'pos').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pos';
  const tms = (s) => { const t = Date.parse(s || ''); return isNaN(t) ? 0 : t; };
  const berlinDate = (iso) => { const d = new Date(iso || ''); return isNaN(d) ? null : d.toLocaleDateString('sv-SE', TZ); };
  const short = (n) => (n || '').replace('Bayerische Motoren Werke AG', 'BMW').replace('Space Exploration Technologies Corp.', 'SpaceX').replace(/^Vanguard FTSE /, 'Vanguard ').replace(/ (Inc\.|Oyj|AG|PLC|Group|International|UCITS).*$/, '').replace('.com', '');
  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

  function nextSlot(times) {
    const now = new Date();
    const wdOf = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(d);
    const hmNow = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    for (let add = 0; add < 8; add++) {
      const d = new Date(now.getTime() + add * 864e5);
      if (['Sat', 'Sun'].includes(wdOf(d))) continue;
      const t = [...times].sort().find((x) => add > 0 || x > hmNow);
      if (!t) continue;
      const day = add === 0 ? '' : add === 1 ? 'morgen ' : new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(d) + ' ';
      return day + t.replace(/^0/, '') + ' Uhr';
    }
    return null;
  }

  // ---------- Speicher ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  };
  const emptyData = () => ({ version: 2, positions: [], quotes: {}, quotes_at: null, news: null, calendar: null, chat: [], last_cost: null, feed_at: null, feed: null, live: null, live_at: null });
  let data = Object.assign(emptyData(), store.get(K_DATA, {}));
  let ui = Object.assign({ hide: false, model: 'claude-sonnet-5-5' }, store.get(K_UI, {}));
  if (!MODELS[ui.model]) ui.model = 'claude-sonnet-5-5';
  const save = () => { if (!store.set(K_DATA, data)) toast('Speichern auf diesem Gerät nicht möglich.'); };
  const saveUi = () => store.set(K_UI, ui);
  const getKey = () => { try { return localStorage.getItem(K_KEY) || ''; } catch (_) { return ''; } };
  let busy = null; // 'feed' | 'quotes' | 'news' | 'chat'

  // ---------- Privatsphäre ----------
  const app = $('app'), pbtn = $('btn-priv');
  const EYE_OPEN = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  const EYE_SHUT = '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
  function setPriv(on) {
    ui.hide = !!on; saveUi();
    app.classList.toggle('priv', ui.hide); pbtn.setAttribute('aria-pressed', ui.hide ? 'true' : 'false');
    $('priv-lab').textContent = ui.hide ? 'Werte anzeigen' : 'Werte ausblenden';
    $('priv-ico').innerHTML = ui.hide ? EYE_SHUT : EYE_OPEN;
    $('priv-note').hidden = !ui.hide;
  }
  pbtn.addEventListener('click', () => setPriv(!ui.hide));

  // ---------- Daten für die Ansicht (gleiche Form wie im Dashboard) ----------
  function feedKeyFor(p) {
    const fq = data.feed?.quotes || {};
    if (fq[p.id]) return p.id;
    if (p.isin) { const k = Object.keys(fq).find((x) => fq[x] && fq[x].isin === p.isin); if (k) return k; }
    return null;
  }
  const feedQuote = (p) => { const k = feedKeyFor(p); return k ? data.feed.quotes[k] : null; };

  function buildState() {
    const holdings = data.positions.map((p) => {
      const f = feedQuote(p) || {};
      const fund = f.fund === true || p.type === 'etf' || p.type === 'fonds';
      return { id: p.id, name: f.name || p.name, isin: p.isin || f.isin, wkn: p.wkn || f.wkn, qty: p.qty, cost_eur: p.cost_eur, added_at: p.added_at || '',
        ticker: f.ticker, exchange: f.exchange, gics: f.gics, gics_sector: f.gics_sector, gics_verified: f.gics_verified, news: fund ? false : undefined };
    });
    const rows = [];
    data.positions.forEach((p) => {
      const q = data.quotes[p.id]; const eur = num(q?.eur_price);
      if (!(eur > 0)) return;
      const f = feedQuote(p) || {};
      const local = num(f.local_price);
      const useLocal = local > 0 && (q.by === 'feed' || q.by === 'live');
      const price = useLocal ? local : eur, fx = useLocal ? eur / local : 1;
      let d1 = num(q.change_pct); const pe = num(q.prev_eur);
      if (d1 == null && pe > 0) d1 = (eur / pe - 1) * 100;
      const prevEur = d1 != null ? eur / (1 + d1 / 100) : eur;
      rows.push({ id: p.id, price, ccy: useLocal ? (f.local_ccy || 'EUR') : 'EUR', fx_eur: fx, prev_close: prevEur / fx, d1,
        d5: num(q.d5 != null ? q.d5 : f.d5), m1: num(f.m1), ytd: num(f.ytd), ytd_basis: f.ytd_basis, y1: num(f.y1),
        spark: useLocal && Array.isArray(f.spark) ? f.spark : [], spark_1y: Array.isArray(f.spark_1y) ? f.spark_1y : [], spark_1y_start: f.spark_1y_start,
        ticker: f.ticker, as_of: berlinDate(q.as_of) });
    });
    const notes = [];
    if (data.live_at) notes.push('Depotwert und Tagesveränderung zum Tradegate-Geldkurs wie im Depot, Stand ' + fmtTime(data.live_at) + '.');
    if (data.feed?.web_at) notes.push('Kurse in Handelswährung und 5T, 1M, YTD vom Claude-Dashboard, Stand ' + fmtTime(data.feed.web_at) + '.');
    const n = data.news;
    let news = null;
    if (n) {
      const analyst = (n.positions || []).flatMap((g) => (g.items || []).filter((x) => x.kind === 'analyst').map((x) => {
        const [broker, ...rest] = String(x.headline || '').split(':');
        return { stock: g.id, broker: broker.trim(), action: rest.join(':').trim(), rating: x.rating, target: x.target, summary: x.summary, source: x.source, url: x.url, published_at: x.published_at };
      }));
      news = { ...n, positions: (n.positions || []).map((g) => ({ id: g.id, items: (g.items || []).filter((x) => x.kind !== 'analyst') })),
        sell_side: Array.isArray(n.sell_side) ? n.sell_side : analyst };
    }
    return { holdings, quotes: { rows, fetched_at: data.quotes_at, source_note: notes.join(' '), errors: data.feed?.errors || [], live_at: data.live_at }, news, cal: data.calendar };
  }
  let state = buildState();

  function render() { state = buildState(); renderStatus(); renderTable(); renderNews(); renderStocks(); renderSellSide(); renderCal(); renderRails(); renderChat(); renderSettings(); }

  function renderStatus() {
    const busyTxt = { feed: 'lade neuesten Stand', quotes: 'Claude sucht Kurse', news: 'Claude sucht News', chat: 'Claude antwortet' }[busy];
    $('st-dot').className = 'dot' + (busy ? ' run' : data.quotes_at ? ' live' : '');
    let t = data.quotes_at ? 'Kurse ' + fmtTime(data.quotes_at) : 'Noch keine Kurse';
    if (data.news?.generated_at) t += ' · News ' + fmtTime(data.news.generated_at);
    if (busyTxt) t += ' · ' + busyTxt + ' …';
    else { const nx = nextSlot(NEWS_IN_APP); t += ' · Kurse alle 15 Minuten' + (nx ? ', neue News ab ' + nx : ''); }
    $('st-text').textContent = t;
    const rb = $('btn-refresh'); rb.disabled = !!busy; rb.textContent = busy === 'feed' ? 'Lädt …' : 'Kurse aktualisieren';
    const nb = $('btn-news'); nb.disabled = !!busy;
    const cq = $('btn-claude-quotes'); cq.disabled = !!busy; cq.textContent = busy === 'quotes' ? 'Claude sucht …' : 'Kurse mit Claude suchen';
    const cn = $('btn-claude-news'); cn.disabled = !!busy; cn.textContent = busy === 'news' ? 'Claude sucht …' : 'News mit Claude suchen';
    renderNewsAt();
  }

  // ---------- Positionen (wie im Dashboard) ----------
  function calcRows() {
    const rowsById = {}; (state.quotes?.rows || []).forEach((r) => { rowsById[r.id] = r; });
    return [...state.holdings].sort((a, b) => (a.added_at || '').localeCompare(b.added_at || '')).map((h) => {
      const r = rowsById[h.id];
      if (!r) return { h, r: null };
      const fx = r.fx_eur ?? 0, qty = Number(h.qty) || 0;
      const sp = r.spark || [];
      const p5 = sp.length >= 6 ? sp[sp.length - 6] : null;
      const value = qty * r.price * fx;
      const v5 = p5 ? qty * p5 * fx : (r.d5 != null ? value / (1 + r.d5 / 100) : null);
      return { h, r, value, prev: qty * r.prev_close * fx, v5 };
    });
  }
  // Gesamtrendite über Positionen mit Wert: aktueller Wert gegen den daraus zurückgerechneten Ausgangswert
  function weighted(rows, key) {
    const use = rows.filter((c) => c.r[key] != null);
    const now = use.reduce((s, c) => s + c.value, 0), base = use.reduce((s, c) => s + c.value / (1 + c.r[key] / 100), 0);
    return { v: base ? (now / base - 1) * 100 : null, miss: rows.filter((c) => c.r[key] == null).map((c) => short(c.h.name)) };
  }
  function plCell(value, cost) {
    const td = el('td', 'pl');
    if (value == null || !(cost > 0)) { td.textContent = 'k. A.'; td.classList.add('mut'); return td; }
    const d = Math.round(value * 100) / 100 - cost, pc = d / cost * 100; // auf Cent gerundet wie im Depot
    if (tone(d)) td.classList.add(tone(d));
    td.append(el('span', 'money', signEur(d)), el('span', 'plp', fmtP(pc)));
    return td;
  }
  const posById = (id) => data.positions.find((p) => p.id === id);

  function renderTable() {
    const tbody = $('tbody'), tfoot = $('tfoot');
    tbody.replaceChildren(); tfoot.replaceChildren();
    const calc = calcRows();
    if (!calc.length) {
      const tr = el('tr'); const td = el('td', 'empty'); td.colSpan = 13; td.style.textAlign = 'left';
      td.textContent = 'Noch keine Positionen. Unten hinzufügen oder in den Einstellungen deine Datei portfolio.json importieren.';
      tr.append(td); tbody.append(tr);
    }
    const priced = calc.filter((c) => c.r);
    const total = priced.reduce((s, c) => s + c.value, 0), totalPrev = priced.reduce((s, c) => s + c.prev, 0);
    const pct = totalPrev ? (total - totalPrev) / totalPrev * 100 : null;
    const w5 = priced.filter((c) => c.v5);
    const now5 = w5.reduce((s, c) => s + c.value, 0), base5 = w5.reduce((s, c) => s + c.v5, 0);
    const pct5 = base5 ? (now5 - base5) / base5 * 100 : null;
    const maxW = Math.max(...priced.map((c) => c.value), 1);

    calc.forEach(({ h, r, value }) => {
      const tr = el('tr', r ? '' : 'pending');
      const nm = el('td', 'nm');
      const ids = [h.wkn && 'WKN ' + h.wkn, h.isin, [h.exchange, r?.ticker || h.ticker, r?.ccy].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      nm.append(el('b', '', h.name), el('span', '', ids));
      tr.append(nm);
      if (r) {
        const d5 = r.spark && r.spark.length >= 6 ? (r.price / r.spark[r.spark.length - 6] - 1) * 100 : r.d5;
        tr.append(el('td', '', fmtPrice(r.price)), el('td', tone(r.d1), fmtP(r.d1)), el('td', tone(d5), fmtP(d5)),
          el('td', 'hide-s ' + tone(r.m1), fmtP(r.m1)), el('td', 'hide-s ' + tone(r.ytd), fmtP(r.ytd) + (r.ytd != null && r.ytd_basis && !r.ytd_basis.startsWith('Schluss') ? '*' : '')));
      } else {
        const td = el('td', 'msg', 'Kurs folgt mit nächster Aktualisierung'); td.colSpan = 5; td.style.textAlign = 'left'; tr.append(td);
      }
      const sec = el('td', 'hide-s sec', (h.gics || (h.news === false ? 'Fonds / ETF' : '')) + (h.gics && h.gics_verified === false ? '*' : ''));
      if (h.gics_sector) sec.title = 'GICS Sektor: ' + h.gics_sector + (h.gics_verified === false ? ' (Zuordnung nicht offiziell verifiziert)' : '');
      tr.append(sec);
      const qtd = el('td', 'money');
      const inp = el('input', 'qty'); inp.type = 'number'; inp.step = 'any'; inp.min = '0'; inp.inputMode = 'decimal'; inp.value = h.qty; inp.id = 'qty-' + h.id;
      inp.setAttribute('aria-label', 'Stückzahl ' + h.name);
      inp.addEventListener('change', () => {
        const v = num(inp.value); const p = posById(h.id);
        if (!(v >= 0) || !p) { inp.value = h.qty; return; }
        p.qty = v; save(); render();
      });
      qtd.append(inp); tr.append(qtd);
      tr.append(el('td', 'money', r ? nf2.format(value) : 'k. A.'));
      const ctd = el('td', 'money hide-s');
      const cin = el('input', 'qty cost'); cin.type = 'number'; cin.step = 'any'; cin.min = '0'; cin.inputMode = 'decimal'; cin.id = 'cost-' + h.id;
      cin.value = h.cost_eur != null ? h.cost_eur : ''; cin.placeholder = '–';
      cin.setAttribute('aria-label', 'Kaufpreis gesamt in Euro ' + h.name);
      cin.addEventListener('change', () => {
        const raw = cin.value.trim(), v = num(raw); const p = posById(h.id);
        if (!p || (raw !== '' && !(v >= 0))) { cin.value = h.cost_eur ?? ''; return; }
        p.cost_eur = raw === '' ? null : v; save(); render();
      });
      ctd.append(cin); tr.append(ctd);
      tr.append(plCell(r ? value : null, Number(h.cost_eur)));
      const wt = el('td', 'hide-s');
      if (r && total) { const w = el('span', 'wbar'); const bar = el('i'); bar.style.width = Math.max(2, value / maxW * 48) + 'px'; w.append(bar, el('span', '', nf2.format(value / total * 100) + ' %')); wt.append(w); }
      tr.append(wt);
      const dtd = el('td'); const del = el('button', 'del', '×'); del.type = 'button'; del.setAttribute('aria-label', 'Entfernen');
      let armed = false, timer;
      del.addEventListener('click', () => {
        if (!armed) { armed = true; del.textContent = 'Löschen?'; del.classList.add('confirm'); timer = setTimeout(() => { armed = false; del.textContent = '×'; del.classList.remove('confirm'); }, 3000); return; }
        clearTimeout(timer);
        data.positions = data.positions.filter((p) => p.id !== h.id); delete data.quotes[h.id]; save(); render(); flash(h.name + ' entfernt.');
      });
      dtd.append(del); tr.append(dtd);
      tbody.append(tr);
    });

    const m1t = weighted(priced, 'm1'), ytdt = weighted(priced, 'ytd');
    const withCost = priced.filter((c) => Number(c.h.cost_eur) > 0);
    const costT = withCost.reduce((s, c) => s + Number(c.h.cost_eur), 0), valC = withCost.reduce((s, c) => s + c.value, 0);
    const qtyT = calc.reduce((s, c) => s + (Number(c.h.qty) || 0), 0);
    if (priced.length) {
      const tr = el('tr');
      const tdm = el('td', 'hide-s ' + tone(m1t.v), fmtP(m1t.v)); if (m1t.miss.length) tdm.title = 'ohne ' + m1t.miss.join(', ');
      const tdy = el('td', 'hide-s ' + tone(ytdt.v), fmtP(ytdt.v)); if (ytdt.miss.length) tdy.title = 'ohne ' + ytdt.miss.join(', ');
      const td5 = el('td', tone(pct5), fmtP(pct5)); const ex5t = priced.filter((c) => !c.v5).map((c) => short(c.h.name)); if (ex5t.length) td5.title = 'ohne ' + ex5t.join(', ');
      const tq = el('td', 'money', nfQty.format(qtyT)); tq.title = 'Summe aller Stück';
      tr.append(el('td', 'nm', 'Gesamt'), el('td', '', ''), el('td', tone(pct), fmtP(pct)), td5, tdm, tdy,
        el('td', 'hide-s sec', calc.length + ' Positionen'), tq, el('td', 'money', nf2.format(total)),
        el('td', 'money hide-s', withCost.length ? nf2.format(costT) : 'k. A.'), plCell(withCost.length ? valC : null, costT),
        el('td', 'hide-s', '100,00 %'), el('td', '', ''));
      tfoot.append(tr);
    }
    const kpl = $('k-pl');
    if (withCost.length) {
      const d = valC - costT;
      kpl.textContent = fmtP(d / costT * 100); kpl.className = 'val ' + tone(d);
      $('k-pl-sub').textContent = signEur(d) + ' · Kaufpreis ' + nfEur(costT) + (withCost.length < priced.length ? ' · ohne ' + priced.filter((c) => !(Number(c.h.cost_eur) > 0)).map((c) => short(c.h.name)).join(', ') : '');
    } else { kpl.textContent = 'k. A.'; kpl.className = 'val'; $('k-pl-sub').textContent = 'Kaufpreise in der Tabelle eintragen'; }
    const kp = $('k-pct'); kp.textContent = priced.length ? fmtP(pct) : 'k. A.'; kp.className = 'val ' + tone(pct);
    const k5 = $('k-5d'); k5.textContent = pct5 != null ? fmtP(pct5) : 'k. A.'; k5.className = 'val ' + tone(pct5);
    $('k-val').textContent = priced.length ? nf2.format(total) : 'k. A.';
    const sess = [...new Set(priced.map((c) => c.r.as_of).filter(Boolean))].sort().at(-1);
    $('k-val-sub').textContent = priced.length ? priced.length + ' Positionen · Session ' + (sess || '').split('-').reverse().join('.') : ' ';
    const ex5 = priced.filter((c) => !c.v5).map((c) => c.h.name);
    $('k-5d-sub').textContent = ex5.length ? 'ohne ' + ex5.join(', ') : '5 Handelstage, lokal';

    const notes = priced.filter((c) => c.r.ytd != null && c.r.ytd_basis && !c.r.ytd_basis.startsWith('Schluss')).map((c) => '* ' + c.h.name + ': YTD ' + c.r.ytd_basis + '.');
    const noHist = priced.filter((c) => c.r.d1 == null).map((c) => c.h.name);
    if (state.holdings.some((h) => h.gics && h.gics_verified === false)) notes.push('* GICS-Industrie aus Sekundärquellen, nicht bei MSCI/S&P verifiziert.');
    if (noHist.length) notes.push(noHist.join(', ') + ': noch ohne Vortageskurs, daher ohne Tagesperformance.');
    if (state.quotes?.source_note) notes.push(state.quotes.source_note);
    $('foot-note').textContent = notes.join(' ');
    const errs = state.quotes?.errors || [];
    $('errs').hidden = !errs.length; $('errs').textContent = errs.map((e) => (e.input || e.id) + ': ' + e.error).join(' · ');
  }

  // ---------- News ----------
  const sortNew = (a, b) => String(b.published_at || '').localeCompare(String(a.published_at || ''));
  function whenEl(s) {
    const w = el('div', 'when');
    if (s.published_at) {
      const d = new Date(s.published_at);
      w.append(el('b', '', d.toLocaleDateString('de-DE', { ...TZ, weekday: 'short', day: '2-digit', month: '2-digit' })));
      w.append(document.createTextNode(d.toLocaleTimeString('de-DE', { ...TZ, hour: '2-digit', minute: '2-digit' }) + ' Uhr'));
    } else w.append(el('b', '', s.label || ''));
    return w;
  }
  function newsItem(s) {
    const li = el('li');
    li.append(whenEl(s));
    const body = el('div');
    body.append(el('h3', '', s.headline || ''));
    if (s.summary) body.append(el('p', '', s.summary));
    const src = el('div', 'src');
    (s.tickers || []).forEach((t) => src.append(el('span', 'tag hold', t)));
    src.append(link(s.url, s.source || 'Quelle'));
    body.append(src); li.append(body);
    return li;
  }
  function listWithMore(items, first, label) {
    const frag = document.createDocumentFragment();
    const ul = el('ul', 'news'); items.slice(0, first).forEach((s) => ul.append(newsItem(s))); frag.append(ul);
    if (items.length > first) {
      const d = el('details', 'more'); const sm = el('summary');
      sm.append(el('span', 'closed', 'Mehr lesen (' + (items.length - first) + ' weitere ' + label + ')'), el('span', 'opened', 'Weniger anzeigen'));
      d.append(sm);
      const ul2 = el('ul', 'news'); items.slice(first).forEach((s) => ul2.append(newsItem(s))); d.append(ul2);
      frag.append(d);
    }
    return frag;
  }
  function renderNewsAt() {
    const n = data.news;
    $('news-at').textContent = n?.generated_at ? 'Stand ' + fmtTime(n.generated_at) + (n.by === 'claude' ? ', selbst gesucht' : '') : '';
  }
  function renderNews() {
    const mk = $('news-market'); mk.replaceChildren();
    renderNewsAt();
    const items = [...(state.news?.market || [])].sort(sortNew);
    if (!items.length) { mk.append(el('div', 'empty', 'Noch keine News geladen.')); return; }
    mk.append(listWithMore(items, 4, 'Meldungen'));
  }

  const NS = 'http://www.w3.org/2000/svg';
  function sparkEl(vals, up) {
    const W = 300, H = 44, p = 3;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Kursverlauf, ' + vals.length + ' Schlusskurse');
    const lo = Math.min(...vals), hi = Math.max(...vals), rng = hi - lo || 1;
    const x = (i) => p + i * (W - 2 * p) / (vals.length - 1), y = (v) => H - p - (v - lo) / rng * (H - 2 * p);
    const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const color = up ? 'var(--up)' : 'var(--down)';
    const area = document.createElementNS(NS, 'polygon'); area.setAttribute('points', `${x(0)},${H} ${pts} ${x(vals.length - 1)},${H}`); area.setAttribute('style', `fill:${color};opacity:.1`);
    const ln = document.createElementNS(NS, 'polyline'); ln.setAttribute('points', pts); ln.setAttribute('vector-effect', 'non-scaling-stroke');
    ln.setAttribute('style', `fill:none;stroke:${color};stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round`);
    svg.append(area, ln);
    return svg;
  }
  function renderStocks() {
    const ps = $('news-pos'); ps.replaceChildren();
    const rowsById = {}; (state.quotes?.rows || []).forEach((r) => { rowsById[r.id] = r; });
    const groups = new Map((state.news?.positions || []).map((g) => [g.id, g]));
    const list = state.holdings.filter((h) => h.news !== false).map((h) => ({ h, r: rowsById[h.id], items: [...(groups.get(h.id)?.items || [])].sort(sortNew) }))
      .sort((a, b) => b.items.length - a.items.length);
    if (!list.length) { const s = el('div', 'stock'); s.append(el('div', 'empty', 'Keine Einzelaktien.')); ps.append(s); return; }
    list.forEach(({ h, r, items }) => {
      const card = el('article', 'stock');
      const head = el('div', 'shead');
      head.append(el('b', '', h.name), el('span', 'chg ' + tone(r?.d1), r ? '1T ' + fmtP(r.d1) : ''));
      card.append(head, el('div', 'sids', [h.wkn && 'WKN ' + h.wkn, h.isin].filter(Boolean).join(' · ')));
      const ys = r?.spark_1y || [];
      if (ys.length >= 5) {
        card.append(sparkEl(ys, ys.at(-1) >= ys[0]));
        const st = r.spark_1y_start ? r.spark_1y_start.split('-').reverse().join('.') : '';
        const full = ys.length >= 240;
        const cap = el('div', 'spark-cap'); cap.append(el('span', '', full ? '1 Jahr' : 'seit ' + st), el('span', tone(r.y1), fmtP(r.y1))); card.append(cap);
      }
      if (!items.length) card.append(el('div', 'empty', 'Keine Meldungen in den letzten 5 Tagen.'));
      else card.append(listWithMore(items, 2, 'Meldungen'));
      ps.append(card);
    });
  }

  function railItem(s) {
    const li = el('li');
    const rw = el('div', 'rw');
    if (s.published_at) { const d = new Date(s.published_at); rw.append(el('span', '', d.toLocaleString('de-DE', { ...TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))); }
    rw.append(el('span', '', s.source || ''));
    if (s.peer) rw.append(el('span', 'tag', s.peer));
    (s.tickers || []).forEach((t) => rw.append(el('span', 'tag hold', t)));
    li.append(rw, link(s.url, s.headline || '', 'h'));
    if (s.summary) { const p = el('p', '', s.summary); p.title = s.summary + (s.popularity ? ' (' + s.popularity + ')' : ''); li.append(p); }
    return li;
  }
  function renderRail(id, items, first) {
    const box = $(id); box.replaceChildren();
    const arr = [...(items || [])].sort(sortNew);
    if (!arr.length) { box.append(el('div', 'empty', 'Keine Meldungen in den letzten 5 Tagen.')); return; }
    const ul = el('ul', 'rail'); arr.slice(0, first).forEach((s) => ul.append(railItem(s))); box.append(ul);
    if (arr.length > first) {
      const d = el('details', 'more'); const sm = el('summary');
      sm.append(el('span', 'closed', 'Mehr lesen (' + (arr.length - first) + ')'), el('span', 'opened', 'Weniger anzeigen'));
      const ul2 = el('ul', 'rail'); arr.slice(first).forEach((s) => ul2.append(railItem(s))); d.append(sm, ul2); box.append(d);
    }
  }
  function renderRails() {
    renderRail('rail-pop', state.news?.popular, 4);
    renderRail('rail-sector', state.news?.sector, 4);
    renderRail('rail-peers', state.news?.peers, 4);
  }

  function ratingTone(t) { const s = (t || '').toLowerCase(); if (/(buy|kauf|overweight|outperform)/.test(s)) return 'pos'; if (/(sell|verkauf|underweight|underperform)/.test(s)) return 'neg'; return ''; }
  function arrow(a) { const s = (a || '').toLowerCase(); if (/(hochstuf|angehoben|upgrade)/.test(s)) return '▲'; if (/(abstuf|gesenkt|downgrade)/.test(s)) return '▼'; return '='; }
  function renderSellSide() {
    const box = $('ss'); box.replaceChildren();
    const names = {}; state.holdings.forEach((h) => { names[h.id] = short(h.name); });
    const items = [...(state.news?.sell_side || [])].sort(sortNew);
    if (!items.length) { box.append(el('div', 'empty', 'Keine Analystenstimmen in den letzten 5 Tagen.')); return; }
    const ul = el('ul', 'ss');
    items.forEach((s) => {
      const li = el('li'); li.title = s.summary || '';
      if (s.summary) {
        li.classList.add('has-why'); li.tabIndex = 0; li.setAttribute('aria-expanded', 'false');
        const flip = () => { const o = li.classList.toggle('open'); li.setAttribute('aria-expanded', o ? 'true' : 'false'); };
        li.addEventListener('click', (ev) => { if (!ev.target.closest('a')) flip(); });
        li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); } });
      }
      const d = s.published_at ? new Date(s.published_at).toLocaleDateString('de-DE', { ...TZ, day: '2-digit', month: '2-digit' }) : '';
      const b = el('span', 'b'); const ar = el('em', arrow(s.action) === '▲' ? 'up' : arrow(s.action) === '▼' ? 'down' : 'mut', arrow(s.action));
      b.append(ar, link(s.url, s.broker || ''));
      const r = el('span', 'r'); if (s.rating) r.append(el('i', ratingTone(s.rating), s.rating)); r.append(document.createTextNode(String(s.target || '').replace(/\s*\(.*\)/, '')));
      li.append(el('span', 'd', d), el('span', 's', names[s.stock] || s.stock), b, r);
      if (s.summary) li.append(el('span', 'why', s.summary));
      ul.append(li);
    });
    box.append(ul);
    box.append(el('p', 'note', '▲ Hochstufung oder Ziel rauf · ▼ runter · = bestätigt. Begründung per Tippen auf die Zeile, Quelle per Tippen auf das Haus.'));
  }

  const TYPE = { zins: 'Zins', makro: 'Makro', earnings: 'Zahlen', ir: 'IR', sonstiges: 'Termin' };
  function renderCal() {
    const box = $('cal'); box.replaceChildren();
    const today = new Date().toLocaleDateString('sv-SE', TZ);
    // Termine von heute, deren Uhrzeit schon vorbei ist, werden ausgeblendet
    const nowHM = new Date().toLocaleTimeString('de-DE', { ...TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    const ev = [...(state.cal?.events || [])].filter((e) => e && e.date && (e.date > today || (e.date === today && !(e.time && e.time < nowHM)))).sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
    const names = {}; state.holdings.forEach((h) => { names[h.id] = short(h.name); });
    const withName = (e) => { const n = e.holding ? names[e.holding] : ''; return (n && !String(e.title || '').toLowerCase().startsWith(n.toLowerCase()) ? n + ': ' : '') + e.title; };
    const nx = ev[0];
    $('k-next').textContent = nx ? withName(nx) + (nx.confirmed === false ? ' *' : '') : 'k. A.';
    $('k-next-sub').textContent = nx ? new Date(nx.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + (nx.time ? ', ' + nx.time + ' Uhr' : '') : ' ';
    if (!ev.length) { box.append(el('div', 'empty', 'Noch keine Termine geladen.')); return; }
    const mkList = (arr) => {
      const ul = el('ul', 'cal'); let wk = '';
      arr.forEach((e) => {
        const d = new Date(e.date + 'T12:00:00');
        const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        const key = mon.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (key !== wk) { wk = key; ul.append(el('li', 'wk', 'Woche ab ' + key)); }
        const li = el('li', e.holding ? 'hold' : '');
        const dd = el('div', 'd'); dd.append(el('b', '', d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })), document.createTextNode(d.toLocaleDateString('de-DE', { weekday: 'short' }) + (e.time ? ' ' + e.time : '')));
        const t = el('div', 't'); t.append(link(e.url, withName(e) + (e.region && !e.holding ? ' (' + e.region + ')' : '') + (e.confirmed === false ? ' *' : '')));
        if (e.note) t.append(el('small', '', e.note));
        li.append(dd, t, el('span', 'k ' + (e.type || ''), TYPE[e.type] || 'Termin'));
        ul.append(li);
      });
      return ul;
    };
    box.append(mkList(ev.slice(0, 8)));
    if (ev.length > 8) {
      const det = el('details', 'more'); const sm = el('summary');
      sm.append(el('span', 'closed', 'Mehr Termine (' + (ev.length - 8) + ')'), el('span', 'opened', 'Weniger anzeigen'));
      det.append(sm, mkList(ev.slice(8))); box.append(det);
    }
    if (ev.some((e) => e.confirmed === false)) box.append(el('p', 'note', '* vorläufig oder Uhrzeit offen'));
  }

  // ---------- Hinweise ----------
  function flash(t) { $('f-msg').textContent = t; setTimeout(() => { if ($('f-msg').textContent === t) $('f-msg').textContent = ''; }, 6000); }
  let toastTimer;
  function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { e.hidden = true; }, 4000); }
  function banner(text, err) { const b = $('banner'); if (!text) { b.hidden = true; return; } b.className = 'banner' + (err ? ' err' : ''); b.textContent = text; b.hidden = false; }

  // ---------- Daten vom Claude-Dashboard (kostenlos) ----------
  let lastFeedCheck = 0;
  async function fetchFresh(path) {
    try {
      const r = await fetch(GH_API + path + '?ref=main&t=' + Date.now(), { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json' } });
      if (r.ok) return await r.json();
    } catch (_) { /* dann über die Seite */ }
    return null;
  }
  async function loadLive(fresh) {
    if (fresh) {
      const j = await fetchFresh('data/live.json');
      if (j && j.quotes && typeof j.quotes === 'object' && j.updated_at) return j;
    }
    for (const u of LIVE_URLS) {
      try {
        const res = await fetch(u + '?t=' + Math.floor(Date.now() / 60e3), { cache: 'no-store' });
        if (!res.ok) continue;
        const j = await res.json();
        if (j && j.quotes && typeof j.quotes === 'object' && j.updated_at) return j;
      } catch (_) { /* nächste Quelle */ }
    }
    return null;
  }
  const cleanItems = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && x.headline).map((x) => ({ ...x, url: safeUrl(x.url) }));

  // Gespeicherten Feed und Live-Kurse auf die eigenen Positionen anwenden (auch ohne Netz nach dem Hinzufügen einer Position)
  function applyFeed(newsFrom) {
    const f = data.feed; if (!f) return;
    const fq = f.quotes || {};
    const idMap = {}; data.positions.forEach((p) => { const k = feedKeyFor(p); if (k) idMap[k] = p.id; });
    let fromFeed = 0;
    data.positions.forEach((p) => {
      const key = feedKeyFor(p); const q = key && fq[key];
      if (!q || !(num(q.eur_price) > 0)) return;
      const old = data.quotes[p.id];
      if (old && old.by !== 'feed' && old.by !== 'live' && tms(old.as_of) > tms(q.as_of)) return; // eigener, neuerer Kurs bleibt
      data.quotes[p.id] = { eur_price: num(q.eur_price), prev_eur: num(q.prev_eur), change_pct: num(q.change_pct), d5: num(q.d5), venue: q.venue || 'Dashboard',
        as_of: q.as_of || f.quotes_at, source: q.source || null, url: safeUrl(q.url), by: 'feed' };
      fromFeed++;
    });
    if (fromFeed) data.quotes_at = f.quotes_at || f.generated_at;
    const live = data.live;
    if (live && live.quotes) {
      let m = 0;
      data.positions.forEach((p) => {
        const L = live.quotes[p.id] || Object.values(live.quotes).find((x) => x && p.isin && x.isin === p.isin);
        if (!L || L.stale || !(num(L.eur) > 0)) return;
        const old = data.quotes[p.id] || {};
        if (old.by && old.by !== 'feed' && old.by !== 'live' && tms(old.as_of) > tms(live.updated_at)) return; // eigener, neuerer Kurs bleibt
        data.quotes[p.id] = { ...old, eur_price: num(L.eur), prev_eur: null, change_pct: num(L.d1), venue: 'Tradegate (Geldkurs)',
          as_of: live.updated_at, source: 'Tradegate', url: 'https://www.tradegate.de/orderbuch.php?isin=' + encodeURIComponent(L.isin || p.isin || ''), by: 'live' };
        m++;
      });
      if (m) { data.live_at = live.updated_at; if (!fromFeed || tms(live.updated_at) > tms(data.quotes_at)) data.quotes_at = live.updated_at; }
    }
    const fn = newsFrom;
    if (fn && (tms(fn.generated_at) > tms(data.news?.generated_at) || (data.news?.by !== 'claude' && tms(fn.generated_at) >= tms(data.news?.generated_at)))) {
      data.news = { generated_at: fn.generated_at, by: 'feed', market: cleanItems(fn.market),
        positions: (fn.positions || []).map((g) => ({ id: idMap[g.id] || g.id, items: cleanItems(g.items) })),
        sell_side: Array.isArray(fn.sell_side) ? fn.sell_side.filter((s) => s && s.broker).map((s) => ({ ...s, stock: idMap[s.stock] || s.stock, url: safeUrl(s.url) })) : undefined,
        popular: cleanItems(fn.popular), sector: cleanItems(fn.sector), peers: cleanItems(fn.peers) };
    }
    data.feed_at = f.generated_at || null;
  }

  async function loadFeed(manual, focus) {
    if (busy) return;
    lastFeedCheck = Date.now();
    if (manual) { busy = 'feed'; renderStatus(); }
    let result = null;
    try {
      let f = manual ? await fetchFresh(FEED_URL) : null;
      if (!f || typeof f.quotes !== 'object') {
        let res;
        try { res = await fetch(FEED_URL + '?t=' + Date.now(), { cache: 'no-store' }); } catch (_) { throw new Error('offline'); }
        if (!res.ok) throw new Error('nofeed');
        f = await res.json();
      }
      if (!f || typeof f.quotes !== 'object') throw new Error('nofeed');
      const live = await loadLive(manual);
      const before = {}; data.positions.forEach((p) => { before[p.id] = num(data.quotes[p.id]?.eur_price); });
      const oldNewsAt = data.news?.generated_at;
      const { news, calendar, ...rest } = f;
      data.feed = rest; if (live) data.live = live;
      if (calendar && Array.isArray(calendar.events)) {
        const idMap = {}; data.positions.forEach((p) => { const k = feedKeyFor(p); if (k) idMap[k] = p.id; });
        data.calendar = { generated_at: calendar.generated_at || f.generated_at, events: calendar.events.map((e) => ({ ...e, holding: e.holding ? (idMap[e.holding] || e.holding) : null, url: safeUrl(e.url) })) };
      }
      applyFeed(news);
      save();
      result = { n: data.positions.filter((p) => num(data.quotes[p.id]?.eur_price) !== before[p.id]).length, newsNew: tms(data.news?.generated_at) > tms(oldNewsAt) };
    } catch (e) {
      if (manual) toast(e.message === 'offline' ? 'Keine Verbindung. Es bleibt der letzte Stand.' : 'Noch keine Daten vom Dashboard gefunden.');
    } finally { if (busy === 'feed') busy = null; render(); }
    if (result && manual) {
      if (focus === 'news') {
        toast(result.newsNew ? 'Neue News vom ' + fmtTime(data.news.generated_at) : 'Die News sind aktuell (Stand ' + fmtTime(data.news?.generated_at) + '). Das Dashboard holt neue um 7:20 und 13:20 Uhr.');
        $('finanzmarkt').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        const parts = [];
        if (result.n) parts.push(result.n + ' Kurse aktualisiert');
        if (result.newsNew) parts.push('neue News vom ' + fmtTime(data.news.generated_at));
        const t = parts.join(', ');
        toast(t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Schon aktuell. Kurse kommen werktags alle 15 Minuten.');
      }
    }
  }

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
  async function callClaude({ system, prompt, history, maxSearch, maxTokens }) {
    const key = getKey();
    if (!key) throw new Error('Kein API-Schlüssel gespeichert. Trag ihn unten in den Einstellungen ein.');
    const model = ui.model;
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearch, user_location: { type: 'approximate', country: 'DE', timezone: 'Europe/Berlin' } }];
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
      if (body.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: body.content }]; continue; }
      break;
    }
    const m = MODELS[model];
    const cost = usage.inp / 1e6 * m.inp + usage.out / 1e6 * m.out + usage.search * SEARCH_USD;
    const texts = content.filter((b) => b.type === 'text');
    const text = texts.map((b) => b.text).join('');
    const sources = []; const seen = new Set();
    texts.forEach((b) => (b.citations || []).forEach((c) => { if (c.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ url: c.url, title: c.title }); } }));
    return { text, sources, cost };
  }
  function extractJson(text) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/g; let m, last = null;
    while ((m = fence.exec(text))) last = m[1];
    const cand = last || (text.includes('{') ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : '');
    try { return JSON.parse(cand); } catch (_) { throw new Error('Claude hat keine lesbaren Daten geliefert. Versuche es noch einmal.'); }
  }
  const nowText = () => new Date().toLocaleString('de-DE', { ...TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const posList = () => data.positions.map((p) => ({ id: p.id, name: p.name, isin: p.isin || null, wkn: p.wkn || null, art: p.type || 'aktie' }));

  async function refreshQuotes() {
    if (busy) return;
    if (!data.positions.length) { toast('Erst Positionen anlegen oder importieren.'); return; }
    busy = 'quotes'; banner(''); renderStatus();
    try {
      const system = 'Du holst aktuelle Kurse für ein privates Depot bei einer deutschen Bank und antwortest am Ende nur mit einem JSON-Block.\n' +
        'Regeln:\n- Nutze die Websuche. Übernimm nur Zahlen, die auf gefundenen Seiten stehen. Nichts schätzen, nichts aus dem Gedächtnis. Fehlt ein Wert, setze null.\n' +
        '- eur_price: aktueller Geldkurs (Bid) in Euro an Tradegate, so bewertet die Bank das Depot. Gibt es keinen, der Geldkurs bei Lang & Schwarz, gettex oder Stuttgart. Bei Fonds ohne Börsenhandel der Rücknahmepreis (NAV) der Fondsgesellschaft.\n' +
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
        data.quotes[p.id] = { eur_price: price, prev_eur: num(q.prev_eur), change_pct: num(q.change_pct), d5: num(q.d5), venue: q.venue || null, as_of: q.as_of || new Date().toISOString(),
          source: q.source || null, url: safeUrl(q.url), by: 'claude' };
        n++;
      });
      data.quotes_at = new Date().toISOString(); data.last_cost = r.cost; save();
      toast(n + ' von ' + data.positions.length + ' Kursen aktualisiert, ca. ' + r.cost.toFixed(2).replace('.', ',') + ' $');
      if (n < data.positions.length) banner('Für ' + (data.positions.length - n) + ' Position(en) hat Claude keinen Kurs gefunden. Es bleibt der alte Kurs stehen.' + (j.hinweis ? ' ' + j.hinweis : ''));
    } catch (e) { banner(e.message, true); }
    finally { busy = null; render(); }
  }

  async function refreshNews() {
    if (busy) return;
    const stocks = data.positions.filter((p) => (p.type || 'aktie') === 'aktie');
    if (!data.positions.length) { toast('Erst Positionen anlegen oder importieren.'); return; }
    busy = 'news'; banner(''); renderStatus();
    try {
      const system = 'Du sammelst News für ein privates Depot und antwortest am Ende nur mit einem JSON-Block.\n' +
        'Regeln:\n- Zeitraum: die letzten 5 Tage. Nutze die Websuche, nimm nur Meldungen mit Datum, nichts erfinden.\n' +
        '- market: 4 bis 6 wichtige Finanzmarkt-Meldungen. positions: je Aktie 2 bis 4 Meldungen. sell_side: Analystenstimmen der letzten 5 Tage (Haus, Aktion wie "Ziel angehoben", Rating, Kursziel mit Währung).\n' +
        '- summary auf Deutsch, in eigenen Worten, ein bis zwei Sätze, keine wörtlichen Zitate.\n' +
        '- Links müssen aus Deutschland erreichbar sein. published_at als ISO 8601 mit Offset.\n' +
        'Format: ```json {"market":[{"headline":"","summary":"","source":"","url":"","published_at":""}],"positions":[{"id":"","items":[{"headline":"","summary":"","source":"","url":"","published_at":""}]}],"sell_side":[{"stock":"","broker":"","action":"","rating":"","target":"","summary":"","source":"","url":"","published_at":""}]} ```';
      const prompt = 'Jetzt ist ' + nowText() + '. Einzelaktien im Depot: ' + JSON.stringify(stocks.map((p) => ({ id: p.id, name: p.name, isin: p.isin }))) +
        '. Fonds und ETFs (nur Markt-News, keine eigenen Meldungen nötig): ' + JSON.stringify(data.positions.filter((p) => !stocks.includes(p)).map((p) => p.name));
      const r = await callClaude({ system, prompt, maxSearch: Math.min(4 + stocks.length * 2, 16), maxTokens: 6000 });
      const j = extractJson(r.text);
      const old = data.news || {};
      data.news = { generated_at: new Date().toISOString(), by: 'claude', market: cleanItems(j.market),
        positions: (j.positions || []).map((g) => ({ id: g.id, items: cleanItems(g.items) })),
        sell_side: (Array.isArray(j.sell_side) ? j.sell_side : []).filter((s) => s && s.broker).map((s) => ({ ...s, url: safeUrl(s.url) })),
        popular: old.popular || [], sector: old.sector || [], peers: old.peers || [] };
      data.last_cost = r.cost; save(); toast('News aktualisiert, ca. ' + r.cost.toFixed(2).replace('.', ',') + ' $');
    } catch (e) { banner(e.message, true); }
    finally { busy = null; render(); }
  }

  // ---------- Claude fragen ----------
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
      const m = el('div', 'cm ai'); m.append(renderMarkdown('Hallo! Frag mich etwas zu deinem Depot, zum Beispiel wie eine Aktie diese Woche lief oder was hinter einer Kursbewegung steckt. Ich kenne deine Positionen, Kaufpreise, Kurse, News und Analystenstimmen aus dieser App.'));
      list.append(m);
    }
    data.chat.forEach((c) => {
      const m = el('div', 'cm ' + (c.role === 'user' ? 'me' : 'ai'));
      if (c.role === 'user') m.textContent = c.text; else m.append(renderMarkdown(c.text));
      if (c.sources && c.sources.length) {
        const s = el('div', 'csrc'); s.append(el('span', '', 'Quellen'));
        c.sources.slice(0, 6).forEach((x) => s.append(link(x.url, x.title || x.url)));
        m.append(s);
      }
      if (c.cost != null) m.append(el('div', 'ccost', 'ca. ' + c.cost.toFixed(3).replace('.', ',') + ' $'));
      list.append(m);
    });
    if (busy === 'chat') list.append(el('div', 'cm ai mut', 'Claude denkt nach …'));
    const sg = $('chat-suggest'); sg.replaceChildren();
    if (!data.chat.length) ['Wie lief mein Depot diese Woche?', 'Was sagen die Analysten zu meinen Aktien?', 'Welche Termine stehen bei meinen Aktien an?'].forEach((q) => {
      const b = el('button', '', q); b.type = 'button'; b.onclick = () => { $('chat-input').value = q; sendChat(); }; sg.append(b);
    });
    $('chat-send').disabled = !!busy;
    list.scrollTop = list.scrollHeight;
  }
  function depotSnapshot() {
    const calc = calcRows(); const priced = calc.filter((c) => c.r);
    const total = priced.reduce((s, c) => s + c.value, 0);
    const withCost = priced.filter((c) => Number(c.h.cost_eur) > 0);
    const cost = withCost.reduce((s, c) => s + Number(c.h.cost_eur), 0), valC = withCost.reduce((s, c) => s + c.value, 0);
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return {
      stand_kurse: data.quotes_at, depotwert_eur: r2(total), kaufpreis_gesamt_eur: r2(cost), seit_kauf_eur: withCost.length ? r2(valC - cost) : null,
      positionen: calc.map(({ h, r, value }) => ({ name: h.name, isin: h.isin, stueck: Number(h.qty) || 0, wert_eur: r ? r2(value) : null, kaufpreis_gesamt_eur: h.cost_eur ?? null,
        kurs: r ? r.price : null, waehrung: r ? r.ccy : null, tag_pct: r ? r2(r.d1) : null, m1_pct: r ? r.m1 : null, ytd_pct: r ? r.ytd : null, sektor: h.gics || null })),
      news: state.news ? { stand: state.news.generated_at, markt: (state.news.market || []).map((x) => x.headline),
        aktien: (state.news.positions || []).map((g) => ({ id: g.id, titel: g.items.map((x) => x.headline) })),
        analysten: (state.news.sell_side || []).map((s) => [s.stock, s.broker, s.action, s.rating, s.target].filter(Boolean).join(' ')) } : null,
      termine: (state.cal?.events || []).slice(0, 12).map((e) => e.date + ' ' + (e.time || '') + ' ' + e.title),
    };
  }
  async function sendChat() {
    const inp = $('chat-input'); const q = inp.value.trim();
    if (!q || busy) return;
    busy = 'chat'; inp.value = ''; autoGrow(); banner('');
    const history = data.chat.slice(-16).map((c) => ({ role: c.role, content: c.text }));
    data.chat.push({ role: 'user', text: q, at: new Date().toISOString() }); save(); renderChat(); renderStatus();
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
  const autoGrow = () => { const t = $('chat-input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
  $('chat-input').addEventListener('input', autoGrow);
  $('chat-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(pointer: fine)').matches) { ev.preventDefault(); sendChat(); } });
  $('chat-form').addEventListener('submit', (ev) => { ev.preventDefault(); sendChat(); });

  // ---------- Position hinzufügen ----------
  $('f-add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const sym = $('f-sym').value.trim(), qty = num($('f-qty').value), cost = num($('f-cost').value);
    if (!sym || !(qty >= 0)) return;
    const up = sym.toUpperCase(), isIsin = ISIN_RE.test(up);
    const fq = data.feed?.quotes || {};
    const hitKey = Object.keys(fq).find((k) => (isIsin ? String(fq[k]?.isin || '').toUpperCase() === up : k === sym.toLowerCase() || String(fq[k]?.name || '').toLowerCase().includes(sym.toLowerCase())));
    const hit = hitKey ? fq[hitKey] : null;
    const name = hit?.name || sym, isin = hit?.isin || (isIsin ? up : null);
    if (data.positions.some((p) => (isin && p.isin === isin) || String(p.name).toLowerCase() === name.toLowerCase())) { flash('Gibt es schon. Stückzahl in der Tabelle ändern.'); return; }
    let id = hitKey && !data.positions.some((p) => p.id === hitKey) ? hitKey : slug(isin || name);
    while (data.positions.some((p) => p.id === id)) id += '-2';
    data.positions.push({ id, name, isin, wkn: hit?.wkn || null, qty, cost_eur: cost, type: hit?.fund ? 'etf' : 'aktie', added_at: new Date().toISOString() });
    applyFeed(null); save(); render();
    $('f-sym').value = ''; $('f-qty').value = ''; $('f-cost').value = '';
    flash(hit ? 'Hinzugefügt.' : 'Hinzugefügt. Der Kurs kommt, sobald die Position auch im Dashboard ist, oder sofort über „Kurse mit Claude suchen“ in den Einstellungen.');
  });

  // ---------- Einstellungen ----------
  function renderSettings() {
    const sel = $('set-model'); if (!sel.options.length) Object.entries(MODELS).forEach(([k, m]) => { const o = el('option', '', m.label); o.value = k; sel.append(o); });
    sel.value = ui.model;
    const m = MODELS[ui.model]; $('model-hint').textContent = 'Preis je 1 Mio. Token: ' + nf2.format(m.inp) + ' $ Eingabe, ' + nf2.format(m.out) + ' $ Ausgabe, dazu 0,01 $ je Websuche.';
    const k = getKey(); $('key-state').textContent = k ? 'Schlüssel gespeichert (endet auf …' + k.slice(-4) + ').' + (data.last_cost != null ? ' Letzte Anfrage ca. ' + data.last_cost.toFixed(3).replace('.', ',') + ' $.' : '')
      : 'Noch kein Schlüssel gespeichert. Kurse und News kommen trotzdem automatisch vom Dashboard. Den Schlüssel brauchst du nur für „Claude fragen“ und „Selbst mit Claude suchen“.';
    $('app-version').textContent = 'Version ' + APP_VERSION;
  }
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
  $('btn-claude-quotes').onclick = refreshQuotes;
  $('btn-claude-news').onclick = refreshNews;

  function importObject(o) {
    if (!o || !Array.isArray(o.positions)) throw new Error('Die Datei enthält keine Positionen.');
    const positions = o.positions.filter((p) => p && p.name).map((p) => ({ id: slug(p.id || p.isin || p.name), name: String(p.name), isin: p.isin || null, wkn: p.wkn || null,
      qty: num(p.qty) || 0, cost_eur: num(p.cost_eur), type: ['aktie', 'etf', 'fonds'].includes(p.type) ? p.type : 'aktie', added_at: p.added_at || '' }));
    const quotes = {};
    Object.entries(o.quotes || {}).forEach(([k, q]) => { const price = num(q?.eur_price); if (price > 0) quotes[slug(k)] = { ...q, eur_price: price, url: safeUrl(q.url) }; });
    const keep = { feed: data.feed, live: data.live, calendar: data.calendar, news: data.news, chat: data.chat };
    data = Object.assign(emptyData(), keep, { positions, quotes, quotes_at: o.quotes_at || null });
    applyFeed(null); save(); render(); toast(positions.length + ' Positionen importiert');
    setTimeout(() => loadFeed(false), 50);
    $('positionen').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('imp-file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    try { importObject(JSON.parse(await f.text())); } catch (e) { banner('Import fehlgeschlagen: ' + e.message, true); }
    ev.target.value = '';
  });
  const exportText = () => JSON.stringify({ app: 'mein-portfolio', version: 1, exported_at: new Date().toISOString(), positions: data.positions, quotes: data.quotes, quotes_at: data.quotes_at });
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

  // ---------- Bedienung ----------
  $('btn-refresh').onclick = () => loadFeed(true, 'prices');
  $('btn-news').onclick = () => loadFeed(true, 'news');
  $('btn-go-chat').onclick = () => { $('claude').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('chat-input').focus({ preventScroll: true }), 400); };
  $('btn-go-set').onclick = () => $('einstellungen').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastFeedCheck > 2 * 60e3) loadFeed(false); });
  setInterval(() => { if (document.visibilityState === 'visible' && !busy && Date.now() - lastFeedCheck > 4 * 60e3) loadFeed(false); }, 60e3); // offen: alle 5 Minuten
  setInterval(() => { renderCal(); renderStatus(); }, 5 * 60e3); // vergangene Termine ausblenden, nächste Zeiten aktuell halten

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Neue App-Version: einmal neu laden, sobald sie aktiv ist. Beim Zurückkehren in die App nach Updates suchen.
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }

  setPriv(ui.hide);
  applyFeed(null);
  render();
  loadFeed(false);
})();
