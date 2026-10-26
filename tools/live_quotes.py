"""Holt aktuelle Euro-Kurse von Tradegate fuer alle Positionen aus data/feed.json und schreibt data/live.json.

Laeuft als GitHub Action alle 15 Minuten (siehe .github/workflows/live-kurse.yml), braucht nur die Python-Standardbibliothek.
Die Datei ist oeffentlich und enthaelt nur ISIN und Kurse, keine Stueckzahlen oder Kaufpreise.

Aufruf: python3 tools/live_quotes.py --feed data/feed.json --out data/live.json
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request

URL = "https://www.tradegate.de/refresh.php?isin={isin}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "de-DE,de;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
}
# Welcher Kurs als Depotwert gilt. Die ING bewertet mit einem eigenen Kurs, der dem Geldkurs am naechsten kommt.
PRICE_FIELD = "bid"
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")


def num(v):
    """Zahl aus Tradegate-Feldern: 57.58, "57,58", "1.234,56", "+0,65 %"."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(" ", "").replace(" ", "").replace("%", "").replace("EUR", "")
    if not s or s in ("-", "--", "n.a.", "N/A"):
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def fetch(isin):
    req = urllib.request.Request(URL.format(isin=isin), headers=dict(HEADERS, Referer="https://www.tradegate.de/orderbuch.php?isin=" + isin))
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode("utf-8", "replace").strip()
    d = json.loads(body)
    if not isinstance(d, dict):
        raise ValueError("unerwartete Antwort")
    low = {str(k).lower(): v for k, v in d.items()}
    q = {
        "bid": num(low.get("bid")), "ask": num(low.get("ask")), "last": num(low.get("last")),
        "prev_close": num(low.get("close")), "high": num(low.get("high")), "low": num(low.get("low")),
        "delta_pct": num(low.get("delta")), "trades": num(low.get("executions")),
    }
    q = {k: v for k, v in q.items() if v is not None and v > -1e9}
    if not any(q.get(k) for k in ("bid", "ask", "last")):
        raise ValueError("kein Kurs in der Antwort (Felder: " + ", ".join(sorted(low))[:150] + ")")
    return q


def pick(q):
    """Depotkurs: Geldkurs, sonst Mitte aus Geld/Brief, sonst letzter Kurs."""
    p = q.get(PRICE_FIELD)
    if p:
        return p, PRICE_FIELD
    if q.get("bid") and q.get("ask"):
        return round((q["bid"] + q["ask"]) / 2, 4), "mid"
    return q.get("last"), "last"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--feed", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    feed = json.load(open(a.feed, encoding="utf-8"))
    old = {}
    if os.path.exists(a.out):
        try:
            old = json.load(open(a.out, encoding="utf-8"))
        except Exception:
            old = {}
    items = [(k, v.get("isin")) for k, v in (feed.get("quotes") or {}).items() if ISIN_RE.match(str(v.get("isin") or ""))]

    quotes, errors = {}, []
    for hid, isin in items:
        try:
            q = fetch(isin)
            p, used = pick(q)
            q.update({"isin": isin, "eur": round(p, 4), "eur_field": used})
            # Tagesveraenderung wie in der Bank-App: letzter Kurs gegen Schluss des Vortags (Tradegate-Angabe)
            if q.get("delta_pct") is not None:
                q["d1"] = round(q["delta_pct"], 2)
            elif q.get("prev_close") and q.get("last"):
                q["d1"] = round((q["last"] / q["prev_close"] - 1) * 100, 2)
            quotes[hid] = q
        except Exception as e:  # nicht gefunden (z. B. Fonds ohne Boersenhandel) oder Netzfehler: alten Kurs behalten
            errors.append({"id": hid, "isin": isin, "error": str(e)[:160]})
            if hid in (old.get("quotes") or {}):
                quotes[hid] = dict(old["quotes"][hid], stale=True)
        time.sleep(0.4)

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    changed = quotes != (old.get("quotes") or {}) or errors != (old.get("errors") or [])
    out = {
        "app": "mein-portfolio-live", "version": 1, "source": "Tradegate", "price_field": PRICE_FIELD,
        "updated_at": now if changed or not old.get("updated_at") else old["updated_at"],
        "quotes": quotes, "errors": errors,
    }
    text = json.dumps(out, ensure_ascii=False, indent=1)
    for banned in ('"qty"', '"cost_eur"', '"value_eur"'):
        if banned in text:
            sys.exit("Abbruch: privates Feld " + banned)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    # Kein Fehler-Exit: Probleme stehen in "errors", damit GitHub keine Fehler-Mails schickt
    print(json.dumps({"ok": len(quotes) - sum(1 for q in quotes.values() if q.get("stale")), "errors": errors, "changed": changed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
