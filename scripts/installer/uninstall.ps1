# ALON Studio removal, run from Settings > Apps (the entry install.ps1 registered).
# Removes the program folder, its shortcuts and the Apps entry. Videos and projects in Documents\ALON Studio stay.
# -Quiet is for automated tests and QuietUninstallString.
param([switch]$Quiet, [string]$KeyName = 'ALONStudio')
$ErrorActionPreference = 'Stop'
$Title = 'ALON Studio'
$NL = [Environment]::NewLine
$log = Join-Path $env:TEMP 'alon-studio-install.log'
Add-Type -AssemblyName System.Windows.Forms

function Say([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
  if ($Quiet) { return $(if ($Buttons -eq 'YesNo') { 'Yes' } else { 'OK' }) }
  [string][System.Windows.Forms.MessageBox]::Show($Text, $Title, $Buttons, $Icon, 'Button1', 'RtlReading, RightAlign')
}

try {
  $dir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath.TrimEnd('\')
  # only ever delete a folder that really is an ALON Studio install
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'ALON Studio.cmd')) -or -not (Test-Path -LiteralPath (Join-Path $dir 'runtime\node.exe'))) {
    throw "not an ALON Studio folder: $dir"
  }
  $q = 'להסיר את ALON Studio מהמחשב?' + $NL + $NL + 'הפרויקטים והסרטונים שלך בתיקייה Documents\ALON Studio יישארו. אם הסטודיו פתוח, הוא ייסגר.'
  if ((Say $q 'YesNo' 'Question') -ne 'Yes') { exit 0 }

  $prefix = (Join-Path $dir 'runtime') + '\'
  Get-Process node, python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Set-Location -LiteralPath $env:TEMP

  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$KeyName"
  $links = @((Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).AlonShortcuts)
  foreach ($l in $links) { if ($l -and (Test-Path -LiteralPath $l)) { Remove-Item -LiteralPath $l -Force } }

  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $dir); $i++) {
    try { Remove-Item -LiteralPath $dir -Recurse -Force } catch { Start-Sleep -Seconds 1 }
  }
  if (Test-Path -LiteralPath $dir) { throw "could not remove $dir (is a file open?)" }
  if (Test-Path -Path $key) { Remove-Item -Path $key -Recurse -Force }
  "$(Get-Date -Format s) removed $dir" | Out-File -FilePath $log -Append -Encoding utf8
  Say 'ALON Studio הוסר מהמחשב.' | Out-Null
  exit 0
} catch {
  "$(Get-Date -Format s) uninstall failed: $($_ | Out-String)" | Out-File -FilePath $log -Append -Encoding utf8
  Say ('ההסרה נכשלה.' + $NL + $_.Exception.Message + $NL + $NL + 'פרטים בקובץ: ' + $log) 'OK' 'Error' | Out-Null
  exit 1
}
