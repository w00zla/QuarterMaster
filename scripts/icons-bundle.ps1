# Packt alles, was `pnpm icons:render` auf einem anderen Windows-Rechner braucht, in einen Ordner:
# portables Node, Blender (portabel, mit StarBreaker-Addon), die StarBreaker-CLI (eigener Fork starbreaker-qm), die CLI
# samt Blender-Skript, die Zielliste aus der lokalen DB (targets.json) und ein run.cmd. Der Zielrechner
# braucht nur noch die Data.p4k. Aufruf aus dem Repo-Root (pwsh oder Windows PowerShell 5.1):
#   scripts/icons-bundle.ps1 [-Out local/icons-bundle] [-NodeVersion 22.19.0]
param(
  [string]$Out = 'local/icons-bundle',
  [string]$NodeVersion = 'v22.19.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$Out = [System.IO.Path]::GetFullPath((Join-Path $root $Out))
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# Zielliste aus der DB (braucht DATABASE_URL aus .env und SC_DATA_P4K nur pro forma nicht)
Write-Host "Zielliste aus der DB ..."
$env:SC_DATA_P4K = if ($env:SC_DATA_P4K) { $env:SC_DATA_P4K } else { Join-Path $root 'package.json' }  # nur der Existenz-Check
pnpm icons:render --write-targets (Join-Path $Out 'targets.json')
if ($LASTEXITCODE -ne 0) { throw 'targets.json konnte nicht geschrieben werden' }

# Die CLI und das Blender-Skript
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'cli') | Out-Null
Copy-Item src/icons/cli.ts, src/icons/render.py (Join-Path $Out 'cli')

# Portables Node: nur node.exe aus dem offiziellen Zip
$nodeDir = Join-Path $Out 'node'
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  Write-Host "Node $NodeVersion laden ..."
  $zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "node-$NodeVersion-unzip"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
  Copy-Item (Join-Path $tmp "node-$NodeVersion-win-x64/node.exe") $nodeDir
  Remove-Item -Recurse -Force $tmp
  Remove-Item -Force $zip
}

# StarBreaker (eigener Fork, local/starbreaker-qm: starbreaker.exe und COMMIT)
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'starbreaker') | Out-Null
Copy-Item local/starbreaker-qm/starbreaker.exe, local/starbreaker-qm/COMMIT (Join-Path $Out 'starbreaker') -Force

# Blender portabel samt portable/ (Config und das StarBreaker-Addon): robocopy spiegelt, 1 = kopiert, 0 = unverändert
$blenderSrc = Get-ChildItem local/blender -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'blender.exe') } | Select-Object -First 1
if (-not $blenderSrc) { throw 'Kein Blender unter local/blender/*/blender.exe' }
Write-Host "Blender kopieren ($($blenderSrc.Name)) ..."
robocopy $blenderSrc.FullName (Join-Path $Out 'blender') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy fehlgeschlagen ($LASTEXITCODE)" }

# Starter: Data.p4k neben run.cmd oder per --p4k, alle weiteren Argumente gehen an die CLI
@'
@echo off
setlocal
cd /d "%~dp0"
set "P4K="
if exist "%~dp0Data.p4k" set "P4K=--p4k "%~dp0Data.p4k""
node\node.exe cli\cli.ts --targets targets.json --starbreaker starbreaker\starbreaker.exe --blender blender\blender.exe --out icons --work work %P4K% %*
'@ | Set-Content -Path (Join-Path $Out 'run.cmd') -Encoding ASCII

@'
Icon-Render-Bundle (sc-quartermaster)

1. Data.p4k des Spiels neben run.cmd legen (oder beim Aufruf --p4k "<Pfad>\Data.p4k" angeben).
2. run.cmd ausführen. Erst ein Test: run.cmd --sample 20
   Voller Lauf: run.cmd            (ca. 35-60 Minuten; abbrechen und neu starten ist ok, Fertiges wird übersprungen)
   Weitere Optionen: run.cmd --help
3. Ergebnis: icons\<Name> (<Klasse>) <uuid>.png (ein Bild je Katalog-UUID; im Explorer mit großen Symbolen
   auf Sicht prüfen, Nachrendern mit run.cmd --force --filter <Klasse>). Den Ordner icons\ zurück auf den
   Entwicklungsrechner. Log: work\render.log (Fortschritt, Fehler), work\blender.log (Blender-Ausgabe).
   work\ ist sonst nur Cache (Renders je Entity, DataCore-Dumps) und kann danach weg.

Der Rechner braucht nichts installiert: Node, Blender und StarBreaker liegen im Bundle. Kein Internet nötig.
'@ | Set-Content -Path (Join-Path $Out 'LIESMICH.txt') -Encoding UTF8

$size = [math]::Round((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "Bundle: $Out ($size MB)"
exit 0  # robocopys Exit-Code 1 (kopiert) soll nicht als Fehler zählen
