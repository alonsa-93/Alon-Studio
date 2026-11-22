# ALON Studio installer. Started by "התקנה.cmd" in the extracted zip; no .exe of its own, so Windows
# Smart App Control does not block it. Copies the program to %LOCALAPPDATA%\Programs\ALON Studio,
# adds Start menu and desktop shortcuts and an entry in Settings > Apps (removal: uninstall.ps1).
# Videos and projects live in Documents\ALON Studio and are never touched.
# -Quiet, -Dest, -ShortcutDir and -KeyName exist for automated tests only.
param([switch]$Quiet, [string]$Dest, [string]$ShortcutDir, [string]$KeyName = 'ALONStudio')
$ErrorActionPreference = 'Stop'
$Version = '__VERSION__'
$Title = 'ALON Studio'
$NL = [Environment]::NewLine
$log = Join-Path $env:TEMP 'alon-studio-install.log'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

function Say([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
  if ($Quiet) { return $(if ($Buttons -eq 'YesNo') { 'Yes' } else { 'OK' }) }
  [string][System.Windows.Forms.MessageBox]::Show($Text, $Title, $Buttons, $Icon, 'Button1', 'RtlReading, RightAlign')
}

# Stops a studio running from this folder (its server and any transcription), so files can be replaced.
function Stop-Studio([string]$Dir) {
  $prefix = (Join-Path $Dir 'runtime') + '\'
  $p = @(Get-Process node, python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if ($p.Count) { $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }
}

try {
  $src = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
  if (-not $Dest) { $Dest = Join-Path $env:LOCALAPPDATA 'Programs\ALON Studio' }
  $Dest = [IO.Path]::GetFullPath($Dest).TrimEnd('\')
  if (-not (Test-Path -LiteralPath (Join-Path $src 'runtime\node.exe'))) {
    Say ('חסרים קבצים של התוכנה.' + $NL + 'חלצו את כל קובץ ה-zip (לחיצה ימנית > "חלץ הכל") ונסו שוב.') 'OK' 'Error' | Out-Null
    exit 1
  }
  if ($src -ieq $Dest) {
    Say ('התוכנה כבר מותקנת במחשב.' + $NL + 'פותחים אותה מהאייקון "ALON Studio" בשולחן העבודה או בתפריט התחל.') | Out-Null
    exit 0
  }
  if ($src.StartsWith($Dest + '\', [StringComparison]::OrdinalIgnoreCase) -or $Dest.StartsWith($src + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "install folder and source overlap: $src / $Dest"
  }
  $upgrade = Test-Path -LiteralPath (Join-Path $Dest 'ALON Studio.cmd')
  $q = if ($upgrade) { 'לעדכן את ALON Studio לגרסה הזו?' } else { 'להתקין את ALON Studio במחשב?' + $NL + 'ייווצר קיצור דרך בשולחן העבודה ובתפריט התחל.' }
  $q += $NL + $NL + 'הפרויקטים והסרטונים שלך נשארים במקומם. אם הסטודיו פתוח, הוא ייסגר.'
  if ((Say $q 'YesNo' 'Question') -ne 'Yes') { exit 0 }

  Stop-Studio $Dest
  Stop-Studio $src
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null

  # robocopy /MIR: an update leaves no stale files behind. Exit codes 0-7 mean success.
  $robo = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  $roboArgs = "`"$src`" `"$Dest`" /MIR /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP"
  $p = Start-Process -FilePath $robo -ArgumentList $roboArgs -WindowStyle Hidden -PassThru
  $null = $p.Handle
  if (-not $Quiet) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Title; $form.Width = 440; $form.Height = 150; $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'; $form.ControlBox = $false; $form.TopMost = $true
    $form.RightToLeft = 'Yes'; $form.RightToLeftLayout = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $(if ($upgrade) { 'מעדכן את ALON Studio...' } else { 'מתקין את ALON Studio...' }) + ' זה לוקח פחות מדקה.'
    $label.SetBounds(16, 16, 390, 24)
    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30; $bar.SetBounds(16, 52, 390, 22)
    $form.Controls.AddRange(@($label, $bar))
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 300
    $timer.Add_Tick({ if ($p.HasExited) { $timer.Stop(); $form.Close() } })
    $timer.Start()
    [void]$form.ShowDialog()
  }
  $p.WaitForExit()
  if ($p.ExitCode -ge 8) { throw "copying the files failed (robocopy $($p.ExitCode))" }
  # robocopy carries the "downloaded from the internet" mark over from an extracted zip; Smart App Control
  # then refuses to open the installed launcher ("Dangerous file extension from the web"). The user chose
  # to install this program, so the installed copy is local like any installed program's files.
  Get-ChildItem -LiteralPath $Dest -Recurse -File -Force | Unblock-File

  $cmd = Join-Path $Dest 'ALON Studio.cmd'
  $icon = Join-Path $Dest 'runtime\installer\icon.ico'
  $desk = [Environment]::GetFolderPath('Desktop')
  $menu = [Environment]::GetFolderPath('Programs')
  if ($ShortcutDir) { $desk = Join-Path $ShortcutDir 'Desktop'; $menu = Join-Path $ShortcutDir 'Programs' }
  $ws = New-Object -ComObject WScript.Shell
  $links = @()
  foreach ($dir in @($menu, $desk)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $lnk = Join-Path $dir 'ALON Studio.lnk'
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $cmd
    $s.WorkingDirectory = $Dest
    $s.IconLocation = "$icon,0"
    $s.WindowStyle = 7
    $s.Description = 'ALON Studio'
    $s.Save()
    $links += $lnk
  }

  $kb = [int]((Get-ChildItem -LiteralPath $Dest -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1KB)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $un = Join-Path $Dest 'runtime\installer\uninstall.ps1'
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$KeyName"
  New-Item -Path $key -Force | Out-Null
  $values = @{
    DisplayName = 'ALON Studio'; DisplayVersion = $Version; Publisher = 'ALON.ai'; DisplayIcon = $icon
    InstallLocation = $Dest; InstallDate = (Get-Date -Format 'yyyyMMdd')
    UninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$un`" -KeyName $KeyName"
    QuietUninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$un`" -KeyName $KeyName -Quiet"
  }
  foreach ($k in $values.Keys) { New-ItemProperty -Path $key -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $key -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
  New-ItemProperty -Path $key -Name EstimatedSize -Value $kb -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name AlonShortcuts -Value ([string[]]$links) -PropertyType MultiString -Force | Out-Null

  "$(Get-Date -Format s) installed $Version to $Dest" | Out-File -FilePath $log -Append -Encoding utf8
  $done = $(if ($upgrade) { 'ALON Studio עודכן.' } else { 'ALON Studio הותקן.' }) + $NL +
    'מעכשיו פותחים אותו מהאייקון בשולחן העבודה או מתפריט התחל.' + $NL +
    'אפשר למחוק את התיקייה שחילצתם ואת קובץ ה-zip.' + $NL + $NL + 'לפתוח את הסטודיו עכשיו?'
  if (-not $Quiet -and (Say $done 'YesNo' 'Information') -eq 'Yes') {
    Start-Process -FilePath $cmd -WorkingDirectory $Dest -WindowStyle Minimized
  }
  exit 0
} catch {
  "$(Get-Date -Format s) install failed: $($_ | Out-String)" | Out-File -FilePath $log -Append -Encoding utf8
  Say ('ההתקנה נכשלה.' + $NL + $_.Exception.Message + $NL + $NL + 'פרטים בקובץ: ' + $log) 'OK' 'Error' | Out-Null
  exit 1
}
