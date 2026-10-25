"""Baut data/feed.json fuer die Web-App aus den Daten des Claude-Dashboards "Mein Portfolio".

Aufruf:
  python3 tools/build_feed.py --holdings DIR --quotes quotes.json --news news.json --out data/feed.json

Eingaben sind die Dateien, die ArtifactData mit out_dir ablegt (holdings/<id>.json, quotes/latest.json, news/latest.json).
Die Ausgabe ist oeffentlich. Sie enthaelt deshalb nur Namen, ISIN, Kurse und News, niemals Stueckzahlen oder Kaufpreise.
"""
import argparse, datetime as dt, json, os, sys

PUBLIC_HOLDING_FIELDS = ("name", "isin", "wkn")


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


def https(u):
    return u if isinstance(u, str) and u.startswith("https://") else None


def public_venue(r):
    v = r.get("eur_venue")
    if v and ("ING" in v or "Depot" in v):  # keine Hinweise auf die eigene Bank veroeffentlichen
        v = "Depotbewertung"
    return v or ("umgerechnet aus " + str(r.get("ccy")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdings", required=True)
    ap.add_argument("--quotes", required=True)
    ap.add_argument("--news")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    holdings = {}
    for fn in sorted(os.listdir(a.holdings)):
        if fn.endswith(".json"):
            h = load(os.path.join(a.holdings, fn), {})
            holdings[fn[:-5]] = h
    quotes = load(a.quotes, {}) or {}
    news = load(a.news, None)

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
            "local_price": r4(price), "local_ccy": r.get("ccy"),
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
        out_news = {
            "generated_at": news.get("generated_at"),
            "market": [item(x) for x in news.get("market", []) or [] if x.get("headline")],
            "positions": [{"id": k, "items": v} for k, v in groups.items() if k],
        }

    feed = {
        "app": "mein-portfolio-feed", "version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "quotes_at": quotes.get("fetched_at"),
        "quotes": out_quotes,
        "news": out_news,
    }
    # Unveraenderte Daten: alten Zeitstempel behalten, damit kein leerer Commit entsteht
    old = load(a.out, None)
    if isinstance(old, dict) and old.get("quotes") == feed["quotes"] and old.get("news") == feed["news"] and old.get("generated_at"):
        feed["generated_at"] = old["generated_at"]
    # Sicherheitsnetz: nichts Privates veroeffentlichen
    text = json.dumps(feed, ensure_ascii=False, indent=1)
    for banned in ('"qty"', '"cost_eur"', '"value_eur"', '"prev_value_eur"', '"pnl_1d_eur"', '"cost_note"'):
        if banned in text:
            sys.exit("Abbruch: privates Feld " + banned + " in feed.json")
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(json.dumps({"quotes": len(out_quotes), "news": bool(out_news), "quotes_at": feed["quotes_at"]}))


if __name__ == "__main__":
    main()
