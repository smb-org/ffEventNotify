# Deployment auf einem Linux-VPS

Der Bot läuft als Docker-Container. Das Image baut GitHub Actions bei jedem Merge auf `main` und legt es in der GitHub Container Registry ab (`ghcr.io/smb-org/ffeventnotify`). Das Image wird für x86_64-(amd64-)Server gebaut.

## Voraussetzungen

- Linux-VPS mit Docker und dem Compose-Plugin (`docker compose version` muss funktionieren)
- Ausgehender Internetzugang (Discord, Lodestone, ghcr.io)
- Für die Web-Checkliste: eine Subdomain bei Cloudflare (Proxy aktiv) und eingehend offener Port **8443** (siehe unten)
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
scp compose.prod.yaml Caddyfile <server>:/opt/ffeventnotify/   # auf dem Server als docker-compose.yaml speichern
```

Auf dem Server:

```bash
cd /opt/ffeventnotify
cat > .env <<'ENVFILE'
DISCORD_TOKEN=<bot-token>
WEB_DOMAIN=ffevents.example.de
WEB_BASE_URL=https://ffevents.example.de
WEB_LINK_SECRET=<ausgabe von openssl rand -base64 32>
ENVFILE
chmod 600 .env
```

`DB_PATH` setzt `compose.prod.yaml` selbst. `WEB_LINK_SECRET` auf dem Mac mit `pnpm gen-secret` erzeugen und gut aufbewahren: Wer es ändert, macht alle persönlichen Links ungültig.

### 2a. Webseite über Cloudflare (Port 8443)

Port 443 ist auf dem Server belegt. Caddy lauscht deshalb nur auf **8443** und nutzt ein Cloudflare-Origin-Zertifikat; Cloudflare spricht den Server über eine Origin Rule auf Port 8443 an. Die Compose-Datei (bei dir `docker-compose.yaml`) und das `Caddyfile` liegen in `/opt/ffeventnotify`.

1. **DNS:** In Cloudflare unter DNS einen A-Record `ffevents` auf die Server-IP anlegen, Proxy **an** (orange Wolke).
2. **Origin-Zertifikat:** SSL/TLS, Origin Server, Create Certificate. RSA 2048, Hostname `ffevents.esembe.app`, Gültigkeit 15 Jahre. Das Zertifikat als `/opt/ffeventnotify/certs/origin.pem`, den privaten Schlüssel als `/opt/ffeventnotify/certs/origin.key` speichern (der Schlüssel wird nur einmal angezeigt):

   ```bash
   mkdir -p /opt/ffeventnotify/certs && cd /opt/ffeventnotify/certs
   nano origin.pem   # Zertifikat einfügen
   nano origin.key   # privaten Schlüssel einfügen
   chmod 600 origin.key
   ```

3. **SSL-Modus Full (strict) nur für diese Subdomain:** Rules, Configuration Rules, Create rule: Hostname *equals* `ffevents.esembe.app`, SSL: **Full (strict)**. So bleiben andere Subdomains der Zone unberührt. Steht die ganze Zone schon auf Full (strict), ist nichts zu tun.
4. **Port umschreiben:** Rules, Origin Rules, Create rule: Hostname *equals* `ffevents.esembe.app`, Destination Port: *Rewrite to* `8443`.
5. **Firewall:** TCP 8443 öffnen, am besten nur für die Cloudflare-Adressbereiche ([ipv4](https://www.cloudflare.com/ips-v4), [ipv6](https://www.cloudflare.com/ips-v6)). Beispiel mit ufw:

   ```bash
   for ip in $(curl -s https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6); do
     sudo ufw allow from "$ip" to any port 8443 proto tcp
   done
   ```

6. **`.env`:** `WEB_DOMAIN=ffevents.esembe.app`, `WEB_BASE_URL=https://ffevents.esembe.app` und `WEB_LINK_SECRET` (`openssl rand -base64 32` oder `pnpm gen-secret`) eintragen. Ohne diese Werte startet der Bot nicht. Dann:

   ```bash
   cd /opt/ffeventnotify
   docker compose pull && docker compose up -d
   curl -I https://ffevents.esembe.app/
   docker compose logs bot | head -1
   ```

   `curl` muss eine Antwort des Bots liefern (für `/` ist eine 404-Seite in Ordnung), die erste Log-Zeile zeigt die Version.

Der Bot selbst (Port 3480) ist nur im Compose-Netz erreichbar. Caddy reicht die echte Besucher-Adresse (`CF-Connecting-IP`) als `X-Real-IP` weiter; sie dient dem Ratenlimit.

**Fehlerbilder:**

- **525 / 526:** Zertifikat fehlt, ist falsch oder passt nicht zum Hostnamen (`certs/origin.pem`, `origin.key` prüfen, `docker compose logs caddy`), oder der SSL-Modus ist nicht Full (strict).
- **521 / 522:** Cloudflare erreicht den Server nicht: Origin Rule (Port 8443), Firewall oder laufender Caddy-Container prüfen.
- **403 bei POST:** Die Origin-Prüfung schlägt an. `WEB_BASE_URL` muss exakt der Adresse im Browser entsprechen (Schema, Host, kein Schrägstrich am Ende).

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
docker compose pull && docker compose up -d
docker compose logs -f
```

Erwartete Zeilen: die Versionszeile, „Web-Checkliste lauscht auf Port 3480“, „Verbunden als …“ und „Zyklus fertig: …“. Danach antwortet `https://<WEB_DOMAIN>/` (Caddy und Bot laufen); bei Problemen `docker compose logs caddy`.

## Log

Eine Zeile pro Schritt, jeweils mit ISO-Zeitstempel. Standard ist `LOG_LEVEL=info`: Lodestone-Listen, neu erkannte oder geänderte Events, Discord-Aktionen je Server und die Zyklus-Zusammenfassung. Unveränderte Events erscheinen nicht. Mit `LOG_LEVEL=debug` in der `.env` (danach `up -d --force-recreate`) kommen jede Lodestone-Anfrage (URL, Status, Dauer, 304/Cache), jeder Discord-Schreibzugriff und vollständige Fehler-Stacks dazu.

**Welche Version läuft?** Die erste Log-Zeile, z. B. `ffEventNotify 0.1.0 (sha-713348e, gebaut 2026-10-17T00:58Z)`. Sie steht auch in der Antwort auf `/ffevents abgleichen`.

## Abgleich auf Abruf

`/ffevents abgleichen` (Berechtigung „Server verwalten“) startet sofort einen Lodestone-Abgleich und gleicht den eigenen Server ab. Läuft gerade ein Zyklus, wird dieser mitgenutzt. Sperre: 10 Minuten je Server und 5 Minuten insgesamt; der Stundentakt bleibt unberührt.

## Updates

Nach dem Merge auf `main` auf den grünen GitHub-Actions-Lauf warten (Job `image`), dann:

```bash
docker compose pull && docker compose up -d
```

## Zurückrollen

Jedes Image trägt zusätzlich den Tag `sha-<kurzer-commit-hash>`. Es werden nur die letzten 5 Versionen aufbewahrt, `FFE_TAG=sha-…` funktioniert also für die letzten 5 Builds:

```bash
FFE_TAG=sha-abc1234 docker compose up -d
```

Zurück auf die neueste Version: ohne `FFE_TAG` erneut `pull` und `up -d`.

## Backup

Täglich um 03:30, 14 Tage Aufbewahrung (`crontab -e`, benötigt `sqlite3` auf dem Host):

```cron
30 3 * * * cd /opt/ffeventnotify && sqlite3 data/ffeventnotify.sqlite ".backup data/backup-$(date +\%F).sqlite" && find data -name 'backup-*.sqlite' -mtime +14 -delete
```

`.backup` ist auch bei laufendem Bot konsistent.

## Fehlerbilder

- **Bot offline:** `docker compose ps` und `logs --tail 100` prüfen.
- **„Token ungültig“:** Im Discord Developer Portal das Bot-Token neu setzen, in `.env` eintragen, dann `docker compose up -d --force-recreate`.
- **Rechte fehlen:** `/ffevents setup` auf dem Server ausführen, es meldet fehlende Rechte (siehe [discord-setup.md](discord-setup.md)).
- **`pull` verweigert den Zugriff:** `docker login ghcr.io` wiederholen, Token braucht `read:packages`.
- **Checklisten-Link lädt nicht:** DNS, Origin Rule und Port 8443 prüfen, dann `logs caddy`. Fehlt `WEB_DOMAIN` in der `.env`, bricht `docker compose` mit einer Meldung ab.
- **Alle Links ungültig:** `WEB_LINK_SECRET` wurde geändert. Alten Wert wieder eintragen; sonst `/ffevents neuer-link` je Nutzer.
- **Datenbank nicht beschreibbar:** `sudo chown -R 1000:1000 data`.
