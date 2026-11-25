"""Markt-Radar: holt taeglich Kurse fuer Indizes, Aktien, Rohstoffe, Waehrungen und Krypto,
analysiert sie automatisch und schreibt zwei Dateien fuer die Seite markt.html:

  data/market.json         Zusammenfassung, Analyse, Stimmung, Tagesbericht (klein, laedt sofort)
  data/market_series.json  Tageskurse der letzten 2 Jahre fuer die Charts (wird erst bei Bedarf geladen)

Laeuft als GitHub Action (siehe .github/workflows/markt.yml), braucht nur die Python-Standardbibliothek.
Quelle: Yahoo Finance (oeffentliche Chart-Schnittstelle). Keine privaten Daten, keine Stueckzahlen.

Aufruf:
  python3 tools/market.py --out data            (echte Daten)
  python3 tools/market.py --out DIR --fake      (Zufallsdaten zum Testen ohne Internet)
"""
import argparse, datetime as dt, json, math, os, random, sys, time, urllib.parse, urllib.request

# ---------------------------------------------------------------------------
# Beobachtungsliste. Gruppe, Yahoo-Symbol, Anzeigename, Kurzname, Art
# ---------------------------------------------------------------------------
GROUPS = [
    ("idx", "Indizes"), ("de", "Aktien Deutschland"), ("us", "Aktien USA"), ("eu", "Aktien Europa"),
    ("sec", "Branchen (USA)"), ("com", "Rohstoffe"), ("fx", "Währungen"), ("cry", "Krypto"),
    ("bond", "Zinsen & Anleihen"), ("risk", "Angst-Messer"), ("depot", "Mein Depot"),
]
W = [
    # Indizes
    ("idx", "^GDAXI", "DAX", "DAX", "index"),
    ("idx", "^MDAXI", "MDAX", "MDAX", "index"),
    ("idx", "^STOXX50E", "Euro Stoxx 50", "Euro Stoxx", "index"),
    ("idx", "^GSPC", "S&P 500", "S&P 500", "index"),
    ("idx", "^NDX", "Nasdaq 100", "Nasdaq", "index"),
    ("idx", "^DJI", "Dow Jones", "Dow", "index"),
    ("idx", "EUNL.DE", "MSCI World (ETF)", "MSCI World", "etf"),
    ("idx", "^FTSE", "FTSE 100 (London)", "FTSE", "index"),
    ("idx", "^N225", "Nikkei 225 (Japan)", "Nikkei", "index"),
    ("idx", "^HSI", "Hang Seng (Hongkong)", "Hang Seng", "index"),
    # Deutschland
    ("de", "SAP.DE", "SAP", "SAP", "stock"),
    ("de", "SIE.DE", "Siemens", "Siemens", "stock"),
    ("de", "ALV.DE", "Allianz", "Allianz", "stock"),
    ("de", "DTE.DE", "Deutsche Telekom", "Telekom", "stock"),
    ("de", "AIR.DE", "Airbus", "Airbus", "stock"),
    ("de", "RHM.DE", "Rheinmetall", "Rheinmetall", "stock"),
    ("de", "MUV2.DE", "Munich Re", "Munich Re", "stock"),
    ("de", "MBG.DE", "Mercedes-Benz", "Mercedes", "stock"),
    ("de", "BMW.DE", "BMW", "BMW", "stock"),
    ("de", "VOW3.DE", "Volkswagen", "VW", "stock"),
    ("de", "BAS.DE", "BASF", "BASF", "stock"),
    ("de", "BAYN.DE", "Bayer", "Bayer", "stock"),
    ("de", "DBK.DE", "Deutsche Bank", "Dt. Bank", "stock"),
    ("de", "IFX.DE", "Infineon", "Infineon", "stock"),
    ("de", "ADS.DE", "Adidas", "Adidas", "stock"),
    ("de", "DHL.DE", "DHL Group", "DHL", "stock"),
    # USA
    ("us", "AAPL", "Apple", "Apple", "stock"),
    ("us", "MSFT", "Microsoft", "Microsoft", "stock"),
    ("us", "NVDA", "Nvidia", "Nvidia", "stock"),
    ("us", "AMZN", "Amazon", "Amazon", "stock"),
    ("us", "GOOGL", "Alphabet (Google)", "Google", "stock"),
    ("us", "META", "Meta (Facebook)", "Meta", "stock"),
    ("us", "TSLA", "Tesla", "Tesla", "stock"),
    ("us", "AVGO", "Broadcom", "Broadcom", "stock"),
    ("us", "AMD", "AMD", "AMD", "stock"),
    ("us", "PLTR", "Palantir", "Palantir", "stock"),
    ("us", "NFLX", "Netflix", "Netflix", "stock"),
    ("us", "JPM", "JPMorgan Chase", "JPMorgan", "stock"),
    ("us", "V", "Visa", "Visa", "stock"),
    ("us", "BRK-B", "Berkshire Hathaway", "Berkshire", "stock"),
    ("us", "LLY", "Eli Lilly", "Eli Lilly", "stock"),
    ("us", "WMT", "Walmart", "Walmart", "stock"),
    ("us", "KO", "Coca-Cola", "Coca-Cola", "stock"),
    ("us", "XOM", "ExxonMobil", "Exxon", "stock"),
    # Europa
    ("eu", "ASML.AS", "ASML", "ASML", "stock"),
    ("eu", "NOVO-B.CO", "Novo Nordisk", "Novo Nordisk", "stock"),
    ("eu", "MC.PA", "LVMH", "LVMH", "stock"),
    ("eu", "NESN.SW", "Nestlé", "Nestlé", "stock"),
    ("eu", "SHEL.L", "Shell", "Shell", "stock"),
    ("eu", "NOKIA.HE", "Nokia", "Nokia", "stock"),
    # Branchen
    ("sec", "XLK", "Technologie", "Technologie", "sector"),
    ("sec", "XLC", "Kommunikation & Medien", "Kommunikation", "sector"),
    ("sec", "XLY", "Zyklischer Konsum", "Konsum zyklisch", "sector"),
    ("sec", "XLF", "Banken & Finanzen", "Finanzen", "sector"),
    ("sec", "XLI", "Industrie", "Industrie", "sector"),
    ("sec", "XLV", "Gesundheit", "Gesundheit", "sector"),
    ("sec", "XLE", "Energie", "Energie", "sector"),
    ("sec", "XLB", "Grundstoffe", "Grundstoffe", "sector"),
    ("sec", "XLP", "Basiskonsum", "Basiskonsum", "sector"),
    ("sec", "XLU", "Versorger", "Versorger", "sector"),
    ("sec", "XLRE", "Immobilien", "Immobilien", "sector"),
    # Rohstoffe
    ("com", "GC=F", "Gold", "Gold", "commodity"),
    ("com", "SI=F", "Silber", "Silber", "commodity"),
    ("com", "CL=F", "Öl (WTI)", "Öl WTI", "commodity"),
    ("com", "BZ=F", "Öl (Brent)", "Öl Brent", "commodity"),
    ("com", "NG=F", "Erdgas (USA)", "Erdgas", "commodity"),
    ("com", "HG=F", "Kupfer", "Kupfer", "commodity"),
    # Waehrungen
    ("fx", "EURUSD=X", "Euro in US-Dollar", "EUR/USD", "fx"),
    ("fx", "EURGBP=X", "Euro in Pfund", "EUR/GBP", "fx"),
    ("fx", "EURCHF=X", "Euro in Franken", "EUR/CHF", "fx"),
    ("fx", "EURJPY=X", "Euro in Yen", "EUR/JPY", "fx"),
    ("fx", "DX-Y.NYB", "Dollar-Index", "Dollar-Index", "fx"),
    # Krypto
    ("cry", "BTC-EUR", "Bitcoin", "Bitcoin", "crypto"),
    ("cry", "ETH-EUR", "Ethereum", "Ethereum", "crypto"),
    ("cry", "SOL-EUR", "Solana", "Solana", "crypto"),
    ("cry", "XRP-EUR", "XRP", "XRP", "crypto"),
    # Zinsen und Anleihen
    ("bond", "^TNX", "US-Zins 10 Jahre (Rendite in %)", "US-Zins 10J", "yield"),
    ("bond", "^IRX", "US-Zins 3 Monate (Rendite in %)", "US-Zins 3M", "yield"),
    ("bond", "TLT", "US-Staatsanleihen 20+ J. (ETF)", "Staatsanleihen", "bondetf"),
    ("bond", "LQD", "Firmenanleihen gute Bonität (ETF)", "Firmenanleihen", "bondetf"),
    ("bond", "HYG", "Hochzinsanleihen (ETF)", "Hochzins", "bondetf"),
    # Angst
    ("risk", "^VIX", "VIX – Angstbarometer USA", "VIX", "vol"),
]
STOCK_GROUPS = ("de", "us", "eu")
MAIN_IDX = ["^GDAXI", "^GSPC", "^NDX", "^STOXX50E"]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


# ---------------------------------------------------------------------------
# Daten holen
# ---------------------------------------------------------------------------
def fetch_yahoo(sym):
    q = urllib.parse.quote(sym, safe="")
    last = None
    for host in ("query2", "query1"):
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{q}?range=2y&interval=1d&includePrePost=false&events=div%2Csplit"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=25) as r:
                d = json.loads(r.read().decode("utf-8"))
            res = (d.get("chart") or {}).get("result") or []
            if not res:
                raise ValueError(((d.get("chart") or {}).get("error") or {}).get("description") or "keine Daten")
            res = res[0]
            meta = res.get("meta") or {}
            ts = res.get("timestamp") or []
            qu = ((res.get("indicators") or {}).get("quote") or [{}])[0]
            off = int(meta.get("gmtoffset") or 0)
            rows = {}
            for i, t in enumerate(ts):
                c = (qu.get("close") or [None])[i] if i < len(qu.get("close") or []) else None
                if c is None:
                    continue
                day = dt.datetime.fromtimestamp(t + off, dt.timezone.utc).date().isoformat()
                h = _at(qu.get("high"), i) or c
                lo = _at(qu.get("low"), i) or c
                v = _at(qu.get("volume"), i) or 0
                rows[day] = (float(c), float(h), float(lo), float(v))
            if len(rows) < 30:
                raise ValueError("zu wenig Kurse")
            p = meta.get("regularMarketPrice")
            mt = meta.get("regularMarketTime")
            if p and mt:  # aktuellster Kurs als Schluss des Handelstags
                day = dt.datetime.fromtimestamp(int(mt) + off, dt.timezone.utc).date().isoformat()
                c0, h0, l0, v0 = rows.get(day, (p, p, p, 0))
                rows[day] = (float(p), max(h0, p), min(l0, p), v0)
            days = sorted(rows)
            return {
                "t": days, "c": [rows[d][0] for d in days], "h": [rows[d][1] for d in days],
                "l": [rows[d][2] for d in days], "v": [rows[d][3] for d in days],
                "ccy": meta.get("currency") or "", "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
                "time": dt.datetime.fromtimestamp(int(mt), dt.timezone.utc).isoformat(timespec="seconds") if mt else None,
            }
        except Exception as e:  # anderer Server probieren
            last = e
            time.sleep(1.0)
    raise last


def _at(arr, i):
    try:
        v = arr[i]
        return float(v) if v is not None else None
    except (TypeError, IndexError):
        return None


def fake_series(sym, kind):
    """Zufallsdaten (nur fuer Tests ohne Internet)."""
    rnd = random.Random(sym)
    start = {"index": 18000, "fx": 1.1, "yield": 4.2, "vol": 17, "crypto": 60000}.get(kind, rnd.uniform(20, 400))
    vol = {"index": 0.009, "fx": 0.004, "yield": 0.02, "vol": 0.06, "crypto": 0.03, "commodity": 0.015}.get(kind, 0.018)
    drift = rnd.uniform(-0.0006, 0.0012)
    days, c, h, l, v = [], [], [], [], []
    d = dt.date.today() - dt.timedelta(days=730)
    p = start
    while d <= dt.date.today():
        if d.weekday() < 5 or kind == "crypto":
            if kind == "vol":
                p = max(10, p + (17 - p) * 0.05 + rnd.gauss(0, 1.2))
            else:
                p *= math.exp(rnd.gauss(drift, vol))
            days.append(d.isoformat()); c.append(p); h.append(p * (1 + abs(rnd.gauss(0, vol / 2))))
            l.append(p * (1 - abs(rnd.gauss(0, vol / 2)))); v.append(rnd.uniform(1e6, 3e6))
        d += dt.timedelta(days=1)
    return {"t": days, "c": c, "h": h, "l": l, "v": v, "ccy": "EUR", "exchange": "Test",
            "time": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


# ---------------------------------------------------------------------------
# Indikatoren
# ---------------------------------------------------------------------------
def sma(a, n):
    out, s = [None] * len(a), 0.0
    for i, x in enumerate(a):
        s += x
        if i >= n:
            s -= a[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(a, n):
    out, k, e = [None] * len(a), 2 / (n + 1), None
    for i, x in enumerate(a):
        e = x if e is None else x * k + e * (1 - k)
        if i >= n - 1:
            out[i] = e
    return out


def rsi(a, n=14):
    out = [None] * len(a)
    if len(a) <= n:
        return out
    g = l = 0.0
    for i in range(1, n + 1):
        d = a[i] - a[i - 1]
        g += max(d, 0); l += max(-d, 0)
    g /= n; l /= n
    out[n] = 100 - 100 / (1 + g / l) if l else 100.0
    for i in range(n + 1, len(a)):
        d = a[i] - a[i - 1]
        g = (g * (n - 1) + max(d, 0)) / n
        l = (l * (n - 1) + max(-d, 0)) / n
        out[i] = 100 - 100 / (1 + g / l) if l else 100.0
    return out


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def pct(a, b):
    try:
        return (a / b - 1) * 100 if b else None
    except (TypeError, ZeroDivisionError):
        return None


def r2(v, nd=2):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(v, nd)


def back(c, n):
    return c[-1 - n] if len(c) > n else None


def ref_by_date(t, c, days):
    """Kurs am letzten Handelstag vor (letzter Tag - days Kalendertage)."""
    target = (dt.date.fromisoformat(t[-1]) - dt.timedelta(days=days)).isoformat()
    for i in range(len(t) - 1, -1, -1):
        if t[i] <= target:
            return c[i]
    return None


# ---------------------------------------------------------------------------
# Analyse eines Werts
# ---------------------------------------------------------------------------
def analyse(item, s):
    t, c, h, l, v = s["t"], s["c"], s["h"], s["l"], s["v"]
    kind = item["kind"]
    p = c[-1]
    n = len(c)
    s20, s50, s200 = sma(c, 20), sma(c, 50), sma(c, 200)
    r = rsi(c)
    e12, e26 = ema(c, 12), ema(c, 26)
    macd = [a - b if a is not None and b is not None else None for a, b in zip(e12, e26)]
    mv = [x for x in macd if x is not None]
    sig = ema(mv, 9) if len(mv) >= 9 else []
    hist = (mv[-1] - sig[-1]) if sig and sig[-1] is not None else None
    hist_prev = (mv[-2] - sig[-2]) if len(sig) >= 2 and sig[-2] is not None else None

    rets = [math.log(c[i] / c[i - 1]) for i in range(1, n) if c[i - 1] > 0 and c[i] > 0]
    per_year = 365 if kind == "crypto" else 252
    vol20 = stdev(rets[-20:]) * math.sqrt(per_year) * 100 if len(rets) >= 20 else None
    vol1y = stdev(rets[-252:]) * math.sqrt(per_year) * 100 if len(rets) >= 60 else None
    dsig = stdev(rets[-120:]) * 100 if len(rets) >= 30 else None  # typische Tagesbewegung in %

    yr = per_year
    w = c[-yr:]
    hi52, lo52 = max(h[-yr:]), min(l[-yr:])
    peak, mdd = w[0], 0.0
    for x in w:
        peak = max(peak, x)
        mdd = min(mdd, x / peak - 1)
    ath2 = max(h)  # Hoch der letzten 2 Jahre

    prev_year = str(int(t[-1][:4]) - 1)
    ytd_base = next((c[i] for i in range(n - 1, -1, -1) if t[i][:4] <= prev_year), None)

    d1 = pct(p, back(c, 1))
    m = {
        "price": p, "d1": d1, "w1": pct(p, ref_by_date(t, c, 7)), "m1": pct(p, ref_by_date(t, c, 30)),
        "m3": pct(p, ref_by_date(t, c, 91)), "m6": pct(p, ref_by_date(t, c, 182)), "ytd": pct(p, ytd_base),
        "y1": pct(p, ref_by_date(t, c, 365)), "y2": pct(p, c[0]) if (dt.date.fromisoformat(t[-1]) - dt.date.fromisoformat(t[0])).days > 700 else None,
        "sma20": s20[-1], "sma50": s50[-1], "sma200": s200[-1], "rsi": r[-1], "macd_hist": hist,
        "vol20": vol20, "vol1y": vol1y, "dsig": dsig, "hi52": hi52, "lo52": lo52,
        "from_hi": pct(p, hi52), "from_lo": pct(p, lo52), "mdd1y": mdd * 100,
        "range20_lo": min(l[-20:]), "range20_hi": max(h[-20:]),
        "vol_ratio": (v[-1] / (sum(v[-21:-1]) / 20)) if kind in ("stock", "etf", "sector") and sum(v[-21:-1]) > 0 and v[-1] > 0 else None,
    }
    if kind in ("yield", "vol"):  # Zinsen und VIX: Veraenderung in Punkten ist aussagekraeftiger
        m["d1_abs"] = p - back(c, 1) if back(c, 1) is not None else None

    # ---------- Trend-Score (-100 .. +100) ----------
    score = 0.0
    if m["sma200"]:
        score += 25 if p > m["sma200"] else -25
    if m["sma50"]:
        score += 15 if p > m["sma50"] else -15
    if m["sma50"] and m["sma200"]:
        score += 10 if m["sma50"] > m["sma200"] else -10
    if n > 70 and s50[-1] and s50[-21]:
        score += 10 if s50[-1] > s50[-21] else -10
    if m["m3"] is not None:
        sc = (vol1y or 20) / 2  # 3-Monats-Bewegung im Verhaeltnis zur ueblichen Schwankung
        score += max(-25, min(25, m["m3"] / sc * 25))
    if hist is not None:
        score += 7.5 if hist > 0 else -7.5
    if m["d1"] is not None and dsig:
        score += max(-7.5, min(7.5, m["d1"] / dsig * 3))
    score = max(-100, min(100, score))
    m["score"] = score

    # Fuer Zinsen, VIX und Waehrungen ist "steigt" nicht "gut". Trend bleibt Richtung.
    neutral_dir = kind in ("yield", "vol", "fx")
    if score >= 55:
        trend, light = "Starker Aufwärtstrend", "green"
    elif score >= 20:
        trend, light = "Aufwärtstrend", "green"
    elif score > -20:
        trend, light = "Seitwärts", "yellow"
    elif score > -55:
        trend, light = "Abwärtstrend", "red"
    else:
        trend, light = "Starker Abwärtstrend", "red"
    if neutral_dir:
        trend = trend.replace("Aufwärtstrend", "steigt").replace("Abwärtstrend", "fällt").replace("Starker steigt", "steigt stark").replace("Starker fällt", "fällt stark")
        light = "blue"

    # Temperatur (RSI)
    rv = m["rsi"]
    if rv is None:
        temp, temp_txt = "normal", ""
    elif rv >= 75:
        temp, temp_txt = "hot", "stark heißgelaufen"
    elif rv >= 68:
        temp, temp_txt = "warm", "etwas heißgelaufen"
    elif rv <= 25:
        temp, temp_txt = "cold", "stark ausverkauft"
    elif rv <= 32:
        temp, temp_txt = "cool", "eher ausverkauft"
    else:
        temp, temp_txt = "normal", "normal temperiert"

    # Risiko (Schwankung)
    vv = vol20 or vol1y or 0
    if kind == "fx":
        lvl = 0 if vv < 6 else 1 if vv < 10 else 2 if vv < 15 else 3
    else:
        lvl = 0 if vv < 15 else 1 if vv < 28 else 2 if vv < 45 else 3
    risk_txt = ["ruhig", "normal", "schwankungsreich", "sehr wild"][lvl]

    # ---------- Auffaelligkeiten ----------
    ev = []
    def add(kind_, tone, text, weight):
        ev.append({"k": kind_, "tone": tone, "text": text, "w": weight})

    if m["from_hi"] is not None and m["from_hi"] > -0.6 and n > 200:
        add("high", "pos", "Auf oder nahe am 52-Wochen-Hoch", 6)
    elif m["from_lo"] is not None and m["from_lo"] < 0.6 and n > 200:
        add("low", "neg", "Auf oder nahe am 52-Wochen-Tief", 6)
    for i in range(1, 11):
        a0, a1, b0, b1 = s50[-i - 1], s50[-i], s200[-i - 1], s200[-i]
        if None in (a0, a1, b0, b1):
            break
        if a0 <= b0 and a1 > b1:
            add("golden", "pos", f"„Golden Cross“ vor {i} Handelstag{'en' if i > 1 else ''}: 50-Tage-Linie hat die 200-Tage-Linie nach oben gekreuzt", 7)
            break
        if a0 >= b0 and a1 < b1:
            add("death", "neg", f"„Death Cross“ vor {i} Handelstag{'en' if i > 1 else ''}: 50-Tage-Linie hat die 200-Tage-Linie nach unten gekreuzt", 7)
            break
    for i in range(1, 6):
        if s200[-i - 1] is None:
            break
        if c[-i - 1] <= s200[-i - 1] and c[-i] > s200[-i]:
            add("x200up", "pos", "Über die 200-Tage-Linie gestiegen (wichtige Trendmarke)", 6); break
        if c[-i - 1] >= s200[-i - 1] and c[-i] < s200[-i]:
            add("x200dn", "neg", "Unter die 200-Tage-Linie gefallen (wichtige Trendmarke)", 6); break
    if rv is not None and rv >= 70:
        add("rsi_hi", "warn", f"RSI {rv:.0f}: heißgelaufen, oft folgt eine Verschnaufpause", 4)
    if rv is not None and rv <= 30:
        add("rsi_lo", "warn", f"RSI {rv:.0f}: stark verkauft, Gegenbewegungen sind dann häufig", 4)
    if d1 is not None and dsig and abs(d1) > 2.5 * dsig and abs(d1) > 1.5:
        add("move", "pos" if d1 > 0 else "neg", f"Ungewöhnlich starke Tagesbewegung ({d1:+.1f} %, sonst typisch ±{dsig:.1f} %)".replace(".", ","), 8)
    if m["vol_ratio"] and m["vol_ratio"] > 2.2:
        add("volume", "info", f"Handelsvolumen {m['vol_ratio']:.1f}× so hoch wie üblich – viel Interesse".replace(".", ","), 5)
    if hist is not None and hist_prev is not None:
        if hist_prev <= 0 < hist:
            add("macd_up", "pos", "MACD dreht nach oben (Schwung nimmt zu)", 3)
        elif hist_prev >= 0 > hist:
            add("macd_dn", "neg", "MACD dreht nach unten (Schwung lässt nach)", 3)
    if vol20 and vol1y and vol20 > vol1y * 1.6 and vol20 > 15:
        add("volspike", "warn", "Schwankt gerade deutlich stärker als sonst", 4)
    if m["mdd1y"] < -30 and m["from_hi"] is not None and m["from_hi"] < -30:
        add("crash", "neg", f"Liegt {abs(m['from_hi']):.0f} % unter dem Jahreshoch", 5)
    ev.sort(key=lambda e: -e["w"])

    # ---------- Klartext ----------
    name = item["short"]
    parts = []
    if neutral_dir:
        if kind == "yield":
            parts.append(f"Der Zins {trend} ({fmt_pts(m['m3'], p, c, t)}).")
        elif kind == "vol":
            parts.append(vix_sentence(p))
        else:
            parts.append(f"{name} {trend} ({fmt_p(m['m3'])} in 3 Monaten).")
    else:
        if m["m3"] is not None:
            parts.append(f"{name} ist im {trend} ({fmt_p(m['m3'])} in 3 Monaten)." if "trend" in trend else f"{name} bewegt sich seitwärts ({fmt_p(m['m3'])} in 3 Monaten).")
        if m["from_hi"] is not None and n > 200:
            if m["from_hi"] > -2:
                parts.append("Der Kurs steht fast am Jahreshoch.")
            elif m["from_hi"] < -20:
                parts.append(f"Vom Jahreshoch ist er {abs(m['from_hi']):.0f} % entfernt.")
    if temp_txt and temp != "normal" and kind != "vol":
        parts.append(f"Kurzfristig {temp_txt}.")
    parts.append(f"Schwankung: {risk_txt}.")
    m.update({"trend": trend, "light": light, "temp": temp, "temp_txt": temp_txt, "risk": lvl, "risk_txt": risk_txt,
              "summary": " ".join(parts), "events": ev[:5]})
    return m


def fmt_p(v):
    return "k. A." if v is None else ("+" if v > 0 else "") + f"{v:.1f}".replace(".", ",") + " %"


def fmt_pts(_, p, c, t):
    old = ref_by_date(t, c, 91)
    return "k. A." if old is None else f"von {old:.2f} auf {p:.2f} % in 3 Monaten".replace(".", ",")


def vix_sentence(v):
    if v < 14:
        return f"VIX {v:.0f}: Die Anleger sind sehr entspannt."
    if v < 20:
        return f"VIX {v:.0f}: Normale, ruhige Lage."
    if v < 28:
        return f"VIX {v:.0f}: Erhöhte Nervosität."
    if v < 40:
        return f"VIX {v:.0f}: Deutliche Angst am Markt."
    return f"VIX {v:.0f}: Panik – sehr hohe Angst."


# ---------------------------------------------------------------------------
# Stimmungsbarometer (0 = extreme Angst, 100 = extreme Gier) - auch rueckwirkend je Tag
# ---------------------------------------------------------------------------
def clamp01(x):
    return max(0.0, min(1.0, x))


def asof_index(t):
    return {d: i for i, d in enumerate(t)}


def mood_history(series, stocks, days=260):
    spx = series.get("^GSPC")
    if not spx or len(spx["c"]) < 200:
        return [], {}
    master = spx["t"]
    # Hilfsreihen je Symbol als Kurs am oder vor einem Datum
    def asof_fn(s):
        t, c = s["t"], s["c"]
        j = 0
        cache = {}
        def f(day):
            nonlocal j
            if day in cache:
                return cache[day]
            # Datum steigt monoton
            while j + 1 < len(t) and t[j + 1] <= day:
                j += 1
            out = (j, c[j]) if t[j] <= day else (None, None)
            cache[day] = out
            return out
        return f

    spx_s125 = sma(spx["c"], 125)
    vix = series.get("^VIX"); tlt = series.get("TLT"); hyg = series.get("HYG"); lqd = series.get("LQD")
    st = []
    for sym in stocks:
        s = series[sym]
        st.append((s, sma(s["c"], 50), asof_fn(s)))
    vf = asof_fn(vix) if vix else None
    vix_s50 = sma(vix["c"], 50) if vix else None
    tf, hf, lf = (asof_fn(x) if x else None for x in (tlt, hyg, lqd))

    def ret20(fn, s, day):
        j, cv = fn(day)
        if j is None or j < 20:
            return None
        return cv / s["c"][j - 20] - 1

    out = []
    start = max(200, len(master) - days)
    for i in range(start, len(master)):
        day = master[i]
        comp = {}
        if spx_s125[i]:
            comp["momentum"] = clamp01((spx["c"][i] / spx_s125[i] - 1 + 0.08) / 0.16)
        above = tot = nh = nl = 0
        for s, s50, fn in st:
            j, cv = fn(day)
            if j is None or j < 60:
                continue
            tot += 1
            if s50[j] and cv > s50[j]:
                above += 1
            lo = max(0, j - 251)
            hh, ll = max(s["h"][lo:j + 1]), min(s["l"][lo:j + 1])
            if cv >= hh * 0.97:
                nh += 1
            if cv <= ll * 1.03:
                nl += 1
        if tot >= 8:
            comp["breadth"] = above / tot
            comp["highs"] = clamp01(0.5 + (nh - nl) / tot)
        if vf:
            j, cv = vf(day)
            if j is not None and vix_s50[j]:
                rel = cv / vix_s50[j]
                lvl = clamp01((32 - cv) / 20)  # 12 = sehr ruhig, 32 = Angst
                comp["volatility"] = clamp01(0.5 * lvl + 0.5 * clamp01((1.35 - rel) / 0.6))
        if tf:
            a, b = ret20(asof_fn_cache(spx), spx, day), ret20(tf, tlt, day)
            if a is not None and b is not None:
                comp["safe_haven"] = clamp01((a - b + 0.08) / 0.16)
        if hf and lf:
            a, b = ret20(hf, hyg, day), ret20(lf, lqd, day)
            if a is not None and b is not None:
                comp["junk"] = clamp01((a - b + 0.015) / 0.03)
        if len(comp) >= 3:
            val = sum(comp.values()) / len(comp) * 100
            out.append((day, val, comp))
    if not out:
        return [], {}
    hist = [[d, round(v, 1)] for d, v, _ in out]
    last = out[-1]
    return hist, {k: round(v * 100, 1) for k, v in last[2].items()}


_asof_cache = {}


def asof_fn_cache(s):
    key = id(s)
    if key not in _asof_cache:
        idx = asof_index(s["t"])
        t = s["t"]
        def f(day, idx=idx, t=t, c=s["c"]):
            if day in idx:
                return idx[day], c[idx[day]]
            # Fallback: binaere Suche
            lo, hi = 0, len(t) - 1
            if t[0] > day:
                return None, None
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if t[mid] <= day:
                    lo = mid
                else:
                    hi = mid - 1
            return lo, c[lo]
        _asof_cache[key] = f
    return _asof_cache[key]


def mood_label(v):
    if v is None:
        return "k. A."
    if v < 25:
        return "Extreme Angst"
    if v < 45:
        return "Angst"
    if v <= 55:
        return "Neutral"
    if v <= 75:
        return "Gier"
    return "Extreme Gier"


MOOD_COMP = {
    "momentum": ("Schwung", "S&P 500 im Vergleich zu seinem Durchschnitt der letzten 125 Tage"),
    "breadth": ("Breite", "Anteil der beobachteten Aktien über ihrer 50-Tage-Linie"),
    "highs": ("Hochs gegen Tiefs", "Aktien nahe Jahreshoch gegen Aktien nahe Jahrestief"),
    "volatility": ("Ruhe", "VIX-Angstbarometer: niedrig = ruhig, hoch = Angst"),
    "safe_haven": ("Risikofreude", "Aktien gegen sichere Staatsanleihen (20 Tage)"),
    "junk": ("Hochzins-Appetit", "Riskante Hochzinsanleihen gegen sichere Firmenanleihen (20 Tage)"),
}


# ---------------------------------------------------------------------------
# Tagesbericht in einfacher Sprache
# ---------------------------------------------------------------------------
def de(v, nd=1):
    return f"{v:+.{nd}f}".replace(".", ",") + " %"


def build_report(items, mood_now, mood_week, mood_month, comps):
    by = {it["sym"]: it for it in items if it.get("a")}
    A = lambda s: by[s]["a"] if s in by else None
    idx = [by[s] for s in MAIN_IDX if s in by]
    avg = sum(i["a"]["d1"] or 0 for i in idx) / len(idx) if idx else 0
    if avg > 1.2:
        head = "Starker Tag an den Börsen"
    elif avg > 0.3:
        head = "Freundlicher Börsentag"
    elif avg > -0.3:
        head = "Börsen treten auf der Stelle"
    elif avg > -1.2:
        head = "Leichte Verluste an den Börsen"
    else:
        head = "Schwacher Tag an den Börsen"
    head += ": " + ", ".join(f"{i['short']} {de(i['a']['d1'])}" for i in idx[:3] if i["a"]["d1"] is not None)

    bullets, paras = [], []
    # Indizes
    txt = []
    for s in ("^GDAXI", "^GSPC", "^NDX"):
        a = A(s)
        if not a:
            continue
        nm = by[s]["short"]
        pos = "über" if a["sma200"] and a["price"] > a["sma200"] else "unter"
        hi = "nahe am Rekord/Jahreshoch" if a["from_hi"] is not None and a["from_hi"] > -2 else f"{abs(a['from_hi']):.0f} % unter dem Jahreshoch".replace(".", ",") if a["from_hi"] is not None else ""
        txt.append(f"{nm}: heute {de(a['d1'])}, seit Jahresbeginn {de(a['ytd'])}. Er liegt {pos} seiner 200-Tage-Linie ({hi}).")
    if txt:
        paras.append({"title": "Die großen Indizes", "text": " ".join(txt)})
    dax, spx = A("^GDAXI"), A("^GSPC")
    if dax and spx:
        bullets.append(f"DAX {de(dax['d1'])}, S&P 500 {de(spx['d1'])} – Trend: DAX „{dax['trend']}“, S&P 500 „{spx['trend']}“.")

    # Stimmung
    if mood_now is not None:
        chg = ""
        if mood_week is not None:
            d = mood_now - mood_week
            chg = f" Vor einer Woche lag der Wert bei {mood_week:.0f} ({'mehr Zuversicht' if d > 3 else 'mehr Sorge' if d < -3 else 'kaum verändert'})."
        best = max(comps.items(), key=lambda kv: kv[1]) if comps else None
        worst = min(comps.items(), key=lambda kv: kv[1]) if comps else None
        why = f" Am optimistischsten ist gerade „{MOOD_COMP[best[0]][0]}“, am vorsichtigsten „{MOOD_COMP[worst[0]][0]}“." if best and worst else ""
        paras.append({"title": "Stimmung", "text": f"Das Stimmungsbarometer steht bei {mood_now:.0f} von 100: {mood_label(mood_now)}.{chg}{why}"})
        bullets.append(f"Stimmung: {mood_now:.0f}/100 – {mood_label(mood_now)}.")

    # Gewinner und Verlierer
    stocks = [i for i in items if i.get("a") and i["group"] in STOCK_GROUPS and i["a"]["d1"] is not None]
    if stocks:
        st = sorted(stocks, key=lambda i: i["a"]["d1"])
        win = [f"{i['short']} ({de(i['a']['d1'])})" for i in st[::-1][:3] if i["a"]["d1"] > 0]
        los = [f"{i['short']} ({de(i['a']['d1'])})" for i in st[:3] if i["a"]["d1"] < 0]
        ups = sum(1 for i in stocks if i["a"]["d1"] > 0)
        t = f"Von {len(stocks)} beobachteten Aktien sind {ups} im Plus."
        if win:
            t += " Vorne: " + ", ".join(win) + "."
        if los:
            t += " Hinten: " + ", ".join(los) + "."
        paras.append({"title": "Gewinner und Verlierer", "text": t})
        if win:
            bullets.append("Top-Aktie heute: " + win[0] + (", Schlusslicht: " + los[0] if los else "") + ".")

    # Branchen
    secs = [i for i in items if i.get("a") and i["group"] == "sec" and i["a"]["d1"] is not None]
    if secs:
        s1 = sorted(secs, key=lambda i: i["a"]["d1"])
        sm = sorted([i for i in secs if i["a"]["m1"] is not None], key=lambda i: i["a"]["m1"])
        t = f"Heute am stärksten: {s1[-1]['short']} ({de(s1[-1]['a']['d1'])}), am schwächsten: {s1[0]['short']} ({de(s1[0]['a']['d1'])})."
        if sm:
            t += f" Über einen Monat führt {sm[-1]['short']} ({de(sm[-1]['a']['m1'])}), {sm[0]['short']} liegt hinten ({de(sm[0]['a']['m1'])})."
        defensive = sum((A(s) or {}).get("m1") or 0 for s in ("XLP", "XLU", "XLV")) / 3
        cyc = sum((A(s) or {}).get("m1") or 0 for s in ("XLK", "XLY", "XLF")) / 3
        if cyc - defensive > 2:
            t += " Anleger setzen eher auf Wachstum und Risiko (Technik, Konsum, Banken laufen besser als sichere Branchen)."
        elif defensive - cyc > 2:
            t += " Anleger sind vorsichtig: Sichere Branchen wie Versorger, Gesundheit und Basiskonsum laufen besser."
        paras.append({"title": "Branchen", "text": t})

    # Rohstoffe, Waehrungen, Krypto
    t = []
    for s, label in (("GC=F", "Gold"), ("BZ=F", "Öl (Brent)"), ("BTC-EUR", "Bitcoin")):
        a = A(s)
        if a and a["d1"] is not None:
            t.append(f"{label} {de(a['d1'])} (1 Monat {de(a['m1'])})")
    eu = A("EURUSD=X")
    if eu:
        t.append(f"1 Euro kostet {eu['price']:.4f} US-Dollar ({de(eu['d1'], 2)})".replace(".", ",", 1))
    tnx = A("^TNX")
    if tnx:
        t.append(f"US-Zins 10 Jahre {tnx['price']:.2f} %".replace(".", ","))
    if t:
        paras.append({"title": "Gold, Öl, Krypto, Währungen", "text": "; ".join(t) + "."})
    vix = A("^VIX")
    if vix:
        bullets.append(vix_sentence(vix["price"]))

    # Auffaelligkeiten
    evs = []
    for i in items:
        if not i.get("a") or i["group"] in ("bond",):
            continue
        for e in i["a"]["events"]:
            if e["w"] >= 5:
                evs.append((e["w"] + (2 if i["group"] in ("idx", "depot") or i.get("depot") else 0), i["short"], e))
    evs.sort(key=lambda x: -x[0])
    if evs:
        paras.append({"title": "Auffällig", "text": " ".join(f"{nm}: {e['text']}." for _, nm, e in evs[:6])})

    # Depot
    dep = [i for i in items if i.get("a") and i.get("depot")]
    if dep:
        dd = [f"{i['short']} {de(i['a']['d1'])} ({i['a']['trend']})" for i in dep if i["a"]["d1"] is not None]
        if dd:
            paras.append({"title": "Deine Depotwerte", "text": ", ".join(dd) + "."})

    # Einordnung fuer Einsteiger
    if mood_now is not None:
        if mood_now < 25:
            tip = ("Die Stimmung ist sehr ängstlich. Historisch waren solche Phasen oft Zeiten, in denen Panikverkäufe teuer wurden. "
                   "Wer langfristig anlegt, bleibt meist ruhig und hält sich an seinen Plan.")
        elif mood_now < 45:
            tip = "Die Anleger sind vorsichtig. Schwankungen sind normal – langfristig zählt der Plan, nicht der einzelne Tag."
        elif mood_now <= 55:
            tip = "Keine Extreme. Ein guter Moment, sich ohne Druck mit seiner Strategie zu beschäftigen."
        elif mood_now <= 75:
            tip = "Die Anleger sind zuversichtlich. Gut für Kurse – aber nicht leichtsinnig werden und Risiken streuen."
        else:
            tip = ("Sehr viel Gier im Markt. In solchen Phasen werden Risiken gern übersehen; Rücksetzer kommen dann oft überraschend. "
                   "Nicht der Masse hinterherlaufen.")
        paras.append({"title": "Was heißt das für dich?", "text": tip + " (Keine Anlageberatung.)"})

    return {"headline": head, "bullets": bullets[:5], "paragraphs": paras}


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------
def load_depot(feed_path):
    """Depot-Werte aus data/feed.json (nur Ticker und Namen, keine Stueckzahlen)."""
    try:
        feed = json.load(open(feed_path, encoding="utf-8"))
    except Exception:
        return []
    out = []
    for k, q in (feed.get("quotes") or {}).items():
        tk = q.get("ticker")
        if tk and isinstance(tk, str) and len(tk) < 20:
            nm = str(q.get("name") or tk)
            short = nm.replace("Bayerische Motoren Werke AG", "BMW").replace("Space Exploration Technologies Corp.", "SpaceX")
            for cut in (" Inc.", " Oyj", " AG", " PLC", " Group", " International", " UCITS", ".com", " Corp."):
                short = short.split(cut)[0]
            out.append({"id": k, "sym": tk, "name": nm, "short": short.replace("Vanguard FTSE ", "Vanguard ").strip()[:28]})
    return out


def compact(vals):
    out = []
    for x in vals:
        a = abs(x)
        nd = 2 if a >= 1000 else 3 if a >= 10 else 4 if a >= 1 else 6
        out.append(round(x, nd))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--feed", default="data/feed.json")
    ap.add_argument("--fake", action="store_true")
    a = ap.parse_args()

    items = [{"group": g, "sym": s, "name": n, "short": sh, "kind": k} for g, s, n, sh, k in W]
    known = {i["sym"]: i for i in items}
    for d in load_depot(a.feed):
        if d["sym"] in known:
            known[d["sym"]]["depot"] = True
        else:
            it = {"group": "depot", "sym": d["sym"], "name": d["name"], "short": d["short"], "kind": "stock", "depot": True}
            items.append(it); known[d["sym"]] = it

    old = {}
    try:
        old = json.load(open(os.path.join(a.out, "market.json"), encoding="utf-8"))
    except Exception:
        pass

    series, errors = {}, []
    for it in items:
        try:
            s = fake_series(it["sym"], it["kind"]) if a.fake else fetch_yahoo(it["sym"])
            series[it["sym"]] = s
            it["ccy"] = s["ccy"]; it["exchange"] = s["exchange"]; it["time"] = s["time"]; it["day"] = s["t"][-1]
        except Exception as e:
            errors.append({"sym": it["sym"], "name": it["name"], "error": str(e)[:150]})
        if not a.fake:
            time.sleep(0.25)

    if len(series) < len(items) * 0.5:
        # Kaum Daten: lieber alte Datei behalten als eine leere Seite
        print(json.dumps({"ok": len(series), "errors": len(errors), "abbruch": True}, ensure_ascii=False))
        sys.exit(0)

    for it in items:
        s = series.get(it["sym"])
        if not s:
            continue
        try:
            it["a"] = analyse(it, s)
        except Exception as e:
            errors.append({"sym": it["sym"], "name": it["name"], "error": "Analyse: " + str(e)[:120]})

    stocks = [it["sym"] for it in items if it["group"] in STOCK_GROUPS and it["sym"] in series]
    mood_hist, comps = mood_history(series, stocks)
    mood_now = mood_hist[-1][1] if mood_hist else None
    mood_week = mood_hist[-6][1] if len(mood_hist) >= 6 else None
    mood_month = mood_hist[-22][1] if len(mood_hist) >= 22 else None

    report = build_report(items, mood_now, mood_week, mood_month, comps)

    # Marktbreite je Gruppe
    breadth = {}
    for g, _ in GROUPS:
        xs = [i["a"] for i in items if i["group"] == g and i.get("a")]
        if xs:
            breadth[g] = {"n": len(xs), "up_today": sum(1 for x in xs if (x["d1"] or 0) > 0),
                          "above200": sum(1 for x in xs if x["sma200"] and x["price"] > x["sma200"])}

    def pub(it):
        a_ = it.get("a")
        d = {k: it.get(k) for k in ("group", "sym", "name", "short", "kind", "ccy", "exchange", "time", "day") if it.get(k) is not None}
        if it.get("depot"):
            d["depot"] = True
        if a_:
            d["a"] = {k: (r2(v, 4 if k in ("price", "sma20", "sma50", "sma200", "hi52", "lo52", "range20_lo", "range20_hi", "d1_abs", "macd_hist") else 2)
                          if isinstance(v, float) else v) for k, v in a_.items()}
            c = series[it["sym"]]["c"]
            step = max(1, len(c[-66:]) // 40)
            d["spark"] = compact(c[-66:][::step])
        return d

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = {
        "app": "markt-radar", "version": 1, "generated_at": now, "source": "Yahoo Finance" if not a.fake else "Testdaten",
        "groups": [{"id": g, "label": lab} for g, lab in GROUPS if any(i["group"] == g for i in items)],
        "items": [pub(it) for it in items],
        "mood": {"value": mood_now, "label": mood_label(mood_now), "week": mood_week, "month": mood_month,
                 "components": [{"id": k, "label": MOOD_COMP[k][0], "desc": MOOD_COMP[k][1], "value": v} for k, v in comps.items()],
                 "history": mood_hist},
        "breadth": breadth,
        "report": report,
        "errors": errors,
    }
    ser = {"generated_at": now, "series": {}}
    for sym, s in series.items():
        # Datum als Start + Tagesabstaende, spart Platz
        t0 = dt.date.fromisoformat(s["t"][0])
        gaps, prev = [], t0
        for d in s["t"][1:]:
            dd = dt.date.fromisoformat(d)
            gaps.append((dd - prev).days); prev = dd
        ser["series"][sym] = {"t0": s["t"][0], "g": gaps, "c": compact(s["c"])}

    os.makedirs(a.out, exist_ok=True)
    # Unveraenderte Kurse (Wochenende, Feiertag): Zeitstempel behalten, damit kein leerer Commit entsteht
    if old and old.get("items") == out["items"] and old.get("mood") == out["mood"]:
        out["generated_at"] = old.get("generated_at", now)
        ser["generated_at"] = out["generated_at"]
    with open(os.path.join(a.out, "market.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(a.out, "market_series.json"), "w", encoding="utf-8") as f:
        json.dump(ser, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"ok": len(series), "items": len(items), "errors": errors[:10], "mood": mood_now}, ensure_ascii=False))


if __name__ == "__main__":
    main()
