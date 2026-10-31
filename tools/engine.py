"""Kurs-Engine fuer das Dashboard "Mein Portfolio" (Version 5: wie Version 4, dazu Live-Kurse von Tradegate fuer Depotwert und Tagesveraenderung).

Aufruf:
  python3 engine.py --holdings holdings.json [--history history.json] --old old_quotes.json \
                    [--obs obs.json] [--live live.json] [--no-yahoo] --out OUTDIR

Eingaben
  holdings.json  Liste der Positionen [{id, ticker, input, name, qty, ...}]
  history.json   Dokument history/all ({"series": {id: {"YYYY-MM-DD": kurs}}, "meta": {...}}) oder {}
  old_quotes.json  bisheriges quotes/latest oder {}
  obs.json       optional, Web-Beobachtungen:
                 {"fx": {"USD": EUR je USD, "GBP": EUR je GBP},
                  "items": [{"id", "price", "prev_close", "ccy", "as_of",
                             "d5"?, "m1"?, "ytd"?, "y1"?, "prev_year_close"?, "source", "url"}]}
  live.json      optional, data/live.json aus dem Repository der Web-App (Tradegate, alle 15 Minuten):
                 {"updated_at", "quotes": {id: {"isin", "eur" (Geldkurs), "d1", "stale"?}}}
                 Setzt Depotwert (Geldkurs wie bei der Bank) und Tagesveraenderung. Kurs in Handelswaehrung,
                 Historie, 5T, 1M und YTD bleiben aus Yahoo oder den Web-Beobachtungen.

Ablauf
  1. Yahoo (yfinance) wird versucht, wenn erreichbar. Ergebnisse landen in OUTDIR/yahoo_cache.json.
  2. Fuer Positionen ohne Yahoo-Kurs werden Web-Beobachtungen aus obs.json genutzt.
  3. Fehlt beides, bleibt die alte Zeile stehen. Ein Hinweis in "errors" kommt nur bei wirklich veralteten Kursen.
  4. Danach ueberschreibt ein Live-Kurs (falls vorhanden und nicht aelter als der Kurs) die Euro-Bewertung.

Ausgaben in OUTDIR
  quotes.json   neues quotes/latest
  history.json  neues history/all
  missing.json  Liste der ids, fuer die noch Web-Kurse gebraucht werden (leer = alles da)
"""
import argparse, datetime as dt, json, os, sys, urllib.request

TODAY = dt.date.today()


def load(path, default):
    if path and os.path.exists(path):
        with open(path) as f:
            txt = f.read().strip()
        if txt:
            return json.loads(txt)
    return default


def pct(a, b):
    try:
        return round((float(a) / float(b) - 1) * 100, 2) if b else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace(" ", "").replace("%", "").replace("+", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


# ---------- Yahoo ----------

def yahoo_reachable():
    try:
        req = urllib.request.Request("https://query2.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d",
                                     headers={"User-Agent": "Mozilla/5.0"})
        urllib.request.urlopen(req, timeout=8).read(100)
        return True
    except Exception as e:  # 403 am Proxy, Timeout, DNS
        code = getattr(e, "code", None)
        return code in (401, 429)  # Host erreichbar, nur Anfrage abgelehnt


def fetch_yahoo(holdings):
    import yfinance as yf
    fx_cache = {}

    def fx_to_eur(ccy):
        if ccy in fx_cache:
            return fx_cache[ccy]
        if ccy == "EUR":
            r = 1.0
        elif ccy in ("GBp", "GBX"):
            r = fx_to_eur("GBP") / 100
        elif ccy == "ILA":
            r = fx_to_eur("ILS") / 100
        else:
            r = float(yf.Ticker(f"{ccy}EUR=X").history(period="5d")["Close"].dropna().iloc[-1])
        fx_cache[ccy] = r
        return r

    out = {}
    for h in holdings:
        sym = h.get("ticker") or h.get("input")
        try:
            t = yf.Ticker(sym)
            full = t.history(period="13mo")["Close"].dropna()
            if full.empty:
                raise ValueError("keine Kurse bei Yahoo")
            fi = t.fast_info
            ccy = fi.get("currency") or "EUR"
            price = float(fi.get("lastPrice") or full.iloc[-1])
            series = {f"{i:%Y-%m-%d}": round(float(v), 4) for i, v in full.items()}
            series[f"{full.index[-1]:%Y-%m-%d}"] = round(price, 4)
            out[h["id"]] = {"ticker": sym, "ccy": "GBX" if ccy == "GBp" else ccy, "fx_eur": round(fx_to_eur(ccy), 6),
                            "series": series, "source": "Yahoo Finance",
                            "url": f"https://finance.yahoo.com/quote/{sym}"}
        except Exception as e:
            out[h["id"]] = {"error": str(e)[:200]}
    return out


# ---------- Zeilen bauen ----------

def _d(s):
    return dt.date.fromisoformat(s)


def _minus_month(d):
    y, m = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    for day in (d.day, 30, 29, 28):
        try:
            return dt.date(y, m, day)
        except ValueError:
            continue


def _base_near(pts, target, before_days, after_days):
    """Letzter Punkt am oder vor target (hoechstens before_days davor), sonst erster danach (hoechstens after_days)."""
    lo, hi = target - dt.timedelta(days=before_days), target + dt.timedelta(days=after_days)
    prior = [(d, v) for d, v in pts if lo <= _d(d) <= target]
    if prior:
        return prior[-1]
    later = [(d, v) for d, v in pts if target < _d(d) <= hi]
    return later[0] if later else None


def _grid(pts, start, end):
    """Kurs je Handelstag (Mo bis Fr) von start bis end, zwischen bekannten Kursen zeitlich linear verbunden."""
    known = [(_d(d), v) for d, v in pts]
    out, i, day = [], 0, start
    while day <= end:
        if day.weekday() < 5:
            while i + 1 < len(known) and known[i + 1][0] <= day:
                i += 1
            d0, v0 = known[i]
            if i + 1 < len(known) and d0 < day:
                d1, v1 = known[i + 1]
                v = v0 + (v1 - v0) * (day - d0).days / (d1 - d0).days
            else:
                v = v0
            out.append(round(v, 4))
        day += dt.timedelta(days=1)
    return out


def build_row(h, series, meta, ob, ccy, fx, ticker, source, url):
    dates = sorted(series)
    vals = [series[d] for d in dates]
    price = float(ob["price"]) if ob and ob.get("price") is not None else (vals[-1] if vals else None)
    if price is None:
        raise ValueError("kein Kurs")
    as_of = (ob or {}).get("as_of") or (dates[-1] if dates else TODAY.isoformat())
    asd = _d(as_of)
    before = [series[d] for d in dates if d < as_of]
    prev = num((ob or {}).get("prev_close")) if ob and ob.get("prev_close") is not None else (before[-1] if before else None)

    # bis inklusive as_of; der aktuelle Kurs zaehlt als Schluss von as_of
    upto = [d for d in dates if d <= as_of]
    pts = [(d, series[d]) for d in upto]
    if pts and pts[-1][0] == as_of:
        pts[-1] = (as_of, price)
    else:
        pts.append((as_of, price))
    closes = [v for _, v in pts]
    n = len(closes)

    # 5 Handelstage: nur aus taeglichen Kursen der letzten 12 Kalendertage
    if n >= 6 and _d(pts[-6][0]) >= asd - dt.timedelta(days=12):
        d5 = pct(price, closes[-6])
    else:
        d5 = num((ob or {}).get("d5"))

    # 1 Monat: Kurs am gleichen Tag des Vormonats (oder kurz davor/danach)
    b = _base_near(pts[:-1], _minus_month(asd), 6, 3)
    m1 = pct(price, b[1]) if b else num((ob or {}).get("m1"))

    year = int(as_of[:4])
    prior = [v for d, v in pts if int(d[:4]) < year]
    pyc = (meta.get("prev_year_close") or {})
    if prior:
        ytd, basis = pct(price, prior[-1]), "Schluss Vorjahr"
    elif pyc.get("year") == year - 1 and pyc.get("close"):
        ytd, basis = pct(price, pyc["close"]), "Schluss Vorjahr"
    elif ob and ob.get("ytd") is not None:
        ytd, basis = num(ob.get("ytd")), "Schluss Vorjahr (laut Quelle)"
    elif n >= 2:
        ytd, basis = pct(price, closes[0]), f"seit {pts[0][0][8:10]}.{pts[0][0][5:7]}.{pts[0][0][:4]}"
    else:
        ytd, basis = None, "keine Historie"

    # Kursverlauf 1 Jahr als Tagesraster (Mo bis Fr), damit Monatsschluesse und Tageskurse gleichmaessig verteilt sind.
    # 1J-Wert = Veraenderung ueber genau diesen Verlauf. Reicht er nicht ein Jahr zurueck, zeigt die Seite "seit <Start>".
    cut = asd - dt.timedelta(days=365)
    ypts = [(d, v) for d, v in pts if _d(d) >= cut]
    older = [(d, v) for d, v in pts if _d(d) < cut]
    y1_ref = ypts[0] if ypts else None
    if older and ypts and _d(ypts[0][0]) > cut and (_d(ypts[0][0]) - _d(older[-1][0])).days <= 45:
        # Ein Jahr faellt zwischen zwei Monatsschluesse: Verlauf ab genau einem Jahr, 1J-Wert gegen den naeheren echten Kurs
        y1_ref = min((older[-1], ypts[0]), key=lambda p: abs((_d(p[0]) - cut).days))
        ypts = [(cut.isoformat(), _grid([older[-1], ypts[0]], cut, cut)[0] if cut.weekday() < 5 else older[-1][1])] + ypts
    spark_1y = _grid(ypts, _d(ypts[0][0]), asd) if len(ypts) >= 2 else []
    if len(spark_1y) < 5:
        spark_1y = []
    y1_start = ypts[0][0] if spark_1y else None
    if spark_1y:
        y1 = pct(price, y1_ref[1])
        full = (asd - _d(y1_start)).days >= 358
        y1_basis = "1 Jahr" + ("" if y1_ref[0] == y1_start else " (gegen Schluss " + y1_ref[0] + ")") if full else "seit " + y1_start
        # Die Seite schreibt ab 240 Punkten "1 Jahr". Kuerzere Verlaeufe ausduennen, damit dort "seit <Start>" steht.
        if not full and len(spark_1y) >= 240:
            spark_1y = spark_1y[::-2][::-1]
    else:
        y1, y1_basis = num((ob or {}).get("y1")), "laut Quelle"

    # 22 Handelstage, nur Tageskurse der letzten 45 Kalendertage
    recent = [v for d, v in pts if _d(d) >= asd - dt.timedelta(days=45)][-22:]

    qty = float(h.get("qty") or 0)
    base = prev if prev is not None else price
    return {
        "id": h["id"], "ticker": ticker, "name": h.get("name") or ticker, "qty": qty, "ccy": ccy,
        "price": round(price, 4), "prev_close": round(base, 4),
        "d1": pct(price, prev) if prev else None, "d5": d5, "m1": m1,
        "ytd": ytd, "ytd_basis": basis, "y1": y1, "y1_basis": y1_basis,
        "fx_eur": round(fx, 6),
        "value_eur": round(qty * price * fx, 2), "prev_value_eur": round(qty * base * fx, 2),
        "pnl_1d_eur": round(qty * (price - base) * fx, 2),
        "as_of": as_of,
        "spark": [round(v, 4) for v in recent] if len(recent) >= 5 else [],
        "spark_1y": spark_1y,
        "spark_1y_start": y1_start,
        "src": source, "src_url": url,
    }


def apply_eur_price(row, ob, fx):
    """Bewertung in Euro wie im Depot der Bank: Kurs an einem deutschen Boersenplatz (eur_price).
    Performance bleibt in Handelswaehrung. Der Euro-Kurs darf hoechstens 5 % vom umgerechneten Marktkurs abweichen."""
    eur = num((ob or {}).get("eur_price"))
    if not eur or not row.get("price"):
        return
    k = eur / row["price"]
    if not fx or abs(k / fx - 1) > 0.05:
        row["eur_price_rejected"] = eur
        return
    q, base = row["qty"], row["prev_close"]
    row.update({"fx_market": row["fx_eur"], "fx_eur": round(k, 8), "eur_price": round(eur, 4),
                "eur_venue": (ob or {}).get("eur_venue"),
                "value_eur": round(q * eur, 2), "prev_value_eur": round(q * base * k, 2),
                "pnl_1d_eur": round(q * (row["price"] - base) * k, 2)})


def expected_trading_day():
    """Handelstag, von dem ein Kurs mindestens sein sollte (deutsche Zeit, Mo bis Fr, ohne Feiertage).
    Vor 9 Uhr und am Wochenende gilt der letzte Handelstag davor."""
    try:
        from zoneinfo import ZoneInfo
        now = dt.datetime.now(ZoneInfo("Europe/Berlin"))
    except Exception:
        now = dt.datetime.now(dt.timezone(dt.timedelta(hours=1)))
    d = now.date()
    if now.hour < 9:
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def prev_trading_day(iso):
    d = dt.date.fromisoformat(iso) - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def berlin_date(iso_ts):
    try:
        t = dt.datetime.fromisoformat(str(iso_ts).replace("Z", "+00:00"))
        try:
            from zoneinfo import ZoneInfo
            return t.astimezone(ZoneInfo("Europe/Berlin")).date().isoformat()
        except Exception:
            return t.astimezone(dt.timezone(dt.timedelta(hours=1))).date().isoformat()
    except Exception:
        return None


def apply_live(row, L, live_day, live_at):
    """Depotwert zum Tradegate-Geldkurs, Tagesveraenderung laut Tradegate. Kurs und Historie in Handelswaehrung bleiben.
    Damit die Seite (Wert = Stueck * Kurs * fx_eur, Vortag = Stueck * prev_close * fx_eur) richtig rechnet,
    wird fx_eur zum Depot-Faktor und prev_close auf den Vortageswert umgerechnet. Die Marktwerte bleiben in fx_market und prev_close_market."""
    eur = num((L or {}).get("eur"))
    if not eur or eur <= 0 or not row.get("price") or (L or {}).get("stale"):
        return False
    if live_day and str(row.get("as_of") or "") > live_day:  # Webkurs ist neuer als die Live-Datei
        return False
    fx_m = float(row.get("fx_market") or row.get("fx_eur") or 0)
    k = eur / row["price"]
    if not fx_m or abs(k / fx_m - 1) > 0.08:  # passt nicht zum Marktkurs (falsche ISIN, Kurssprung)
        row["live_rejected"] = eur
        return False
    pm = float(row.get("prev_close_market") or row.get("prev_close") or row["price"])
    d1 = num(L.get("d1"))
    eur_prev = eur / (1 + d1 / 100) if d1 is not None and d1 > -99 else pm * k
    q = float(row.get("qty") or 0)
    row.update({
        "fx_market": round(fx_m, 8), "fx_eur": round(k, 8), "eur_price": round(eur, 4), "eur_venue": "Tradegate (Geldkurs)",
        "prev_close_market": round(pm, 4), "prev_close": round(eur_prev / k, 4),
        "d1": round(d1, 2) if d1 is not None else pct(eur, eur_prev),
        "value_eur": round(q * eur, 2), "prev_value_eur": round(q * eur_prev, 2), "pnl_1d_eur": round(q * (eur - eur_prev), 2),
        "live_at": live_at,
    })
    row.pop("live_rejected", None)
    if live_day and str(row.get("as_of") or "") < live_day:
        row["as_of"] = live_day
    return True


def fx_for(ccy, fxobs, old_rows):
    c = (ccy or "EUR").upper()
    if c == "EUR":
        return 1.0
    if c in ("GBX", "GBP"):
        g = num(fxobs.get("GBP"))
        if g:
            return g / 100 if c == "GBX" else g
    else:
        v = num(fxobs.get(c))
        if v:
            return v
    for r in old_rows.values():
        if (r.get("ccy") or "").upper() == c and (r.get("fx_market") or r.get("fx_eur")):
            return float(r.get("fx_market") or r["fx_eur"])
    raise ValueError(f"kein Wechselkurs fuer {c}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdings", required=True)
    ap.add_argument("--history")
    ap.add_argument("--old", required=True)
    ap.add_argument("--obs")
    ap.add_argument("--live")
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-yahoo", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    if os.path.isdir(a.holdings):  # Ordner aus ArtifactData list mit out_dir: <id>.json je Position
        holdings = [dict(load(os.path.join(a.holdings, f), {}), id=f[:-5])
                    for f in sorted(os.listdir(a.holdings)) if f.endswith(".json")]
    else:
        holdings = load(a.holdings, [])
    if isinstance(holdings, dict):  # {"docs": [...]} oder {id: {...}}
        holdings = holdings.get("docs") or [dict(v, id=k) for k, v in holdings.items()]
    hist = load(a.history, {}) or {}
    series_all = hist.get("series") or {}
    meta_all = hist.get("meta") or {}
    old = load(a.old, {}) or {}
    old_rows = {r["id"]: r for r in old.get("rows", [])}
    obs = load(a.obs, {}) or {}
    fxobs = obs.get("fx") or {}
    obs_items = {o["id"]: o for o in obs.get("items", []) if o.get("id")}
    live = load(a.live, {}) or {}
    live_q = live.get("quotes") if isinstance(live.get("quotes"), dict) else {}
    live_by_isin = {v.get("isin"): v for v in live_q.values() if isinstance(v, dict) and v.get("isin")}
    live_at = live.get("updated_at")
    live_day = berlin_date(live_at) if live_at else None

    cache_path = os.path.join(a.out, "yahoo_cache.json")
    yahoo = load(cache_path, None)
    if yahoo is None:
        yahoo = {}
        if not a.no_yahoo and yahoo_reachable():
            try:
                yahoo = fetch_yahoo(holdings)
            except Exception as e:
                print("Yahoo-Fehler:", e, file=sys.stderr)
        json.dump(yahoo, open(cache_path, "w"))

    rows, errors, missing, used = [], [], [], set()
    for h in holdings:
        hid = h["id"]
        series = dict(series_all.get(hid) or {})
        meta = dict(meta_all.get(hid) or {})
        y = yahoo.get(hid) or {}
        ob = obs_items.get(hid)
        try:
            if y.get("series"):
                series.update(y["series"])
                row = build_row(h, series, meta, None, y["ccy"], y["fx_eur"], y["ticker"], y["source"], y["url"])
                used.add("yahoo")
            elif ob and num(ob.get("price")) is not None:
                ob = dict(ob, price=num(ob["price"]))
                if not ob.get("as_of"):
                    ob["as_of"] = TODAY.isoformat()
                ccy = str(ob.get("ccy") or (old_rows.get(hid) or {}).get("ccy") or "EUR").strip()
                ccy = "GBX" if ccy in ("GBp", "GBX", "GBx", "p", "Pence") else ccy.upper()
                fx = fx_for(ccy, fxobs, old_rows)
                series[ob["as_of"]] = round(ob["price"], 4)
                pyc = num(ob.get("prev_year_close"))
                if pyc:
                    meta["prev_year_close"] = {"year": int(ob["as_of"][:4]) - 1, "close": pyc}
                row = build_row(h, series, meta, ob, ccy, fx, h.get("ticker") or h.get("input"),
                                ob.get("source") or "Web", ob.get("url"))
                apply_eur_price(row, ob, fx)
                used.add("web")
            else:
                missing.append(hid)
                if hid in old_rows:
                    r = dict(old_rows[hid])
                    q = float(h.get("qty") or 0)
                    r["qty"] = q
                    r["value_eur"] = round(q * r["price"] * r["fx_eur"], 2)
                    r["prev_value_eur"] = round(q * r["prev_close"] * r["fx_eur"], 2)
                    rows.append(r)
                else:
                    errors.append({"id": hid, "input": h.get("name") or hid, "error": "noch kein Kurs gefunden"})
                continue
            rows.append(row)
            # Historie pflegen (max. 400 Tage)
            cut = (TODAY - dt.timedelta(days=400)).isoformat()
            series_all[hid] = {d: v for d, v in sorted(series.items()) if d >= cut}
            meta_all[hid] = meta
        except Exception as e:
            missing.append(hid)
            errors.append({"id": hid, "input": h.get("name") or hid, "error": str(e)[:200]})
            if hid in old_rows:
                rows.append(old_rows[hid])

    # Live-Kurse (Tradegate-Geldkurs) fuer den Depotwert
    hold_by_id = {h["id"]: h for h in holdings}
    live_used = 0
    for r in rows:
        h = hold_by_id.get(r["id"], {})
        L = live_q.get(r["id"]) or live_by_isin.get(h.get("isin"))
        if L and apply_live(r, L, live_day, live_at):
            live_used += 1
    # Warnung nur bei wirklich veralteten Kursen. Ohne Live-Kurs (z. B. Fonds mit Tagespreis) ist ein Tag Verzug normal.
    exp = expected_trading_day()
    err_ids = {e["id"] for e in errors}
    for r in rows:
        if r["id"] in err_ids:
            continue
        limit = exp if r.get("live_at") else prev_trading_day(exp)
        if str(r.get("as_of") or "") < limit:
            h = hold_by_id.get(r["id"], {})
            errors.append({"id": r["id"], "input": h.get("name") or r["id"], "error": f"nicht aktualisiert, Kurs vom {r.get('as_of')}"})

    src = "yahoo" if used == {"yahoo"} else "web" if used == {"web"} else "gemischt" if used else "keine"
    if live_used and src == "keine":
        src = "live"
    note = None
    if "web" in used or live_used:
        parts = []
        if live_used:
            parts.append("Depotwert und Tagesveränderung zum Tradegate-Geldkurs wie im Depot (alle 15 Minuten).")
        if "web" in used:
            parts.append("Kurse in Handelswährung und 5T, 1M, YTD aus Webquellen, teils verzögert.")
        if any((m or {}).get("sparse_before") for m in meta_all.values()):
            parts.append("Ältere Teile der Kursverläufe aus Monatsschlusskursen.")
        if any(r.get("eur_price") and not r.get("live_at") for r in rows):
            parts.append("Ohne Live-Kurs: Wert in Euro zum Kurs an einem deutschen Börsenplatz oder zum Fondspreis.")
        if any(r.get("d5") is None or r.get("m1") is None for r in rows):
            parts.append("Fehlende 5T- und 1M-Werte entstehen, sobald genug Tageskurse gesammelt sind.")
        note = " ".join(parts)
    quotes = {"rows": rows, "errors": errors, "source": src,
              "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    if note:
        quotes["source_note"] = note
    elif old.get("source_note"):
        quotes["source_note"] = old["source_note"]
    if live_used:
        quotes["live_at"] = live_at
    # Zeitpunkt des letzten Webabrufs (5T, 1M, YTD) merken
    quotes["web_at"] = quotes["fetched_at"] if used else old.get("web_at") or old.get("fetched_at")
    history = {"series": series_all, "meta": meta_all,
               "updated_at": quotes["fetched_at"]}
    json.dump(quotes, open(os.path.join(a.out, "quotes.json"), "w"), ensure_ascii=False, indent=1)
    if a.history:  # ohne --history (Live-Lauf) keine Historie schreiben, damit nichts leer hochgeladen wird
        json.dump(history, open(os.path.join(a.out, "history.json"), "w"), ensure_ascii=False)
    json.dump(missing, open(os.path.join(a.out, "missing.json"), "w"))
    print(json.dumps({"source": src, "rows": len(rows), "live": live_used, "live_at": live_at, "missing": missing, "errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main()
