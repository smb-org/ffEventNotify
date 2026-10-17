# Deployment auf einem Linux-VPS

Der Bot läuft als Docker-Container. Das Image baut GitHub Actions bei jedem Merge auf `main` und legt es in der GitHub Container Registry ab (`ghcr.io/smb-org/ffeventnotify`). Das Image wird für x86_64-(amd64-)Server gebaut.

## Voraussetzungen

- Linux-VPS mit Docker und dem Compose-Plugin (`docker compose version` muss funktionieren)
- Ausgehender Internetzugang (Discord, Lodestone, ghcr.io)
- Für die Web-Checkliste: eine (Sub-)Domain und eingehend offene Ports **80 und 443** (Caddy holt das HTTPS-Zertifikat selbst)
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
scp compose.prod.yaml Caddyfile <server>:/opt/ffeventnotify/
```

Auf dem Server:

```bash
cd /opt/ffeventnotify
cat > .env <<'ENVFILE'
DISCORD_TOKEN=<bot-token>
WEB_DOMAIN=ffevents.example.de
WEB_BASE_URL=https://ffevents.example.de
WEB_LINK_SECRET=<ausgabe von pnpm gen-secret>
ENVFILE
chmod 600 .env
```

`DB_PATH` setzt `compose.prod.yaml` selbst. `WEB_LINK_SECRET` auf dem Mac mit `pnpm gen-secret` erzeugen und gut aufbewahren: Wer es ändert, macht alle persönlichen Links ungültig.

### 2a. Web-Checkliste erreichbar machen

1. **DNS:** Einen A-Record (bei IPv6 zusätzlich AAAA) für `WEB_DOMAIN` auf die Server-IP setzen.
2. **Firewall:** Eingehend 80 und 443 (TCP) erlauben, z. B. `sudo ufw allow 80,443/tcp`. Port 80 braucht Caddy für die Zertifikatsprüfung.
3. Der Bot selbst (Port 3480) ist nur im Compose-Netz erreichbar, nicht von außen.

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

Erwartete Zeilen: die Versionszeile, „Web-Checkliste lauscht auf Port 3480“, „Verbunden als …“ und „Zyklus fertig: …“. Danach antwortet `https://<WEB_DOMAIN>/` mit „Link ungültig oder erneuert“ (Caddy und Bot laufen); das Zertifikat kann beim ersten Start eine Minute dauern (`docker compose -f compose.prod.yaml logs caddy`).

## Log

Eine Zeile pro Schritt, jeweils mit ISO-Zeitstempel. Standard ist `LOG_LEVEL=info`: Lodestone-Listen, neu erkannte oder geänderte Events, Discord-Aktionen je Server und die Zyklus-Zusammenfassung. Unveränderte Events erscheinen nicht. Mit `LOG_LEVEL=debug` in der `.env` (danach `up -d --force-recreate`) kommen jede Lodestone-Anfrage (URL, Status, Dauer, 304/Cache), jeder Discord-Schreibzugriff und vollständige Fehler-Stacks dazu.

**Welche Version läuft?** Die erste Log-Zeile, z. B. `ffEventNotify 0.1.0 (sha-713348e, gebaut 2026-10-17T00:58Z)`. Sie steht auch in der Antwort auf `/ffevents abgleichen`.

## Abgleich auf Abruf

`/ffevents abgleichen` (Berechtigung „Server verwalten“) startet sofort einen Lodestone-Abgleich und gleicht den eigenen Server ab. Läuft gerade ein Zyklus, wird dieser mitgenutzt. Sperre: 10 Minuten je Server und 5 Minuten insgesamt; der Stundentakt bleibt unberührt.

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
- **Checklisten-Link lädt nicht:** DNS und Ports 80/443 prüfen, dann `logs caddy`. Fehlt `WEB_DOMAIN` in der `.env`, bricht `docker compose` mit einer Meldung ab.
- **Alle Links ungültig:** `WEB_LINK_SECRET` wurde geändert. Alten Wert wieder eintragen; sonst `/ffevents neuer-link` je Nutzer.
- **Datenbank nicht beschreibbar:** `sudo chown -R 1000:1000 data`.
