# Packt alles, was das Rust-Tool packshot (tools/packshot) auf einem anderen Rechner braucht, in Ordner je Plattform:
#   <Out>/windows: packshot.exe, StarBreaker (eigener Fork), portables Blender mit Addon, render.py, targets.json, run.cmd
#   <Out>/linux:   packshot (statisches musl-Binary), das offizielle Blender-Tarball (SHA256 geprüft), portable/ (Config +
#                  Addon), render.py, setup.sh und check.sh (entpacken und prüfen auf dem Linux-Rechner)
# Aufruf aus dem Repo-Root (pwsh oder Windows PowerShell 5.1):
#   scripts/packshot-bundle.ps1 [-Out local/packshot-bundle] [-BlenderVersion 5.2.3] [-Platform all|windows|linux]
param(
  [string]$Out = 'local/packshot-bundle',
  [string]$BlenderVersion = '5.2.3',
  [ValidateSet('all', 'windows', 'linux')][string]$Platform = 'all'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$Out = [System.IO.Path]::GetFullPath((Join-Path $root $Out))
$tpl = Join-Path $root 'tools/packshot/bundle'
$crate = Join-Path $root 'tools/packshot'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$doWin = $Platform -in 'all', 'windows'
$doLin = $Platform -in 'all', 'linux'

# Native Programme setzen $LASTEXITCODE, werfen aber nicht
function Assert-Ok([string]$what) {
  if ($LASTEXITCODE -ne 0) { throw "$what fehlgeschlagen ($LASTEXITCODE)" }
}

# Ordner spiegeln: robocopy-Exit-Codes < 8 sind Erfolg (1 = kopiert, 0 = unverändert)
function Mirror([string]$src, [string]$dst) {
  robocopy $src $dst /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $src fehlgeschlagen ($LASTEXITCODE)" }
}

# Vorlage mit LF-Zeilenenden kopieren (die .sh brauchen LF, auch wenn die Vorlage anders ausgecheckt wurde)
function Copy-Template([string]$src, [string]$dst) {
  $text = [IO.File]::ReadAllText($src).Replace("`r`n", "`n")
  $enc = if ($dst -like '*.txt') { New-Object Text.UTF8Encoding $true } else { New-Object Text.UTF8Encoding $false }
  [IO.File]::WriteAllText($dst, $text, $enc)
}

# Blender-Ordner des lokalen Windows-Blenders (mit blender.exe)
$blenderSrc = Get-ChildItem local/blender -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'blender.exe') } | Select-Object -First 1
if (-not $blenderSrc) { throw 'Kein Blender unter local/blender/*/blender.exe' }

# 1. Bauen
Push-Location $crate
try {
  if ($doWin) {
    Write-Host 'packshot bauen (Windows) ...'
    cargo build --release
    Assert-Ok 'cargo build (Windows)'
  }
  if ($doLin) {
    Write-Host 'packshot bauen (Linux, musl) ...'
    cargo build --release --target x86_64-unknown-linux-musl
    Assert-Ok 'cargo build (Linux)'
  }
} finally {
  Pop-Location
}

# 2. Windows-Bundle
if ($doWin) {
  $win = Join-Path $Out 'windows'
  New-Item -ItemType Directory -Force -Path $win | Out-Null
  Copy-Item (Join-Path $crate 'target/release/packshot.exe') $win -Force

  New-Item -ItemType Directory -Force -Path (Join-Path $win 'starbreaker') | Out-Null
  Copy-Item local/starbreaker-qm/starbreaker.exe, local/starbreaker-qm/COMMIT (Join-Path $win 'starbreaker') -Force

  Write-Host "Blender kopieren ($($blenderSrc.Name)) ..."
  Mirror $blenderSrc.FullName (Join-Path $win 'blender')

  New-Item -ItemType Directory -Force -Path (Join-Path $win 'cli') | Out-Null
  Copy-Item src/icons/render.py (Join-Path $win 'cli') -Force

  # Zielliste aus der DB (braucht DATABASE_URL aus .env). SC_DATA_P4K-Platzhalter nur für diesen Aufruf: siehe icons-bundle.ps1
  Write-Host 'Zielliste aus der DB ...'
  $savedP4k = $env:SC_DATA_P4K
  try {
    if (-not $env:SC_DATA_P4K) { $env:SC_DATA_P4K = Join-Path $root 'package.json' }  # nur der Existenz-Check
    pnpm icons:render --write-targets (Join-Path $win 'targets.json')
    Assert-Ok 'targets.json schreiben'
  } finally {
    $env:SC_DATA_P4K = $savedP4k
  }

  # Starter: alle Argumente gehen an packshot
  "@echo off`r`ncd /d `"%~dp0`"`r`n`"%~dp0packshot.exe`" %*`r`n" | Set-Content -Path (Join-Path $win 'run.cmd') -Encoding ASCII -NoNewline
  Copy-Template (Join-Path $tpl 'windows/LIESMICH.txt') (Join-Path $win 'LIESMICH.txt')
}

# 3. Linux-Bundle
if ($doLin) {
  $lin = Join-Path $Out 'linux'
  New-Item -ItemType Directory -Force -Path $lin | Out-Null
  Copy-Item (Join-Path $crate 'target/x86_64-unknown-linux-musl/release/packshot') $lin -Force

  # Blender-Tarball: einmal nach cache/ laden, gegen die veröffentlichte SHA256 prüfen, unentpackt ins Bundle
  # (Entpacken unter Windows würde Symlinks und Ausführrechte verlieren: das macht setup.sh auf dem Linux-Rechner)
  $minor = ($BlenderVersion -split '\.')[0..1] -join '.'
  $base = "https://download.blender.org/release/Blender$minor"
  $tarName = "blender-$BlenderVersion-linux-x64.tar.xz"
  $cache = Join-Path $Out 'cache'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $tar = Join-Path $cache $tarName
  if (-not (Test-Path $tar)) {
    Write-Host "Blender $BlenderVersion (Linux) laden ..."
    $ProgressPreference = 'SilentlyContinue'  # sonst ist Invoke-WebRequest in 5.1 extrem langsam
    Invoke-WebRequest -Uri "$base/$tarName" -OutFile "$tar.part"
    Move-Item "$tar.part" $tar -Force
  }
  $sums = (Invoke-WebRequest -Uri "$base/blender-$BlenderVersion.sha256" -UseBasicParsing).Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($tarName) } | Select-Object -First 1) -replace '\s.*$', ''
  if (-not $expected) { throw "Keine SHA256 für $tarName in $base/blender-$BlenderVersion.sha256" }
  $actual = (Get-FileHash $tar -Algorithm SHA256).Hash
  if ($actual -ne $expected.Trim().ToUpperInvariant()) {
    Remove-Item -Force $tar
    throw "SHA256 stimmt nicht ($actual, erwartet $expected): Download gelöscht"
  }
  Write-Host "SHA256 ok ($tarName)"
  Copy-Item $tar $lin -Force

  # portable/: Config und Addon des lokalen Blenders (das Addon ist eine Junction: robocopy folgt ihr mit echten Dateien)
  Mirror (Join-Path $blenderSrc.FullName 'portable') (Join-Path $lin 'portable')
  if (-not (Get-ChildItem (Join-Path $lin 'portable/scripts/addons/starbreaker_addon') -Filter *.py -ErrorAction SilentlyContinue)) {
    throw 'portable/scripts/addons/starbreaker_addon enthält keine .py-Dateien'
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $lin 'cli') | Out-Null
  Copy-Item src/icons/render.py (Join-Path $lin 'cli') -Force
  foreach ($f in 'setup.sh', 'check.sh', 'LIESMICH.txt') { Copy-Template (Join-Path $tpl "linux/$f") (Join-Path $lin $f) }
}

# 4. Zusammenfassung
foreach ($p in @(if ($doWin) { 'windows' }) + @(if ($doLin) { 'linux' })) {
  $files = Get-ChildItem (Join-Path $Out $p) -Recurse -File
  $mb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB)
  Write-Host "Bundle $p`: $(Join-Path $Out $p) ($mb MB, $($files.Count) Dateien)"
}
exit 0  # robocopys Exit-Code 1 (kopiert) soll nicht als Fehler zählen
