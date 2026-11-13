# Vidsnap kurulum betigi
# Yardimci programi Chrome ve Edge'e tanitir. Yonetici yetkisi gerekmez (HKCU).
# Kullanim:  powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir   = Join-Path $Root 'host'
$ToolsDir  = Join-Path $Root 'tools'
$HostName  = 'com.vidsnap.host'
$ExtId     = 'mfcampdflhbbpeajcmnhleahaglnipin'   # extension/manifest.json icindeki "key" ile sabitlenmis
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8($Path, $Text) { [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom) }

# --- Node ---
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js bulunamadi. https://nodejs.org adresinden kurun ve tekrar deneyin.' }
Write-Host "Node    : $node"

# --- yt-dlp ---
$ytdlp = (Get-Command yt-dlp -ErrorAction SilentlyContinue).Source
if (-not $ytdlp) {
  New-Item -ItemType Directory -Force $ToolsDir | Out-Null
  $ytdlp = Join-Path $ToolsDir 'yt-dlp.exe'
  Write-Host 'yt-dlp indiriliyor (resmi GitHub surumu)...'
  Invoke-WebRequest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytdlp -UseBasicParsing
} else {
  Write-Host 'yt-dlp guncelleniyor...'
  try { & $ytdlp -U | Out-Host } catch { Write-Warning "yt-dlp guncellenemedi: $_" }
}
Write-Host "yt-dlp  : $ytdlp"

# --- ffmpeg ---
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
  throw 'ffmpeg bulunamadi. Su komutla kurun, sonra bu betigi tekrar calistirin:  winget install Gyan.FFmpeg'
}
$ffmpegDir = Split-Path -Parent $ffmpeg
Write-Host "ffmpeg  : $ffmpegDir"

# --- Indirme klasoru ---
$downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
if (-not $downloads) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }
Write-Host "Klasor  : $downloads"

# --- Dosyalar ---
$config = [ordered]@{ ytdlp = $ytdlp; ffmpegDir = $ffmpegDir; downloadDir = $downloads }
Write-Utf8 (Join-Path $HostDir 'config.json') ($config | ConvertTo-Json)

$bat = Join-Path $HostDir 'vidsnap-host.bat'
Write-Utf8 $bat "@echo off`r`n`"$node`" `"%~dp0host.js`" %*`r`n"

$manifestPath = Join-Path $HostDir "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Vidsnap video indirme yardimcisi'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
}
Write-Utf8 $manifestPath ($manifest | ConvertTo-Json)

# --- Eski adla (yt-down) kalan kayitlari temizle ---
foreach ($b in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')) {
  Remove-Item -Path "HKCU:\Software\$b\NativeMessagingHosts\com.ytdown.host" -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $HostDir "ytdown-host.bat"), (Join-Path $HostDir "com.ytdown.host.json") -Force -ErrorAction SilentlyContinue

# --- Kayit defteri (sadece bu kullanici) ---
$keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($k in $keys) {
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name '(default)' -Value $manifestPath
}

Write-Host ''
Write-Host 'Kurulum tamam.' -ForegroundColor Green
Write-Host "Simdi Chrome'da chrome://extensions > Gelistirici modu > 'Paketlenmemis oge yukle' ile su klasoru secin:"
Write-Host "  $(Join-Path $Root 'extension')"
