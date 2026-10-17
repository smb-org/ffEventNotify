# Deployment auf einem Linux-VPS

Der Bot läuft als Docker-Container. Das Image baut GitHub Actions bei jedem Merge auf `main` und legt es in der GitHub Container Registry ab (`ghcr.io/smb-org/ffeventnotify`). Das Image wird für x86_64-(amd64-)Server gebaut.

## Voraussetzungen

- Linux-VPS mit Docker und dem Compose-Plugin (`docker compose version` muss funktionieren)
- Ausgehender Internetzugang (Discord, Lodestone, ghcr.io); es muss **kein Port** geöffnet werden
- Optional für Backups: `sqlite3` auf dem Host

## Einmalig einrichten

### 1. Zugang zur Registry

Das Repository ist privat, daher braucht der Server einen Lesezugang:

1. Auf GitHub ein **Personal Access Token (classic)** erstellen (Settings, Developer settings, Tokens) mit **nur** dem Scope `read:packages`.
2. Auf dem Server anmelden:

   ```bash
   docker login ghcr.io -u <github-user>
   ```

   Das Token als Passwort eingeben.

Das Token niemals im Chat oder im Repository teilen.

### 2. Verzeichnis und Konfiguration

```bash
sudo mkdir -p /opt/ffeventnotify/data
sudo chown $USER /opt/ffeventnotify
```

Auf dem Mac, im Repository:

```bash
scp compose.prod.yaml <server>:/opt/ffeventnotify/
```

Auf dem Server:

```bash
cd /opt/ffeventnotify
echo 'DISCORD_TOKEN=<bot-token>' > .env
chmod 600 .env
```

`DB_PATH` setzt `compose.prod.yaml` selbst.

### 3. Datenbank übernehmen

> **Wichtig:** Nie zwei Instanzen mit demselben Token gleichzeitig laufen lassen. Vor der Übernahme den Bot auf dem Mac **zuerst stoppen** (Strg+C bzw. Prozess beenden).

Erst nach dem Stoppen kopieren. Beim sauberen Beenden schreibt SQLite die `-wal`-Datei zurück in `smoke.sqlite`; danach ist die einzelne Datei vollständig. Falls `data/smoke.sqlite-wal` oder `-shm` noch existieren, den Bot erneut starten und sauber beenden, bevor kopiert wird.

```bash
scp data/smoke.sqlite <server>:/opt/ffeventnotify/data/ffeventnotify.sqlite
```

Der Container läuft als User `node` (uid 1000):

```bash
cd /opt/ffeventnotify
sudo chown -R 1000:1000 data
```

## Starten

```bash
cd /opt/ffeventnotify
docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f
```

Erwartete Zeilen: „Verbunden als …“ und „Zyklus fertig: …“.

## Updates

Nach dem Merge auf `main` auf den grünen GitHub-Actions-Lauf warten (Job `image`), dann:

```bash
docker compose -f compose.prod.yaml pull && docker compose -f compose.prod.yaml up -d
```

## Zurückrollen

Jedes Image trägt zusätzlich den Tag `sha-<kurzer-commit-hash>`. Es werden nur die letzten 5 Versionen aufbewahrt, `FFE_TAG=sha-…` funktioniert also für die letzten 5 Builds:

```bash
FFE_TAG=sha-abc1234 docker compose -f compose.prod.yaml up -d
```

Zurück auf die neueste Version: ohne `FFE_TAG` erneut `pull` und `up -d`.

## Backup

Täglich um 03:30, 14 Tage Aufbewahrung (`crontab -e`, benötigt `sqlite3` auf dem Host):

```cron
30 3 * * * cd /opt/ffeventnotify && sqlite3 data/ffeventnotify.sqlite ".backup data/backup-$(date +\%F).sqlite" && find data -name 'backup-*.sqlite' -mtime +14 -delete
```

`.backup` ist auch bei laufendem Bot konsistent.

## Fehlerbilder

- **Bot offline:** `docker compose -f compose.prod.yaml ps` und `logs --tail 100` prüfen.
- **„Token ungültig“:** Im Discord Developer Portal das Bot-Token neu setzen, in `.env` eintragen, dann `docker compose -f compose.prod.yaml up -d --force-recreate`.
- **Rechte fehlen:** `/ffevents setup` auf dem Server ausführen, es meldet fehlende Rechte (siehe [discord-setup.md](discord-setup.md)).
- **`pull` verweigert den Zugriff:** `docker login ghcr.io` wiederholen, Token braucht `read:packages`.
- **Datenbank nicht beschreibbar:** `sudo chown -R 1000:1000 data`.
