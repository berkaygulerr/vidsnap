# Vidsnap - tarayici eklentisini Windows UI Automation ile otomatik yukler.
# Cikti: satir basina bir JSON nesnesi (stdout). Cikis kodu 0 = basarili.
# Dosya UTF-8 BOM ile kaydedilmistir; regex'ler yine de ASCII'dir (. joker).
param(
  [Parameter(Mandatory = $true)][string]$Browser,
  [Parameter(Mandatory = $true)][string]$Page,
  [Parameter(Mandatory = $true)][string]$ExtDir,
  [string]$UserDataDir = ''   # yalnizca test: gecici profil ile baslatir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Emit([string]$step, [bool]$ok, [string]$msg = '') {
  $o = [ordered]@{ step = $step; ok = $ok }
  if ($msg) { $o.message = $msg }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}
function EmitDone([bool]$ok, [string]$failed = '', [string]$msg = '') {
  $o = [ordered]@{ done = $true; ok = $ok }
  if ($failed) { $o.failedStep = $failed }
  if ($msg) { $o.message = $msg }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}
function StepFail([string]$step, [string]$msg) { throw "STEP|$step|$msg" }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VsWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Gorunur, basligi olan ust duzey Chromium pencereleri (verilen PID kumesine ait)
  public static long[] TopWindows(uint[] pids) {
    var set = new HashSet<uint>(pids); var res = new List<long>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (!set.Contains(p)) return true;
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(8); if (GetWindowText(h, t, 8) == 0) return true;
      res.Add(h.ToInt64()); return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); // ALT: on plan kilidini asar
    SetForegroundWindow(h);
  }
}
'@

$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TrueC = [System.Windows.Automation.Condition]::TrueCondition
$exeName = [IO.Path]::GetFileNameWithoutExtension($Browser)

# ---- pano (STA runspace: powershell.exe -File varsayilan olarak MTA) ----
$script:staRs = [runspacefactory]::CreateRunspace()
$script:staRs.ApartmentState = 'STA'; $script:staRs.ThreadOptions = 'ReuseThread'; $script:staRs.Open()
function InSta([scriptblock]$sb, $arg) {
  $ps = [powershell]::Create(); $ps.Runspace = $script:staRs
  try {
    [void]$ps.AddScript($sb.ToString()).AddArgument($arg)
    $r = $ps.Invoke()
    if ($ps.HadErrors) { throw ($ps.Streams.Error | Select-Object -First 1) }
    return ($r | Select-Object -First 1)
  } finally { $ps.Dispose() }
}
function Clip-GetText {
  try { InSta { param($x) Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() } else { $null } } $null } catch { $null }
}
function Clip-SetText([string]$t) {
  for ($i = 0; $i -lt 5; $i++) {
    try { [void](InSta { param($x) Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText($x) } $t); return $true } catch { Start-Sleep -Milliseconds 200 }
  }
  return $false
}
function Clip-Clear { try { [void](InSta { param($x) Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear() } $null) } catch {} }

function Browser-Pids {
  @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
}
function Browser-Windows {
  $pids = [uint32[]]@(Browser-Pids)
  if ($pids.Length -eq 0) { return [long[]]@() }
  return [long[]]@([VsWin]::TopWindows($pids))
}

function Find-ByName($root, [string]$regex, [int]$timeoutSec = 15, [switch]$Actionable) {
  $end = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $end) {
    try {
      foreach ($e in $root.FindAll($TS::Descendants, $TrueC)) {
        $n = $e.Current.Name
        if ($n -and $n -match $regex) {
          if (-not $Actionable) { return $e }
          $pats = $e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }
          if ($pats -match 'Toggle|Invoke') { return $e }
        }
      }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
  return $null
}

$savedClip = $null; $clipSaved = $false
$loadAsync = $null; $loadPs = $null; $loadRs = $null
$ok = $false; $failedStep = ''; $failMsg = ''
try {
  if (-not (Test-Path -LiteralPath $Browser -PathType Leaf)) { StepFail 'open' 'Tarayici bulunamadi' }
  if (-not (Test-Path -LiteralPath (Join-Path $ExtDir 'manifest.json'))) { StepFail 'open' 'Eklenti klasoru bulunamadi' }
  if ($Page -notmatch '^(chrome|brave|edge)://extensions/?$') { StepFail 'open' 'Gecersiz sayfa' }

  # ---------- 1) open ----------
  $before = Browser-Windows
  $launchArgs = @()
  if ($UserDataDir) { $launchArgs += "--user-data-dir=`"$UserDataDir`""; $launchArgs += '--no-first-run'; $launchArgs += '--no-default-browser-check' }
  $launchArgs += '--new-window'
  $launchArgs += 'about:blank'
  Start-Process -FilePath $Browser -ArgumentList $launchArgs | Out-Null
  $hwnd = [IntPtr]::Zero
  $end = (Get-Date).AddSeconds(20)
  while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $end) {
    $now = Browser-Windows
    $new = @($now | Where-Object { $before -notcontains $_ })
    if ($new.Count) { $hwnd = [IntPtr]$new[0]; break }
    Start-Sleep -Milliseconds 300
  }
  if ($hwnd -eq [IntPtr]::Zero) {
    # yedek: bu tarayicinin on plandaki penceresi
    $fg = [VsWin]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero -and (Browser-Pids) -contains [VsWin]::PidOf($fg)) { $hwnd = $fg }
  }
  if ($hwnd -eq [IntPtr]::Zero) { StepFail 'open' 'Tarayici penceresi bulunamadi' }
  $win = $A::FromHandle($hwnd)
  [VsWin]::Focus($hwnd)
  $wp = $null
  if ($win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
    try { $wp.SetWindowVisualState('Maximized') } catch {}
  }
  Start-Sleep -Milliseconds 800
  [VsWin]::Focus($hwnd)
  Emit 'open' $true

  # ---------- 2) navigate ----------
  $editCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
  $omni = $null
  $end = (Get-Date).AddSeconds(15)
  while (-not $omni -and (Get-Date) -lt $end) {
    try { $omni = $win.FindFirst($TS::Descendants, $editCond) } catch {}
    if (-not $omni) { Start-Sleep -Milliseconds 300 }
  }
  if (-not $omni) { StepFail 'navigate' 'Adres cubugu bulunamadi' }
  [VsWin]::Focus($hwnd)
  try { $omni.SetFocus() } catch {}
  $omni.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Page)
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Seconds 2
  Emit 'navigate' $true

  # ---------- 3) devmode ----------
  $isToggle = { param($e) ($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -match 'Toggle' }
  $dev = $null
  $end = (Get-Date).AddSeconds(15)
  while (-not $dev -and (Get-Date) -lt $end) {
    try {
      $all = @($win.FindAll($TS::Descendants, $TrueC))
      $labels = @($all | Where-Object { $_.Current.Name -match '^(Developer mode|Geli.tirici modu)$' })
      $dev = $labels | Where-Object { & $isToggle $_ } | Select-Object -First 1
      if (-not $dev -and $labels.Count) {
        $lr = $labels[0].Current.BoundingRectangle
        $cy = $lr.Top + $lr.Height / 2
        $dev = $all | Where-Object { & $isToggle $_ } | Where-Object {
          $r = $_.Current.BoundingRectangle; ($r.Top -le $cy + 12) -and ($r.Bottom -ge $cy - 12)
        } | Sort-Object { [math]::Abs($_.Current.BoundingRectangle.Left - $lr.Right) } | Select-Object -First 1
      }
    } catch { $dev = $null }
    if (-not $dev) { Start-Sleep -Milliseconds 400 }
  }
  if (-not $dev) { StepFail 'devmode' 'Gelistirici modu anahtari bulunamadi' }
  $tp = $null
  if ($dev.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
    if ($tp.Current.ToggleState -ne 'On') { $tp.Toggle(); Start-Sleep -Milliseconds 600 }
  } else {
    $dev.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 600
  }
  Emit 'devmode' $true

  # ---------- 4) load ----------
  $load = Find-ByName $win '^(Load unpacked|Paketlenmemi. ..e y.kle|Paketlenmemi. uzant.y. y.kle)$' 15 -Actionable
  if (-not $load) { StepFail 'load' 'Paketlenmemis yukle dugmesi bulunamadi' }
  [VsWin]::Focus($hwnd)
  # Invoke() modal pencere kapanana kadar bloklar: ayri runspace
  $loadRs = [runspacefactory]::CreateRunspace(); $loadRs.Open()
  $loadPs = [powershell]::Create(); $loadPs.Runspace = $loadRs
  [void]$loadPs.AddScript({ param($e) $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }).AddArgument($load)
  $loadAsync = $loadPs.BeginInvoke()
  Emit 'load' $true

  # ---------- 5) dialog ----------
  $dlg = $null
  $dcond = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, '#32770')
  $end = (Get-Date).AddSeconds(15)
  while (-not $dlg -and (Get-Date) -lt $end) {
    try {
      $dlg = $win.FindFirst($TS::Children, $dcond)
      if (-not $dlg) { $dlg = $A::RootElement.FindFirst($TS::Children, $dcond) }
    } catch {}
    if (-not $dlg) { Start-Sleep -Milliseconds 300 }
  }
  if (-not $dlg) { StepFail 'dialog' 'Klasor secme penceresi acilmadi' }
  $dh = [IntPtr]$dlg.Current.NativeWindowHandle
  [VsWin]::Focus($dh)
  Start-Sleep -Milliseconds 500
  Emit 'dialog' $true

  # ---------- 6) select ----------
  $savedClip = Clip-GetText; $clipSaved = $true
  if (-not (Clip-SetText $ExtDir)) { StepFail 'select' 'Pano kullanilamadi' }
  [VsWin]::Focus($dh)
  [System.Windows.Forms.SendKeys]::SendWait('%d')
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 1200
  $btnCond = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Button')
  $okBtn = $null
  $end = (Get-Date).AddSeconds(10)
  while (-not $okBtn -and (Get-Date) -lt $end) {
    try {
      $btns = @($dlg.FindAll($TS::Descendants, $btnCond))
      $okBtn = $btns | Where-Object { $_.Current.Name -match '^(Select Folder|Klas.r Se.)$' } | Select-Object -First 1
      if (-not $okBtn) { $okBtn = $btns | Where-Object { $_.Current.AutomationId -eq '1' } | Select-Object -First 1 }
    } catch {}
    if (-not $okBtn) { Start-Sleep -Milliseconds 300 }
  }
  if (-not $okBtn) { StepFail 'select' 'Klasor sec dugmesi bulunamadi' }
  [void][VsWin]::SendMessage([IntPtr]$okBtn.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
  $end = (Get-Date).AddSeconds(10); $gone = $false
  while ((Get-Date) -lt $end) {
    if (-not [VsWin]::IsWindow($dh)) { $gone = $true; break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $gone) { StepFail 'select' 'Klasor penceresi kapanmadi' }
  Emit 'select' $true

  # ---------- 7) verify ----------
  [VsWin]::Focus($hwnd)
  $card = Find-ByName $win 'Vidsnap' 15
  if (-not $card) { StepFail 'verify' 'Eklenti karti gorunmedi' }
  Emit 'verify' $true
  $ok = $true
} catch {
  $m = "$_"
  if ($m -like 'STEP|*') {
    $p = $m.Split('|', 3); $failedStep = $p[1]; $failMsg = $p[2]
  } else {
    $failedStep = 'unknown'; $failMsg = $m
  }
  Emit $failedStep $false $failMsg
} finally {
  if ($clipSaved) {
    if ($null -ne $savedClip -and $savedClip -ne '') { [void](Clip-SetText $savedClip) } else { Clip-Clear }
  }
  try { if ($loadPs -and $loadAsync -and $loadAsync.IsCompleted) { [void]$loadPs.EndInvoke($loadAsync) } } catch {}
  try { $script:staRs.Close() } catch {}
}
if ($ok) { EmitDone $true; exit 0 } else { EmitDone $false $failedStep $failMsg; exit 1 }
