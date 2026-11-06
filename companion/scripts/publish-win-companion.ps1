#Requires -Version 7
# Publishes the built Windows companion release (pnpm companion:build first): the NSIS setup with its
# updater signature and the standalone zip (the exe with DirectML.dll for the OCR on the GPU) go to local/companion/ (as quartermaster-companion_<v>_x64-setup.exe(.sig) and
# _x64-standalone.zip), companion.json gets the version and both files (a linux entry stays), then
# scripts/push-companion.mjs copies the files the manifest names to the VM's checkout, the manifest last
# (the one push implementation, Node + Windows' OpenSSH scp).
#
#   scripts/publish-win-companion.ps1 <user@host> [-DeployPath /opt/sc-quartermaster]
#
# Environment (same names as in sc-quartermaster):
#   COMPANION_DIR  local release folder, relative to the repo root or absolute (default local/companion)
#   DEPLOY_PATH    the sc-quartermaster checkout on the VM (default /opt/sc-quartermaster; -DeployPath wins);
#                  the files go to <DeployPath>/local/companion/
#
# The version is the one in Cargo.toml (the build's file names carry it).
param(
  [Parameter(Mandatory)][string]$Target,
  [string]$DeployPath = $(if ($env:DEPLOY_PATH) { $env:DEPLOY_PATH } else { '/opt/sc-quartermaster' })
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$cargo = Get-Content src-tauri/Cargo.toml -Raw
if ($cargo -notmatch '(?m)^version = "(\d+\.\d+\.\d+)"') { throw 'No version in src-tauri/Cargo.toml' }
$version = $Matches[1]

$release = 'src-tauri/target/release'
$setup = "$release/bundle/nsis/Quartermaster Companion_${version}_x64-setup.exe"
# The one the setup bundles too (pnpm directml)
$dml = 'src-tauri/resources/ocr/DirectML.dll'
foreach ($f in $setup, "$setup.sig", "$release/quartermaster-companion.exe", $dml) {
  if (-not (Test-Path -LiteralPath $f)) { throw "Missing build output: $f (pnpm companion:build first)" }
}

$dir = if ($env:COMPANION_DIR) { $env:COMPANION_DIR } else { 'local/companion' }
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

# The push reads DEPLOY_PATH and COMPANION_DIR; set for it only, the caller's session keeps its own
$saved = $env:DEPLOY_PATH, $env:COMPANION_DIR
try {
  $env:DEPLOY_PATH = $DeployPath
  $env:COMPANION_DIR = $dir
  node scripts/push-companion.mjs $Target
  if ($LASTEXITCODE -ne 0) { throw "push-companion.mjs failed ($LASTEXITCODE)" }
} finally {
  $env:DEPLOY_PATH, $env:COMPANION_DIR = $saved
}
