# Fire-Stick Kiosk Repo

Dieses Repository enthaelt die Fire-TV/Fully-Kiosk Betriebsartefakte (APKs + Setup-Script).

## Neuer Aufbau (entkoppelt vom dart-dashboard)

- `kiosk-dashboard/`: Eigenstaendige Node.js Kiosk-App inklusive Docker Compose fuer Dockge/Unraid.
- `scripts/`: Setup- und Wartungsskripte fuer Fire TV / ADB.
- `apks/`: APK-Dateien fuer Fully/Tools.

## Inhalte

- `scripts/setup-firestick.ps1`: Installiert Fully Kiosk, prueft ADB, verbindet den Fire TV und setzt optional die Dashboard-URL.
- `apks/fully-kiosk-browser.apk`: APK fuer Fully Kiosk (im Repo enthalten).
- `apks/Brave157-armv7.apk`: Lokal vorhanden, aber wegen GitHub 100MB Limit nicht im Repo versioniert.
- `kiosk-dashboard/docker-compose.yml`: Separater Dockge-Stack (`fire-kiosk-dashboard`) auf Port `3200`.

## Voraussetzungen

- Windows PowerShell 5.1+
- `adb` in PATH (Android Platform Tools)
- Fire TV und Rechner im selben Netzwerk
- Fire TV Entwickleroptionen aktiv:
  - ADB-Debugging EIN

## Schnellstart

```powershell
cd .\Fire-Stick\scripts
.\setup-firestick.ps1 -FirestickIp <FIRESTICK-IP> -DashboardUrl "http://<SERVER-IP>:3200"
```

## Kiosk-Dashboard separat in Dockge starten

1. Stack-Datei aus `kiosk-dashboard/docker-compose.yml` in Dockge verwenden.
2. `.env.example` nach `.env` kopieren. `KIOSK_ADMIN_PASSWORD` auf ein langes, eindeutiges Passwort setzen und `SERVER_IP` sowie `FIRESTICK_IP` konfigurieren.
3. Stack starten (Standard-Port extern: `3200`). Falls dieser Port bereits vom Dart-Dashboard verwendet wird, `KIOSK_PORT` und `PUBLIC_PORT` auf denselben freien Port setzen.

Die App ist jetzt bewusst vom alten `dart-dashboard` entkoppelt.

Bei einer Neuinstallation zeigt der Hub noch keine Dashboard-Kacheln. Unter `http://<SERVER-IP>:<KIOSK_PORT>/admin.html` anmelden und gewuenschte Kacheln einblenden oder eigene Links hinzufuegen. Fuer Brave zuerst die Browser-Kachel einblenden; die Browser-Verwaltung benoetigt ebenfalls die Anmeldung. Bestehende Daten und Einstellungen im Daten-Volume bleiben erhalten.

Gespeicherte Admin-Einstellungen haben Vorrang vor den zugehoerigen Umgebungsvariablen: `FIRESTICK_IP` und `ADB_PATH` dienen als Startwerte, bis sie im Admin-Bereich gespeichert werden. Die Server-Adresse wird entsprechend im Admin-Bereich eingestellt; `SERVER_IP` dient zur automatischen Erkennung als Vorgabe. Nachtraegliche Aenderungen in Compose ersetzen gespeicherte Werte nicht. Aendere sie im Admin-Bereich; andere gespeicherte Einstellungen und das Daten-Volume bleiben dabei erhalten. Der ADB-Verbindungstest prueft den Geraetestatus, ohne eine Webseite zu oeffnen.

Ohne `KIOSK_ADMIN_PASSWORD` ist die Verwaltung gesperrt. Die Sitzung endet nach 12 Stunden oder einem Serverneustart; im Admin-Panel ist auch eine Abmeldung moeglich. Der Hub und die dort angezeigten Panel-Ziele sind ohne Anmeldung lesbar: keine Zugangsdaten in Panel-URLs speichern.

`data/`, `.env` und `adb-keys/` sind lokale Betriebsdaten und duerfen nicht in Git eingecheckt oder oeffentlich geteilt werden. Ihre Entfernung aus dem aktuellen Repository entfernt bereits veroeffentlichte Daten **nicht** aus der Git-Historie, bestehenden Klonen oder Backups. Bei kompromittierten Zugangsdaten diese austauschen und eine separate Historienbereinigung pruefen.

## Wichtige Parameter

- `-FirestickIp`: Ziel-IP des Fire TV
- `-AdbPort`: Standard `5555`
- `-DashboardUrl`: Optional. Wird nach Setup an Fully uebergeben.
- `-ExpectedApkSha256`: Optionaler Integritaetscheck fuer APK
- `-SkipInstall`: Nur Verbindung/Berechtigungen testen
- `-SkipBootGrant`: Boot-Berechtigung ueberspringen
- `-SkipHealthCheck`: Healthcheck und Auto-Recovery ueberspringen
- `-RetryCount`: Anzahl Verbindungsversuche
- `-HealthRetryCount`: Anzahl Startversuche fuer Fully beim Healthcheck

## Healthcheck und Auto-Recovery

Das Setup prueft nach Installation/Konfiguration automatisch:

1. Ist `de.ozerov.fully` installiert?
2. Laeuft Fully als Prozess?
3. Falls nicht: Neustartversuche bis `HealthRetryCount` erreicht ist.

Wenn Fully danach immer noch nicht laeuft, bricht das Script mit klarer Fehlermeldung ab.

## Typische Probleme

### 1) `unauthorized`

Symptom: Script meldet `unauthorized`.

Loesung:
1. Auf dem Fire TV den Dialog `USB-Debugging zulassen?` bestaetigen.
2. `Von diesem Computer immer erlauben` aktivieren.
3. Script erneut starten.

### 2) `offline` oder keine Verbindung

Loesung:
1. Fire TV + Rechner im selben LAN
2. IP pruefen
3. Fire TV neu starten
4. erneut ausfuehren

### 3) APK fehlt

Loesung:
- Fully APK nach `apks/fully-kiosk-browser.apk` legen.

## Sicherheits-Hinweis

ADB-Debugging und den Kiosk-Port nur im vertrauten Netzwerk aktiv lassen; keine Portweiterleitung ins Internet einrichten. HTTP verschluesselt weder Passwort noch Sitzungs-Cookie. Fuer einen HTTPS-Reverse-Proxy dessen konkrete interne IP oder CIDR als `KIOSK_TRUST_PROXY` setzen, sodass das vom Proxy gesetzte `X-Forwarded-Proto` ausgewertet wird. Den App-Port dann ausschliesslich fuer den vertrauenswuerdigen Proxy erreichbar machen. Keine fremden Proxys oder ungeprueften Forwarded-Header vertrauen.
