<#
 Vidsnap one-command release.
 Usage:  .\release.ps1 [-Version 0.2.2] [-Notes "..."] [-DryRun]
 -DryRun: does everything (build, sign, latest.json) but does not upload to GitHub and restores the version numbers.
#>
param(
  [string]$Version,
  [string]$Notes,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Run a native command without its stderr becoming a terminating error in PS 5.1. Returns the exit code.
function Invoke-Native([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>&1 | Out-Host } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}
function Invoke-Quiet([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command *> $null } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

$Root     = $PSScriptRoot
$AppDir   = Join-Path $Root 'desktop\app'
$Tauri    = Join-Path $AppDir 'src-tauri'
$Files    = [ordered]@{
  package  = Join-Path $AppDir 'package.json'
  cargo    = Join-Path $Tauri 'Cargo.toml'
  tauri    = Join-Path $Tauri 'tauri.conf.json'
  manifest = Join-Path $Root 'extension\manifest.json'
}
$KeyFile = Join-Path $env:USERPROFILE '.vidsnap\updater.key'
$Repo = 'berkaygulerr/vidsnap'
$Utf8 = New-Object Text.UTF8Encoding($false)
$Backup = @{}

function Restore-Versions {
  foreach ($k in @($Backup.Keys)) { [IO.File]::WriteAllText($Files[$k], $Backup[$k], $Utf8) }
  if ($Backup.Count) { Write-Host 'Version numbers restored.' -ForegroundColor Yellow; $Backup.Clear() }
}
function Fail($m) { Write-Host "`nERROR: $m" -ForegroundColor Red; Restore-Versions; exit 1 }
function Step($n, $m) { Write-Host "`n[$n/7] $m" -ForegroundColor Cyan }
function Set-Version($path, $regex, $new) {
  $t = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $r = New-Object Text.RegularExpressions.Regex($regex, 'Multiline')
  if (-not $r.IsMatch($t)) { throw "Version field not found: $path" }
  $t2 = $r.Replace($t, ('${1}' + $new + '${2}'), 1)
  [IO.File]::WriteAllText($path, $t2, $Utf8)
}

try {
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

  # --- preflight ---
  foreach ($k in $Files.Keys) { if (-not (Test-Path $Files[$k])) { Fail "Missing file: $($Files[$k])" } }
  if (-not (Test-Path $KeyFile)) { Fail "Signing key not found: $KeyFile" }
  if (-not $DryRun) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh (GitHub CLI) not found.' }
    if ((Invoke-Quiet { gh auth status }) -ne 0) { Fail 'gh is not logged in (run: gh auth login).' }
  }

  $conf = [IO.File]::ReadAllText($Files.tauri, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $Old = $conf.version
  if (-not $Version) {
    $p = $Old.Split('.')
    $Version = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "Invalid version: '$Version' (example: 0.2.2)" }
  if (-not $Notes) { $Notes = "Vidsnap $Version" }
  $Tag = "v$Version"
  $label = ''
  if ($DryRun) { $label = '(DRY RUN)' }
  Write-Host "Vidsnap $Old -> $Version  $label" -ForegroundColor Green

  if (-not $DryRun) {
    if ((Invoke-Quiet { gh release view $Tag --repo $Repo }) -eq 0) { Fail "$Tag is already released. Use a new version number." }
  }

  # --- 1. version numbers ---
  Step 1 'Updating version numbers'
  foreach ($k in $Files.Keys) { $Backup[$k] = [IO.File]::ReadAllText($Files[$k], [Text.Encoding]::UTF8) }
  Set-Version $Files.package  '^(\{"name":"vidsnap-app","version":")[^"]+(")' $Version
  Set-Version $Files.cargo    '^(version = ")[^"]+(")' $Version
  Set-Version $Files.tauri    '^(\s*"version":\s*")[^"]+(")' $Version
  Set-Version $Files.manifest '^(\s*"version":\s*")[^"]+(")' $Version
  foreach ($k in $Files.Keys) { Write-Host "  $($Files[$k])" }

  # --- 2. signing ---
  Step 2 'Preparing signing key'
  $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($KeyFile, [Text.Encoding]::UTF8).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

  # --- 3. build ---
  Step 3 'Building (npm run tauri build)'
  Push-Location $AppDir
  $built = $false
  $code = 1
  for ($attempt = 1; $attempt -le 2 -and -not $built; $attempt++) {
    & cmd /c 'npm run tauri build 2>&1' | Tee-Object -Variable output
    $code = $LASTEXITCODE
    if ($code -eq 0) { $built = $true }
    elseif ($attempt -eq 1 -and (($output -join "`n") -match '0x80000003|STATUS_BREAKPOINT|0xc0000005|STATUS_ACCESS_VIOLATION')) {
      Write-Host 'rustc crashed, retrying once...' -ForegroundColor Yellow
    } else { break }
  }
  Pop-Location
  if (-not $built) { Fail "Build failed (exit code $code)." }

  $Setup = Join-Path $Tauri "target\release\bundle\nsis\Vidsnap_${Version}_x64-setup.exe"
  $Sig = "$Setup.sig"
  if (-not (Test-Path $Setup)) { Fail "Installer was not produced: $Setup" }
  if (-not (Test-Path $Sig)) { Fail "Signature was not produced: $Sig (check the key/password settings)" }

  # --- 4. bundled extension check ---
  Step 4 'Checking the bundled extension'
  $Source = Join-Path $Root 'extension'
  $Bundled = Join-Path $Tauri 'target\release\extension'
  if (-not (Test-Path $Bundled)) { Fail "Bundled extension folder not found: $Bundled" }
  $list = {
    param($d)
    $d = (Resolve-Path $d).Path
    Get-ChildItem $d -Recurse -File | ForEach-Object {
      [pscustomobject]@{ Path = $_.FullName.Substring($d.Length).TrimStart('\'); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    }
  }
  $a = @(& $list $Source | Sort-Object Path)
  $b = @(& $list $Bundled | Sort-Object Path)
  $diff = Compare-Object $a $b -Property Path, Hash
  if ($diff) { Fail ("Bundled extension differs from 'extension':`n" + (($diff | ForEach-Object { "  $($_.SideIndicator) $($_.Path)" }) -join "`n")) }
  Write-Host "  $($a.Count) files identical."

  # --- 5. latest.json ---
  Step 5 'Writing latest.json'
  $signature = [IO.File]::ReadAllText($Sig, [Text.Encoding]::UTF8).Trim()
  $url = "https://github.com/$Repo/releases/download/$Tag/Vidsnap_${Version}_x64-setup.exe"
  $json = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    platforms = [ordered]@{ 'windows-x86_64' = [ordered]@{ signature = $signature; url = $url } }
  } | ConvertTo-Json -Depth 6
  $LatestPath = Join-Path (Split-Path $Setup) 'latest.json'
  [IO.File]::WriteAllText($LatestPath, $json, $Utf8)
  Write-Host $json

  # --- 6. publish ---
  if ($DryRun) {
    Step 6 'DRY RUN: not creating a GitHub release'
    Restore-Versions
  } else {
    Step 6 'Creating GitHub release'
    $NotesFile = Join-Path $env:TEMP "vidsnap-notes-$Version.txt"
    [IO.File]::WriteAllText($NotesFile, $Notes, $Utf8)
    if ((Invoke-Native { gh release create $Tag --repo $Repo --title "Vidsnap $Version" --notes-file $NotesFile --latest $Setup $Sig $LatestPath }) -ne 0) { Fail 'gh release create failed.' }
    Remove-Item $NotesFile -ErrorAction SilentlyContinue
  }

  # --- 7. summary ---
  Step 7 'Summary'
  $size = '{0:N1} MB' -f ((Get-Item $Setup).Length / 1MB)
  Write-Host ''
  Write-Host "  Version    : $Version"
  Write-Host "  Installer  : $Setup ($size)"
  Write-Host "  latest.json: $LatestPath"
  if ($DryRun) {
    Write-Host "  Status     : DRY RUN done - nothing uploaded, version numbers restored." -ForegroundColor Yellow
  } else {
    Write-Host "  Status     : RELEASED -> https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Green
    Write-Host '  Installed apps will update themselves within 6 hours (or via Settings > Check for updates).'
    Write-Host '  Remember to commit and push the version bump (git commit -am "Release vX.Y.Z" && git push).'
  }
  exit 0
} catch {
  Fail $_.Exception.Message
}
