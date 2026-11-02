# Packs everything the Rust tool packshot (tools/packshot) needs on another machine, one folder per platform:
#   <Out>/windows: packshot.exe, StarBreaker (our fork), portable Blender with the add-on, render.py, targets.json,
#                  run.cmd, README.txt, packshot.example.json
#   <Out>/linux:   packshot (static musl binary), the official Blender tarball (SHA256 checked), portable/ (config +
#                  add-on), render.py, setup.sh and check.sh (unpack and check on the Linux box), run-node.sh,
#                  README.txt, packshot.example.json
# Run from the repo root (pwsh or Windows PowerShell 5.1):
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

# Native programs set $LASTEXITCODE but do not throw
function Assert-Ok([string]$what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

# Mirror a folder: robocopy exit codes < 8 are success (1 = copied, 0 = unchanged)
function Mirror([string]$src, [string]$dst) {
  robocopy $src $dst /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $src failed ($LASTEXITCODE)" }
}

# Copy a template with LF line endings (the .sh need LF, however the template was checked out)
function Copy-Template([string]$src, [string]$dst) {
  $text = [IO.File]::ReadAllText($src).Replace("`r`n", "`n")
  $enc = if ($dst -like '*.txt') { New-Object Text.UTF8Encoding $true } else { New-Object Text.UTF8Encoding $false }
  [IO.File]::WriteAllText($dst, $text, $enc)
}

# Folder of the local Windows Blender (with blender.exe)
$blenderSrc = Get-ChildItem local/blender -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'blender.exe') } | Select-Object -First 1
if (-not $blenderSrc) { throw 'No Blender under local/blender/*/blender.exe' }

# 1. Build
Push-Location $crate
try {
  if ($doWin) {
    Write-Host 'Building packshot (Windows) ...'
    cargo build --release
    Assert-Ok 'cargo build (Windows)'
  }
  if ($doLin) {
    Write-Host 'Building packshot (Linux, musl) ...'
    cargo build --release --target x86_64-unknown-linux-musl
    Assert-Ok 'cargo build (Linux)'
  }
} finally {
  Pop-Location
}

# 2. Windows bundle
if ($doWin) {
  $win = Join-Path $Out 'windows'
  New-Item -ItemType Directory -Force -Path $win | Out-Null
  Copy-Item (Join-Path $crate 'target/release/packshot.exe') $win -Force

  New-Item -ItemType Directory -Force -Path (Join-Path $win 'starbreaker') | Out-Null
  Copy-Item local/starbreaker-qm/starbreaker.exe, local/starbreaker-qm/COMMIT (Join-Path $win 'starbreaker') -Force

  Write-Host "Copying Blender ($($blenderSrc.Name)) ..."
  Mirror $blenderSrc.FullName (Join-Path $win 'blender')

  New-Item -ItemType Directory -Force -Path (Join-Path $win 'cli') | Out-Null
  Copy-Item src/icons/render.py (Join-Path $win 'cli') -Force

  # Target list from the DB (needs DATABASE_URL from .env)
  Write-Host 'Target list from the DB ...'
  pnpm packshot:targets --out (Join-Path $win 'targets.json')
  Assert-Ok 'writing targets.json'

  # Launcher: all arguments go to packshot
  "@echo off`r`ncd /d `"%~dp0`"`r`n`"%~dp0packshot.exe`" %*`r`n" | Set-Content -Path (Join-Path $win 'run.cmd') -Encoding ASCII -NoNewline
  Copy-Template (Join-Path $tpl 'windows/README.txt') (Join-Path $win 'README.txt')
  Copy-Template (Join-Path $tpl 'packshot.example.json') (Join-Path $win 'packshot.example.json')
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $win 'LIESMICH.txt')
}

# 3. Linux bundle
if ($doLin) {
  $lin = Join-Path $Out 'linux'
  New-Item -ItemType Directory -Force -Path $lin | Out-Null
  Copy-Item (Join-Path $crate 'target/x86_64-unknown-linux-musl/release/packshot') $lin -Force

  # Blender tarball: downloaded once into cache/, checked against the published SHA256, put into the bundle packed
  # (unpacking on Windows would lose symlinks and exec bits: setup.sh does that on the Linux box)
  $minor = ($BlenderVersion -split '\.')[0..1] -join '.'
  $base = "https://download.blender.org/release/Blender$minor"
  $tarName = "blender-$BlenderVersion-linux-x64.tar.xz"
  $cache = Join-Path $Out 'cache'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $tar = Join-Path $cache $tarName
  if (-not (Test-Path $tar)) {
    Write-Host "Downloading Blender $BlenderVersion (Linux) ..."
    $ProgressPreference = 'SilentlyContinue'  # else Invoke-WebRequest is extremely slow in 5.1
    Invoke-WebRequest -Uri "$base/$tarName" -OutFile "$tar.part"
    Move-Item "$tar.part" $tar -Force
  }
  $sums = (Invoke-WebRequest -Uri "$base/blender-$BlenderVersion.sha256" -UseBasicParsing).Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($tarName) } | Select-Object -First 1) -replace '\s.*$', ''
  if (-not $expected) { throw "No SHA256 for $tarName in $base/blender-$BlenderVersion.sha256" }
  $actual = (Get-FileHash $tar -Algorithm SHA256).Hash
  if ($actual -ne $expected.Trim().ToUpperInvariant()) {
    Remove-Item -Force $tar
    throw "SHA256 mismatch ($actual, expected $expected): download deleted"
  }
  Write-Host "SHA256 ok ($tarName)"
  Copy-Item $tar $lin -Force

  # portable/: config and add-on of the local Blender (the add-on is a junction: robocopy follows it with real files)
  Mirror (Join-Path $blenderSrc.FullName 'portable') (Join-Path $lin 'portable')
  if (-not (Get-ChildItem (Join-Path $lin 'portable/scripts/addons/starbreaker_addon') -Filter *.py -ErrorAction SilentlyContinue)) {
    throw 'portable/scripts/addons/starbreaker_addon holds no .py files'
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $lin 'cli') | Out-Null
  Copy-Item src/icons/render.py (Join-Path $lin 'cli') -Force
  foreach ($f in 'setup.sh', 'check.sh', 'run-node.sh', 'README.txt') { Copy-Template (Join-Path $tpl "linux/$f") (Join-Path $lin $f) }
  Copy-Template (Join-Path $tpl 'packshot.example.json') (Join-Path $lin 'packshot.example.json')
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $lin 'LIESMICH.txt')
}

# 4. Summary
foreach ($p in @(if ($doWin) { 'windows' }) + @(if ($doLin) { 'linux' })) {
  $files = Get-ChildItem (Join-Path $Out $p) -Recurse -File
  $mb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB)
  Write-Host "Bundle $p`: $(Join-Path $Out $p) ($mb MB, $($files.Count) files)"
}
exit 0  # robocopy's exit code 1 (copied) must not count as a failure
