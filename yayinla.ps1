<#
 Vidsnap tek komutla surum yayinlama.
 Kullanim:  .\yayinla.ps1 [-Surum 0.2.1] [-Notlar "..."] [-KuruDeneme]
 -KuruDeneme: her seyi yapar (derleme, imza, latest.json) ama GitHub'a yuklemez ve surum numaralarini geri alir.
#>
param(
  [string]$Surum,
  [string]$Notlar,
  [switch]$KuruDeneme
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Harici komutu calistir; stderr ciktisi PS 5.1'de durdurucu hataya donmesin. Cikis kodunu dondurur.
function Calistir([scriptblock]$Komut) {
  $onceki = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Komut 2>&1 | Out-Host } finally { $ErrorActionPreference = $onceki }
  return $LASTEXITCODE
}
function Sessiz([scriptblock]$Komut) {
  $onceki = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Komut *> $null } finally { $ErrorActionPreference = $onceki }
  return $LASTEXITCODE
}

$Kok      = $PSScriptRoot
$AppDir   = Join-Path $Kok 'desktop\app'
$Tauri    = Join-Path $AppDir 'src-tauri'
$Dosyalar = [ordered]@{
  package  = Join-Path $AppDir 'package.json'
  cargo    = Join-Path $Tauri 'Cargo.toml'
  tauri    = Join-Path $Tauri 'tauri.conf.json'
  manifest = Join-Path $Kok 'extension\manifest.json'
}
$AnahtarDosyasi = Join-Path $env:USERPROFILE '.vidsnap\updater.key'
$Repo = 'berkaygulerr/vidsnap'
$Utf8 = New-Object Text.UTF8Encoding($false)
$Yedek = @{}

function Geri-Al {
  foreach ($k in @($Yedek.Keys)) { [IO.File]::WriteAllText($Dosyalar[$k], $Yedek[$k], $Utf8) }
  if ($Yedek.Count) { Write-Host 'Surum numaralari eski haline getirildi.' -ForegroundColor Yellow; $Yedek.Clear() }
}
function Hata($m) { Write-Host "`nHATA: $m" -ForegroundColor Red; Geri-Al; exit 1 }
function Adim($n, $m) { Write-Host "`n[$n/7] $m" -ForegroundColor Cyan }
function Surum-Yaz($yol, $regex, $yeni) {
  $t = [IO.File]::ReadAllText($yol, [Text.Encoding]::UTF8)
  $r = New-Object Text.RegularExpressions.Regex($regex, 'Multiline')
  if (-not $r.IsMatch($t)) { throw "Surum alani bulunamadi: $yol" }
  $t2 = $r.Replace($t, ('${1}' + $yeni + '${2}'), 1)
  [IO.File]::WriteAllText($yol, $t2, $Utf8)
}

try {
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

  # --- on kontroller ---
  foreach ($k in $Dosyalar.Keys) { if (-not (Test-Path $Dosyalar[$k])) { Hata "Dosya yok: $($Dosyalar[$k])" } }
  if (-not (Test-Path $AnahtarDosyasi)) { Hata "Imza anahtari yok: $AnahtarDosyasi" }
  if (-not $KuruDeneme) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Hata 'gh (GitHub CLI) bulunamadi.' }
    if ((Sessiz { gh auth status }) -ne 0) { Hata 'gh oturumu acik degil (gh auth login).' }
  }

  $conf = [IO.File]::ReadAllText($Dosyalar.tauri, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $Eski = $conf.version
  if (-not $Surum) {
    $p = $Eski.Split('.')
    $Surum = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
  }
  if ($Surum -notmatch '^\d+\.\d+\.\d+$') { Hata "Gecersiz surum: '$Surum' (ornek: 0.2.1)" }
  if (-not $Notlar) { $Notlar = "Vidsnap $Surum" }
  $Tag = "v$Surum"
  $etiket = ''
  if ($KuruDeneme) { $etiket = '(KURU DENEME)' }
  Write-Host "Vidsnap $Eski -> $Surum  $etiket" -ForegroundColor Green

  if (-not $KuruDeneme) {
    if ((Sessiz { gh release view $Tag --repo $Repo }) -eq 0) { Hata "$Tag surumu zaten yayinlanmis. Yeni bir surum numarasi ver." }
  }

  # --- 1. surum numaralari ---
  Adim 1 'Surum numaralari guncelleniyor'
  foreach ($k in $Dosyalar.Keys) { $Yedek[$k] = [IO.File]::ReadAllText($Dosyalar[$k], [Text.Encoding]::UTF8) }
  Surum-Yaz $Dosyalar.package  '^(\{"name":"vidsnap-app","version":")[^"]+(")' $Surum
  Surum-Yaz $Dosyalar.cargo    '^(version = ")[^"]+(")' $Surum
  Surum-Yaz $Dosyalar.tauri    '^(\s*"version":\s*")[^"]+(")' $Surum
  Surum-Yaz $Dosyalar.manifest '^(\s*"version":\s*")[^"]+(")' $Surum
  foreach ($k in $Dosyalar.Keys) { Write-Host "  $($Dosyalar[$k])" }

  # --- 2. imza ortami ---
  Adim 2 'Imza anahtari hazirlaniyor'
  $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($AnahtarDosyasi, [Text.Encoding]::UTF8).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''

  # --- 3. derleme ---
  Adim 3 'Derleniyor (npm run tauri build)'
  Push-Location $AppDir
  $bitti = $false
  $kod = 1
  for ($deneme = 1; $deneme -le 2 -and -not $bitti; $deneme++) {
    & cmd /c 'npm run tauri build 2>&1' | Tee-Object -Variable tum
    $kod = $LASTEXITCODE
    if ($kod -eq 0) { $bitti = $true }
    elseif ($deneme -eq 1 -and (($tum -join "`n") -match '0x80000003|STATUS_BREAKPOINT|0xc0000005|STATUS_ACCESS_VIOLATION')) {
      Write-Host 'rustc coktu (0x80000003), bir kez daha deneniyor...' -ForegroundColor Yellow
    } else { break }
  }
  Pop-Location
  if (-not $bitti) { Hata "Derleme basarisiz (cikis kodu $kod)." }

  $Setup = Join-Path $Tauri "target\release\bundle\nsis\Vidsnap_${Surum}_x64-setup.exe"
  $Sig = "$Setup.sig"
  if (-not (Test-Path $Setup)) { Hata "Kurulum dosyasi uretilmedi: $Setup" }
  if (-not (Test-Path $Sig)) { Hata "Imza dosyasi uretilmedi: $Sig (anahtar/sifre ayarini kontrol et)" }

  # --- 4. eklenti dogrulama ---
  Adim 4 'Paketlenen eklenti kontrol ediliyor'
  $Kaynak = Join-Path $Kok 'extension'
  $Paket = Join-Path $Tauri 'target\release\extension'
  if (-not (Test-Path $Paket)) { Hata "Paketlenen eklenti klasoru yok: $Paket" }
  $liste = {
    param($d)
    $d = (Resolve-Path $d).Path
    Get-ChildItem $d -Recurse -File | ForEach-Object {
      [pscustomobject]@{ Yol = $_.FullName.Substring($d.Length).TrimStart('\'); Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
    }
  }
  $a = @(& $liste $Kaynak | Sort-Object Yol)
  $b = @(& $liste $Paket | Sort-Object Yol)
  $fark = Compare-Object $a $b -Property Yol, Hash
  if ($fark) { Hata ("Paketlenen eklenti 'extension' ile ayni degil:`n" + (($fark | ForEach-Object { "  $($_.SideIndicator) $($_.Yol)" }) -join "`n")) }
  Write-Host "  $($a.Count) dosya birebir ayni."

  # --- 5. latest.json ---
  Adim 5 'latest.json olusturuluyor'
  $imza = [IO.File]::ReadAllText($Sig, [Text.Encoding]::UTF8).Trim()
  $url = "https://github.com/$Repo/releases/download/$Tag/Vidsnap_${Surum}_x64-setup.exe"
  $json = [ordered]@{
    version   = $Surum
    notes     = $Notlar
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    platforms = [ordered]@{ 'windows-x86_64' = [ordered]@{ signature = $imza; url = $url } }
  } | ConvertTo-Json -Depth 6
  $LatestYolu = Join-Path (Split-Path $Setup) 'latest.json'
  [IO.File]::WriteAllText($LatestYolu, $json, $Utf8)
  Write-Host $json

  # --- 6. yayin ---
  if ($KuruDeneme) {
    Adim 6 'KURU DENEME: GitHub surumu olusturulmuyor'
    Geri-Al
  } else {
    Adim 6 'GitHub surumu olusturuluyor'
    $NotDosyasi = Join-Path $env:TEMP "vidsnap-notlar-$Surum.txt"
    [IO.File]::WriteAllText($NotDosyasi, $Notlar, $Utf8)
    if ((Calistir { gh release create $Tag --repo $Repo --title "Vidsnap $Surum" --notes-file $NotDosyasi --latest $Setup $Sig $LatestYolu }) -ne 0) { Hata 'gh release create basarisiz.' }
    Remove-Item $NotDosyasi -ErrorAction SilentlyContinue
  }

  # --- 7. ozet ---
  Adim 7 'Ozet'
  $boyut = '{0:N1} MB' -f ((Get-Item $Setup).Length / 1MB)
  Write-Host ''
  Write-Host "  Surum      : $Surum"
  Write-Host "  Kurulum    : $Setup ($boyut)"
  Write-Host "  latest.json: $LatestYolu"
  if ($KuruDeneme) {
    Write-Host "  Durum      : KURU DENEME tamam - GitHub'a hicbir sey yuklenmedi, surum numaralari geri alindi." -ForegroundColor Yellow
  } else {
    Write-Host "  Durum      : YAYINLANDI -> https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Green
    Write-Host '  Kurulu uygulamalar 6 saat icinde (veya Ayarlar > Guncellemeleri denetle ile) kendini guncelleyecek.'
  }
  exit 0
} catch {
  Hata $_.Exception.Message
}
