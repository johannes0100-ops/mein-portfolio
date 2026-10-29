"""Baut data/feed.json fuer die Web-App aus den Daten des Claude-Dashboards "Mein Portfolio".

Aufruf:
  python3 tools/build_feed.py --holdings DIR --quotes quotes.json --news news.json --calendar calendar.json --out data/feed.json

Eingaben sind die Dateien, die ArtifactData mit out_dir ablegt (holdings/<id>.json, quotes/latest.json, news/latest.json).
Die Ausgabe ist oeffentlich. Sie enthaelt deshalb nur Namen, ISIN, Kurse und News, niemals Stueckzahlen oder Kaufpreise.
"""
import argparse, datetime as dt, json, os, sys

PUBLIC_HOLDING_FIELDS = ("name", "isin", "wkn", "exchange", "gics", "gics_sector")


def load(path, default):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            txt = f.read().strip()
        if txt:
            d = json.loads(txt)
            # ArtifactData legt Dokumente teils als {id, data, version} ab
            if isinstance(d, dict) and "data" in d and isinstance(d["data"], dict) and "version" in d:
                d = d["data"]
            return d
    return default


def r4(v):
    return round(float(v), 4) if isinstance(v, (int, float)) else None


def nums(arr, limit=400):
    """Kursreihe fuer die Verlaufslinien, nur Zahlen."""
    if not isinstance(arr, list):
        return []
    return [round(float(x), 4) for x in arr[-limit:] if isinstance(x, (int, float))]


def https(u):
    return u if isinstance(u, str) and u.startswith("https://") else None


def public_venue(r):
    v = r.get("eur_venue")
    if v and ("ING" in v or "Depot" in v):  # keine Hinweise auf die eigene Bank veroeffentlichen
        v = "Depotbewertung"
    if v:
        return v
    if str(r.get("ccy") or "EUR").upper() == "EUR":
        return r.get("src") or "Kurs in EUR"
    return "umgerechnet aus " + str(r.get("ccy"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdings", required=True)
    ap.add_argument("--quotes", required=True)
    ap.add_argument("--news")
    ap.add_argument("--calendar")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    holdings = {}
    for fn in sorted(os.listdir(a.holdings)):
        if fn.endswith(".json"):
            h = load(os.path.join(a.holdings, fn), {})
            holdings[fn[:-5]] = h
    quotes = load(a.quotes, {}) or {}
    news = load(a.news, None)
    cal = load(a.calendar, None)

    out_quotes = {}
    for r in quotes.get("rows", []):
        hid = r.get("id")
        h = holdings.get(hid, {})
        price, fx = r.get("price"), r.get("fx_eur")
        if not isinstance(price, (int, float)) or not isinstance(fx, (int, float)):
            continue
        q = {k: h.get(k) for k in PUBLIC_HOLDING_FIELDS if h.get(k)}
        q.update({
            "eur_price": r4(price * fx),
            "prev_eur": r4(r["prev_close"] * fx) if isinstance(r.get("prev_close"), (int, float)) else None,
            "change_pct": r.get("d1"), "d5": r.get("d5"), "m1": r.get("m1"), "ytd": r.get("ytd"),
            "local_price": r4(price), "local_ccy": r.get("ccy"), "ticker": r.get("ticker") or h.get("ticker"),
            "gics_verified": h.get("gics_verified") if isinstance(h.get("gics_verified"), bool) else None,
            "fund": h.get("news") is False,
            "ytd_basis": r.get("ytd_basis"), "y1": r.get("y1"), "y1_basis": r.get("y1_basis"),
            "spark": nums(r.get("spark"), 30), "spark_1y": nums(r.get("spark_1y")), "spark_1y_start": r.get("spark_1y_start"),
            "venue": public_venue(r),
            "as_of": quotes.get("fetched_at"), "trading_day": r.get("as_of"),
            "source": r.get("src"), "url": https(r.get("src_url")),
        })
        out_quotes[hid] = q

    out_news = None
    if isinstance(news, dict):
        def item(x):
            return {"headline": x.get("headline"), "summary": x.get("summary"), "source": x.get("source"),
                    "url": https(x.get("url")), "published_at": x.get("published_at"), "kind": "news"}
        groups = {}
        for g in news.get("positions", []) or []:
            groups.setdefault(g.get("id"), []).extend(item(x) for x in g.get("items", []) if x.get("headline"))
        for s in news.get("sell_side", []) or []:
            broker, action = s.get("broker") or "Analyst", s.get("action") or ""
            groups.setdefault(s.get("stock"), []).append({
                "headline": (broker + ": " + action).strip(": "), "summary": s.get("summary"), "source": s.get("source"),
                "url": https(s.get("url")), "published_at": s.get("published_at"), "kind": "analyst",
                "rating": s.get("rating"), "target": s.get("target")})
        def rail(x):
            d = item(x)
            d.update({"tickers": [t for t in (x.get("tickers") or []) if isinstance(t, str)][:6],
                      "peer": x.get("peer"), "popularity": x.get("popularity"), "label": x.get("label")})
            return d
        def ss(s):
            return dict({k: s.get(k) for k in ("stock", "broker", "action", "rating", "target", "summary", "source", "published_at")}, url=https(s.get("url")))
        out_news = {
            "generated_at": news.get("generated_at"),
            "market": [rail(x) for x in news.get("market", []) or [] if x.get("headline")],
            "positions": [{"id": k, "items": v} for k, v in groups.items() if k],
            "sell_side": [ss(s) for s in news.get("sell_side", []) or [] if isinstance(s, dict) and s.get("broker")],
            "popular": [rail(x) for x in news.get("popular", []) or [] if x.get("headline")],
            "sector": [rail(x) for x in news.get("sector", []) or [] if x.get("headline")],
            "peers": [rail(x) for x in news.get("peers", []) or [] if x.get("headline")],
        }

    out_cal = None
    if isinstance(cal, dict):
        today = dt.datetime.now(dt.timezone(dt.timedelta(hours=1))).date().isoformat()
        evs = []
        for e in cal.get("events", []) or []:
            if not isinstance(e, dict) or not e.get("date") or not e.get("title") or str(e["date"]) < today:
                continue
            evs.append({k: e.get(k) for k in ("date", "time", "title", "type", "region", "holding", "note", "confirmed")})
            evs[-1]["url"] = https(e.get("url"))
        evs.sort(key=lambda e: (e["date"], e.get("time") or "99"))
        out_cal = {"events": evs[:40]}

    feed = {
        "app": "mein-portfolio-feed", "version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "quotes_at": quotes.get("fetched_at"),
        "web_at": quotes.get("web_at"), "live_at": quotes.get("live_at"),
        "notes": quotes.get("source_note"),
        "errors": [{"id": e.get("id"), "input": e.get("input"), "error": e.get("error")} for e in quotes.get("errors", []) or [] if isinstance(e, dict)],
        "quotes": out_quotes,
        "news": out_news,
        "calendar": out_cal,
    }
    # Unveraenderte Daten: alten Zeitstempel behalten, damit kein leerer Commit entsteht
    old = load(a.out, None)
    same = all(old.get(k) == feed[k] for k in ("quotes", "news", "calendar", "notes", "errors")) if isinstance(old, dict) else False
    if same and old.get("generated_at"):
        feed["generated_at"] = old["generated_at"]
    # Sicherheitsnetz: nichts Privates veroeffentlichen
    text = json.dumps(feed, ensure_ascii=False, indent=1)
    for banned in ('"qty"', '"cost_eur"', '"value_eur"', '"prev_value_eur"', '"pnl_1d_eur"', '"cost_note"'):
        if banned in text:
            sys.exit("Abbruch: privates Feld " + banned + " in feed.json")
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(json.dumps({"quotes": len(out_quotes), "news": bool(out_news), "events": len((out_cal or {}).get("events", [])), "quotes_at": feed["quotes_at"]}))


if __name__ == "__main__":
    main()
