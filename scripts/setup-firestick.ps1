[CmdletBinding()]
param(
    [string]$FirestickIp = $(if ($env:FIRESTICK_IP) { $env:FIRESTICK_IP } else { "192.168.8.177" }),
    [int]$AdbPort = 5555,
    [string]$DashboardUrl,
    [string]$ExpectedApkSha256,
    [int]$RetryCount = 3,
    [int]$HealthRetryCount = 3,
    [switch]$SkipInstall,
    [switch]$SkipBootGrant,
    [switch]$SkipHealthCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ============================================================
#  Fire Stick Kiosk-Setup – Löwen Dart Dashboard
# ============================================================

$REPO_ROOT = Split-Path -Path $PSScriptRoot -Parent
$APK_PATH  = Join-Path $REPO_ROOT "apks\fully-kiosk-browser.apk"
$DEVICE    = "${FirestickIp}:${AdbPort}"

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

function Invoke-Adb([string[]]$Args, [switch]$AllowFailure) {
    $output = & adb @Args 2>&1 | Out-String
    $code = $LASTEXITCODE
    if (-not $AllowFailure -and $code -ne 0) {
        Fail "ADB Fehler ($code): adb $($Args -join ' ')`n$output"
    }
    return [pscustomobject]@{ Code = $code; Output = $output.Trim() }
}

function Get-DeviceState {
    $r = Invoke-Adb -Args @("devices")
    $line = $r.Output -split "`r?`n" | Where-Object { $_ -match "^$([regex]::Escape($DEVICE))\s+" } | Select-Object -First 1
    if (-not $line) { return "missing" }
    if ($line -match "\s+(\S+)$") { return $matches[1] }
    return "unknown"
}

function Ensure-AdbAvailable {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
        Fail "ADB nicht gefunden. Bitte Android Platform Tools installieren: https://developer.android.com/tools/releases/platform-tools"
    }
}

function Connect-Device {
    Write-Host "`n[1/5] Verbinde mit Fire Stick ($DEVICE)..." -ForegroundColor Cyan
    for ($i = 1; $i -le $RetryCount; $i++) {
        $null = Invoke-Adb -Args @("connect", $DEVICE) -AllowFailure
        Start-Sleep -Milliseconds 900
        $state = Get-DeviceState
        if ($state -eq "device") {
            Write-Host "Verbunden." -ForegroundColor Green
            return
        }
        Write-Host "Verbindungsversuch $i/$($RetryCount): Zustand = $state" -ForegroundColor Yellow
        if ($state -eq "unauthorized") {
            Fail "Fire TV ist 'unauthorized'. Bitte auf dem TV den Dialog 'USB-Debugging zulassen?' mit 'Immer erlauben' + OK bestätigen und Script erneut starten."
        }
        if ($state -eq "offline") {
            Write-Host "Gerät ist offline. Ich versuche erneut..." -ForegroundColor Yellow
        }
    }
    Fail "Verbindung fehlgeschlagen. Prüfe: ADB-Debugging aktiv, gleiches Netzwerk, korrekte IP ($FirestickIp)."
}

function Validate-Apk {
    if ($SkipInstall) { return }
    if (-not (Test-Path $APK_PATH)) {
        Fail "APK nicht gefunden: $APK_PATH`nBitte Fully Kiosk APK herunterladen und in $(Join-Path $REPO_ROOT 'apks') ablegen."
    }
    if ($ExpectedApkSha256) {
        $actual = (Get-FileHash -Path $APK_PATH -Algorithm SHA256).Hash.ToLowerInvariant()
        $expected = $ExpectedApkSha256.ToLowerInvariant()
        if ($actual -ne $expected) {
            Fail "APK SHA256 stimmt nicht.`nExpected: $expected`nActual:   $actual"
        }
        Write-Host "SHA256 erfolgreich geprüft." -ForegroundColor Green
    }
}

function Install-FullyKiosk {
    if ($SkipInstall) {
        Write-Host "`n[2/5] Installation uebersprungen (--SkipInstall)." -ForegroundColor DarkYellow
        return
    }
    Write-Host "`n[2/5] Installiere Fully Kiosk Browser..." -ForegroundColor Cyan
    $r = Invoke-Adb -Args @("-s", $DEVICE, "install", "-r", $APK_PATH)
    if ($r.Output -notmatch "Success") {
        Fail "Installation nicht bestaetigt. ADB-Ausgabe:`n$($r.Output)"
    }
    Write-Host "APK installiert." -ForegroundColor Green
}

function Grant-BootPermission {
    if ($SkipBootGrant) {
        Write-Host "`n[3/5] Boot-Berechtigung uebersprungen (--SkipBootGrant)." -ForegroundColor DarkYellow
        return
    }
    Write-Host "`n[3/5] Konfiguriere Boot-Berechtigung..." -ForegroundColor Cyan
    $null = Invoke-Adb -Args @("-s", $DEVICE, "shell", "pm", "grant", "de.ozerov.fully", "android.permission.RECEIVE_BOOT_COMPLETED") -AllowFailure
    Write-Host "Boot-Berechtigung ausgefuehrt (ggf. ROM-abhängig)." -ForegroundColor Green
}

function Apply-DashboardUrl {
    Write-Host "`n[4/5] Dashboard-URL setzen..." -ForegroundColor Cyan
    if (-not $DashboardUrl) {
        Write-Host "Keine DashboardUrl uebergeben. Schritt uebersprungen." -ForegroundColor DarkYellow
        return
    }
    $null = Invoke-Adb -Args @("-s", $DEVICE, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", $DashboardUrl, "de.ozerov.fully")
    Write-Host "URL an Fully uebergeben: $DashboardUrl" -ForegroundColor Green
}

function Is-FullyInstalled {
    $r = Invoke-Adb -Args @("-s", $DEVICE, "shell", "pm", "path", "de.ozerov.fully") -AllowFailure
    return ($r.Code -eq 0 -and $r.Output -match "^package:")
}

function Is-FullyRunning {
    $r = Invoke-Adb -Args @("-s", $DEVICE, "shell", "pidof", "de.ozerov.fully") -AllowFailure
    return ($r.Code -eq 0 -and -not [string]::IsNullOrWhiteSpace($r.Output))
}

function Start-Fully {
    if ($DashboardUrl) {
        $null = Invoke-Adb -Args @("-s", $DEVICE, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", $DashboardUrl, "de.ozerov.fully") -AllowFailure
    } else {
        $null = Invoke-Adb -Args @("-s", $DEVICE, "shell", "monkey", "-p", "de.ozerov.fully", "-c", "android.intent.category.LAUNCHER", "1") -AllowFailure
    }
}

function Ensure-FullyHealthy {
    if ($SkipHealthCheck) {
        Write-Host "`n[5/5] Healthcheck uebersprungen (--SkipHealthCheck)." -ForegroundColor DarkYellow
        return
    }

    Write-Host "`n[5/5] Kiosk-Healthcheck (Fully) ..." -ForegroundColor Cyan

    if (-not (Is-FullyInstalled)) {
        Fail "Fully Kiosk ist nicht installiert oder vom System nicht sichtbar."
    }

    for ($i = 1; $i -le $HealthRetryCount; $i++) {
        if (Is-FullyRunning) {
            Write-Host "Fully läuft (PID vorhanden)." -ForegroundColor Green
            return
        }

        Write-Host "Healthcheck Versuch $i/$($HealthRetryCount): Fully laeuft nicht, starte neu..." -ForegroundColor Yellow
        Start-Fully
        Start-Sleep -Seconds 2
    }

    Fail "Fully konnte nicht gestartet werden. Bitte App auf dem TV einmal manuell oeffnen und ADB-Dialog bestaetigen."
}

Ensure-AdbAvailable
Connect-Device
Validate-Apk
Install-FullyKiosk
Grant-BootPermission
Apply-DashboardUrl
Ensure-FullyHealthy

Write-Host @"

============================================================
 Setup abgeschlossen!
============================================================
 Naechste Schritte (direkt auf dem TV):
   1. Dialog 'USB-Debugging zulassen?' mit 'Immer erlauben' bestaetigen
     2. Pruefen, dass Fully im Vordergrund sichtbar ist
     3. In Fully: 'Autostart on Boot' aktivieren
     4. In Fully: 'Keep Screen On' aktivieren (optional)
============================================================
"@ -ForegroundColor Green
