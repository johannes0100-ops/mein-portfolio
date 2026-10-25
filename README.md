# Mein Portfolio

Kleine Depot-App fürs Handy und den Rechner. Sie zeigt Depotwert, Kaufpreise und „Seit Kauf“, holt mit Claude aktuelle Kurse und News und beantwortet Fragen zum Depot.

- Die Daten (Positionen, Kurse, Chat) bleiben im Browser des jeweiligen Geräts. In diesem Repository liegen keine Depotdaten.
- Kurse und News kommen automatisch aus `data/feed.json`. Die Datei schreibt eine geplante Claude-Aufgabe nach jedem Lauf des Claude-Dashboards. Sie enthält nur Namen, ISIN, Kurse und News, keine Stückzahlen oder Kaufpreise (`tools/build_feed.py`).
- Für den Chat und für eigene Suchen braucht die App einen Claude-API-Schlüssel aus der Claude Console. Er wird nur auf dem Gerät gespeichert.
- Installation: Seite öffnen, auf dem iPhone in Safari „Teilen“ und „Zum Home-Bildschirm“, auf Windows in Edge „…“, „Apps“, „Diese Website als App installieren“.

Gebaut als statische Web-App (HTML, JavaScript, Service Worker) und über GitHub Pages ausgeliefert.
