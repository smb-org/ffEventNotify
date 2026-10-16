# ffEventNotify

Ein Discord-Bot für deutsche FINAL FANTASY XIV-Events. Er soll Lodestone-Meldungen erkennen, als Embed veröffentlichen, passende Discord-Events anlegen und Belohnungs-Checklisten sowie Erinnerungen verwalten.

## Einrichtung

1. Eine Discord-Anwendung anlegen und den Bot mit den unten aufgeführten Rechten einladen. Der Bot ist öffentlich und kann auf mehreren Servern verwendet werden.
2. `.env.example` nach `.env` kopieren und `DISCORD_TOKEN` eintragen. `DB_PATH` und `FIXTURE_DUMP_DIR` sind optionale Pfade; Server- und Kanal-IDs werden nicht in der `.env` gespeichert.
3. Mit `docker compose up -d` starten. SQLite-Daten werden in `./data` gespeichert.
4. Auf jedem Server `/ffevents setup` ausführen und **Event-Kanal** sowie **Log-Kanal** wählen. Dafür ist „Server verwalten“ nötig. Der Bot prüft seine Rechte, speichert die Kanäle und startet direkt den Erstabgleich für diesen Server.

Bot-Token und Berechtigungen einrichten: siehe [docs/discord-setup.md](docs/discord-setup.md).

## Trockenlauf

Mit `pnpm dry-run` wird ein einzelner Lodestone-Abgleich ohne Discord-Verbindung ausgeführt; mit `pnpm dry-run -- --db ./data/dry-run.sqlite --dump ./lodestone-dump` bleiben die SQLite-Daten erhalten und die abgerufenen HTML/XML-Seiten werden gespeichert.

Benötigte Bot-Rechte:

- Kanäle ansehen
- Nachrichten senden
- Links einbetten
- Nachrichtenverlauf lesen
- Nachrichten anheften oder Nachrichten verwalten (für den angehefteten Statusbeitrag)
- Events erstellen. Diese Berechtigung deckt auch Änderungen an eigenen Events ab; eine zusätzliche Berechtigung „Events verwalten“ ist dafür nicht erforderlich.

Gateway-Intent: **Guilds** (keine weiteren Intents).

## Tests und Typecheck

Mit installierten Abhängigkeiten:

- `pnpm test`
- `pnpm typecheck`
