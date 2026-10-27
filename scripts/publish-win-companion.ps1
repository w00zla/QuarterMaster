#Requires -Version 7
# Publishes the built Windows companion release (pnpm companion:build first): the NSIS setup with its
# updater signature and the standalone zip (the exe with DirectML.dll for the OCR on the GPU) go to local/companion/ (as quartermaster-companion_<v>_x64-setup.exe(.sig) and
# _x64-standalone.zip), companion.json gets the version and both files (a linux entry stays), then the
# files the manifest names go to the VM's checkout, the manifest last (copied first, it would send
# outdated apps to downloads that are not there yet; like push-companion.sh).
#
#   scripts/publish-win-companion.ps1 <user@host> [-DeployPath /opt/sc-quartermaster]
#
# The version is the one in Cargo.toml (the build's file names carry it).
param(
  [Parameter(Mandatory)][string]$Target,
  [string]$DeployPath = '/opt/sc-quartermaster'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$cargo = Get-Content companion/src-tauri/Cargo.toml -Raw
if ($cargo -notmatch '(?m)^version = "(\d+\.\d+\.\d+)"') { throw 'No version in companion/src-tauri/Cargo.toml' }
$version = $Matches[1]

$release = 'companion/src-tauri/target/release'
$setup = "$release/bundle/nsis/Quartermaster Companion_${version}_x64-setup.exe"
# The one the setup bundles too (pnpm --filter sc-quartermaster-companion ocr:models)
$dml = 'companion/src-tauri/resources/ocr/DirectML.dll'
foreach ($f in $setup, "$setup.sig", "$release/quartermaster-companion.exe", $dml) {
  if (-not (Test-Path -LiteralPath $f)) { throw "Missing build output: $f (pnpm companion:build first)" }
}

$dir = 'local/companion'
New-Item -ItemType Directory -Force $dir | Out-Null
$setupName = "quartermaster-companion_${version}_x64-setup.exe"
$zipName = "quartermaster-companion_${version}_x64-standalone.zip"
Copy-Item -LiteralPath $setup "$dir/$setupName"
Copy-Item -LiteralPath "$setup.sig" "$dir/$setupName.sig"
Compress-Archive -LiteralPath "$release/quartermaster-companion.exe", $dml -DestinationPath "$dir/$zipName" -Force

$manifest = "$dir/companion.json"
$m = if (Test-Path $manifest) { Get-Content $manifest -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$m.version = $version
$m.windows = $zipName
$m.windowsSetup = $setupName
# Always in this order (version, windows, linux, windowsSetup)
$out = [ordered]@{ version = $m.version; windows = $m.windows }
if ($m.linux) { $out.linux = $m.linux }
$out.windowsSetup = $m.windowsSetup
$out | ConvertTo-Json | Set-Content $manifest
Write-Host "==> $manifest written"

$files = @($out.windows, $out.linux, $out.windowsSetup, "$($out.windowsSetup).sig") | Where-Object { $_ } | ForEach-Object { "$dir/$_" }
foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath $f)) { throw "Missing in ${dir}: $f" }
}

$dest = "${Target}:$DeployPath/$dir/"
Write-Host "==> Companion $version to $dest"
scp @files $dest
if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE)" }
scp $manifest $dest
if ($LASTEXITCODE -ne 0) { throw "scp of the manifest failed ($LASTEXITCODE)" }
Write-Host '==> Done: the web app picks the manifest up within seconds'
