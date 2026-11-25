# Mein Portfolio

Kleine Depot-App fürs Handy und den Rechner. Sie zeigt Depotwert, Kaufpreise und „Seit Kauf“, holt mit Claude aktuelle Kurse und News und beantwortet Fragen zum Depot.

- Die Daten (Positionen, Kurse, Chat) bleiben im Browser des jeweiligen Geräts. In diesem Repository liegen keine Depotdaten.
- Kurse und News kommen automatisch aus `data/feed.json`. Die Datei schreibt eine geplante Claude-Aufgabe nach jedem Lauf des Claude-Dashboards. Sie enthält nur Namen, ISIN, Kurse und News, keine Stückzahlen oder Kaufpreise (`tools/build_feed.py`).
- Für den Chat und für eigene Suchen braucht die App einen Claude-API-Schlüssel aus der Claude Console. Er wird nur auf dem Gerät gespeichert.
- Installation: Seite öffnen, auf dem iPhone in Safari „Teilen“ und „Zum Home-Bildschirm“, auf Windows in Edge „…“, „Apps“, „Diese Website als App installieren“.

Gebaut als statische Web-App (HTML, JavaScript, Service Worker) und über GitHub Pages ausgeliefert.

## Markt-Radar (`markt.html`)

Täglicher Marktüberblick mit automatischer Analyse in einfacher Sprache, erreichbar über den Knopf „Markt-Radar“ in der App.

- **Heute:** Markt in 30 Sekunden, Stimmungsbarometer (Angst bis Gier, mit Verlauf über ein Jahr), große Indizes mit Trend-Ampel, Wärmekarte aller Aktien, Gewinner, Verlierer, Branchen, Gold/Öl/Krypto/Währungen/Zinsen, automatischer Tagesbericht, Auffälligkeiten (Jahreshochs, 200-Tage-Linie, Golden/Death Cross, RSI-Extreme, ungewöhnliche Bewegungen), Termine.
- **Alle Werte:** über 80 Werte plus die eigenen Depotwerte, Suche, Filter, Sortierung, Favoriten.
- **Detail je Wert:** Ampel mit Klartext, Chart mit 20/50/200-Tage-Linien und Bollinger-Band, RSI, Kennzahlen mit Erklärung, Signale, „Was wäre, wenn“-Rechner (Einmalanlage und Sparplan).
- **Vergleichen, Kurs-Wecker, KI fragen** (nutzt den Claude-Schlüssel der App), **Lexikon** mit allen Begriffen.
- Daten: `tools/market.py` holt Kurse von Yahoo Finance und schreibt `data/market.json` und `data/market_series.json`. Die GitHub Action `.github/workflows/markt.yml` läuft werktags stündlich und am Wochenende zweimal. Test ohne Internet: `python3 tools/market.py --fake --out /tmp/markt`.
- Keine Anlageberatung: alle Signale sind automatische Beobachtungen vergangener Kurse.
