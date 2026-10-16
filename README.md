# ffEventNotify

Ein Discord-Bot für deutsche FINAL FANTASY XIV-Events. Er soll Lodestone-Meldungen erkennen, als Embed veröffentlichen, passende Discord-Events anlegen und Belohnungs-Checklisten sowie Erinnerungen verwalten.

## Einrichtung

1. Einen Discord-Bot anlegen und ihn mit den unten aufgeführten Rechten auf den Server einladen.
2. `.env.example` nach `.env` kopieren und Bot-Token sowie Server- und Kanal-IDs eintragen.
3. Mit `docker compose up -d` starten. SQLite-Daten werden in `./data` gespeichert.

Bot-Token und Berechtigungen einrichten: siehe [docs/discord-setup.md](docs/discord-setup.md).

Benötigte Bot-Rechte:

- Kanäle ansehen
- Nachrichten senden
- Links einbetten
- Nachrichtenverlauf lesen
- Nachrichten verwalten (für den angehefteten Statusbeitrag)
- Events erstellen. Diese Berechtigung deckt auch Änderungen an eigenen Events ab; eine zusätzliche Berechtigung „Events verwalten“ ist dafür nicht erforderlich.

Gateway-Intent: **Guilds** (keine weiteren Intents).

## Tests und Typecheck

Mit installierten Abhängigkeiten:

- `pnpm test`
- `pnpm typecheck`
