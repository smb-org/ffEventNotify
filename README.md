# ffEventNotify

Ein Discord-Bot für deutsche FINAL FANTASY XIV-Events. Er soll Lodestone-Meldungen erkennen, als Embed veröffentlichen, passende Discord-Events anlegen und Belohnungs-Checklisten sowie Erinnerungen verwalten.

## Einrichtung

1. Eine Discord-Anwendung anlegen und den Bot mit den unten aufgeführten Rechten einladen. Der Bot ist öffentlich und kann auf mehreren Servern verwendet werden.
2. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN`, `WEB_BASE_URL` und `WEB_LINK_SECRET` eintragen (`pnpm gen-secret` erzeugt das Secret). `WEB_PORT` (Standard 3480), `DB_PATH`, `FIXTURE_DUMP_DIR` und `LOG_LEVEL` sind optional; Server- und Kanal-IDs werden nicht in der `.env` gespeichert.
3. Mit `docker compose up -d` starten. SQLite-Daten werden in `./data` gespeichert.
4. Auf jedem Server `/ffevents setup` ausführen und **Event-Kanal** sowie **Log-Kanal** wählen. Dafür ist „Server verwalten“ nötig. Der Bot prüft seine Rechte, speichert die Kanäle und startet direkt den Erstabgleich für diesen Server.

Wer laufende Events links in der Kanalliste sehen möchte, aktiviert die Schaltfläche **„Alle Events in meiner Seitenleiste“** im angehefteten Beitrag **„Läuft gerade“** oder nutzt `/ffevents folgen status:an`. Mit `/ffevents folgen status:aus` lässt sich die Anzeige wieder ausschalten.

Mit `/ffevents abgleichen` (ebenfalls „Server verwalten“) startest du sofort einen Abgleich, begrenzt auf einmal je 10 Minuten und Server. `LOG_LEVEL=debug` in der `.env` zeigt jede Anfrage im Log.

## Web-Checkliste

Die Schaltfläche **„Meine Checkliste“** am Event-Beitrag antwortet nur dir mit einem persönlichen Link. Die Seite zeigt alle laufenden und angekündigten Events mit ihren Belohnungen (beendete Events der letzten 60 Tage im Archiv). Du legst bis zu 12 Chars an (Freitext, 1 bis 32 Zeichen) und hakst je Char ab, was er schon hat. Eine Anmeldung gibt es nicht: Der Link ist das Geheimnis, bitte nicht teilen. `/ffevents neuer-link` erneuert ihn, der alte Link ist dann ungültig.

Je Char lässt sich „erinnern“ ein- oder ausschalten. Die Erinnerungen im Event-Thread nennen pro Char, wie viele Belohnungen noch offen sind (z. B. „Mira: 3 offen, Kael: 1 offen“), und gehen nur auf Servern raus, auf denen du die Checkliste geöffnet hast.

Der Webserver läuft im Bot-Prozess (Port `WEB_PORT`). Im Produktivbetrieb setzt ein Caddy-Container (Port 8443, hinter Cloudflare) HTTPS davor, siehe [docs/deploy.md](docs/deploy.md). Lokal ansehen: `cp data/smoke.sqlite data/web-test.sqlite && DB_PATH=./data/web-test.sqlite pnpm web:dev` druckt einen Demo-Link (ohne Discord, nur auf der Kopie).

Bot-Token und Berechtigungen einrichten: siehe [docs/discord-setup.md](docs/discord-setup.md).

Betrieb auf einem VPS (fertiges Image, Updates, Backups): siehe [docs/deploy.md](docs/deploy.md).

## Trockenlauf

Mit `pnpm dry-run` wird ein einzelner Lodestone-Abgleich ohne Discord-Verbindung ausgeführt; mit `pnpm dry-run -- --db ./data/dry-run.sqlite --dump ./lodestone-dump` bleiben die SQLite-Daten erhalten und die abgerufenen HTML/XML-Seiten werden gespeichert.

Benötigte Bot-Rechte:

- Kanäle ansehen
- Nachrichten senden
- Links einbetten
- Nachrichtenverlauf lesen
- Nachrichten anheften oder Nachrichten verwalten (für den angehefteten Statusbeitrag)
- Öffentliche Threads erstellen (für Erinnerungs-Threads an Event-Karten)
- Nachrichten in Threads senden (für Erinnerungen)
- Threads verwalten (für die Anzeige der Event-Beiträge in der Seitenleiste)
- Events erstellen. Diese Berechtigung deckt auch Änderungen an eigenen Events ab; eine zusätzliche Berechtigung „Events verwalten“ ist dafür nicht erforderlich.

Gateway-Intent: **Guilds** (keine weiteren Intents).

## Tests und Typecheck

Mit installierten Abhängigkeiten:

- `pnpm test`
- `pnpm typecheck`
