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
.\setup-firestick.ps1 -FirestickIp 192.168.8.177 -DashboardUrl "http://192.168.8.10:3100"
```

## Kiosk-Dashboard separat in Dockge starten

1. Stack-Datei aus `kiosk-dashboard/docker-compose.yml` in Dockge verwenden.
2. Optional `.env.example` nach `.env` kopieren und Werte anpassen.
3. Stack starten (Standard-Port extern: `3200`).

Die App ist jetzt bewusst vom alten `dart-dashboard` entkoppelt.

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

ADB-Debugging nur im vertrauten Netzwerk aktiv lassen.
