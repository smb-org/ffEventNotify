# Discord-Bot einrichten

Du brauchst Admin- bzw. „Server verwalten“-Rechte auf dem Server. Dauer: ca. 10 Minuten.

## 1. Anwendung anlegen
1. **https://discord.com/developers/applications** öffnen und anmelden.
2. Oben rechts **„New Application“** → Name eingeben (z. B. `FF14 Events`, so heißt der Bot später) → Bedingungen bestätigen → **Create**.
3. Optional unter **General Information** ein App-Icon hochladen.

## 2. Bot einrichten und Token holen
1. Links **„Bot“** öffnen.
2. Optional Profilbild/Banner des Bots setzen.
3. Unter **„Authorization Flow“**:
   - **Public Bot: AN** (damit auch andere Server-Admins ihn über den Link einladen können).
   - **Requires OAuth2 Code Grant: AUS**.
4. Unter **„Privileged Gateway Intents“**: alle drei **AUS** lassen (Presence, Server Members, Message Content). Der Bot braucht keinen davon.
5. Oben bei **„Token“** auf **„Reset Token“** klicken → bestätigen → Token **sofort kopieren** (wird nur einmal angezeigt).

> ⚠️ Der Token ist das Passwort des Bots. Nirgends teilen und nicht ins Repo legen, nur in die `.env` (Schritt 6). Die `.env` steht in `.gitignore`. Ist er doch irgendwo gelandet: einfach „Reset Token“ drücken.

## 3. Einladungslink mit den richtigen Rechten erzeugen
1. Links **„OAuth2“** → **„URL Generator“**.
2. **Scopes:** **`bot`** und **`applications.commands`** anhaken (Letzteres für `/ffevents setup`).
3. Darunter erscheint **Bot Permissions**. Genau diese anhaken:

| Berechtigung (im Portal) | Wofür |
|---|---|
| **View Channels** | Event- und Log-Kanal sehen |
| **Send Messages** | Event-Posts und Log-Meldungen |
| **Embed Links** | die formatierten Event-Karten |
| **Read Message History** | eigene Posts nach Neustart wiederfinden (verhindert Duplikate) |
| **Pin Messages** | den „Läuft gerade“-Post anheften. Falls es den Punkt nicht gibt: stattdessen **Manage Messages** |
| **Create Events** | Kalendereinträge (Server-Events) anlegen und eigene bearbeiten |

   **Nicht** anhaken: Administrator, Manage Server, Mention Everyone und alles andere.
4. Ganz unten den **Generated URL** kopieren.

## 4. Bot auf einen Server einladen
Jeder mit „Server verwalten“ auf seinem Server kann den Link nutzen.

1. Den kopierten Link im Browser öffnen.
2. Server auswählen → **Weiter** → **Autorisieren**.
3. Der Bot erscheint offline in der Mitgliederliste. Online geht er erst, wenn er gestartet wird.

## 5. Kanäle vorbereiten
1. **Event-Kanal** (z. B. `#ff14-events`), in den der Bot postet. In den Kanal-Einstellungen → Berechtigungen für die Bot-Rolle prüfen: Kanal ansehen, Nachrichten senden, Links einbetten, Nachrichtenverlauf lesen, Nachrichten anheften = ✅.
2. **Log-Kanal** (z. B. `#ff14-bot-log`) für Warnungen wie „Belohnungen unsicher“ oder „Lodestone nicht lesbar“. Am besten **privat** (nur Admins + Bot-Rolle), gleiche Rechte wie oben.

## 6. `.env` anlegen
Im Projektordner `.env.example` nach `.env` kopieren und ausfüllen:
```
DISCORD_TOKEN=<Token aus Schritt 2>
```
`DB_PATH` und `FIXTURE_DUMP_DIR` bleiben wie vorgegeben. IDs werden nicht gebraucht.

## 7. Starten
- Lokal: `pnpm install` und `pnpm start`
- Docker: `docker compose up -d`

## 8. Auf dem Server einrichten
1. Nach dem Start führt ein Mitglied mit „Server verwalten“ auf dem Server `/ffevents setup` aus und wählt **Event-Kanal** und **Log-Kanal** aus.
2. Der Bot bestätigt und macht für diesen Server den ersten Durchlauf: Er postet nur Events, die gerade laufen oder noch kommen, und schreibt eine kurze Zusammenfassung in den Log-Kanal.
3. Wer `/ffevents setup` erneut ausführt, ändert die Kanäle.
