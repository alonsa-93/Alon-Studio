; ALON Studio installer (Inno Setup 6). Built by scripts/build-installer.mjs (npm run release:setup):
;   ISCC /DSrcDir=<release\ALON Studio> /DOutDir=<release> /DAppVersion=<x.y.z> alon-studio.iss
; Installs for the current user only (no admin prompt) into %LOCALAPPDATA%\Programs\ALON Studio.
; Videos and projects live in Documents\ALON Studio and are never touched by install, update or removal.

#ifndef SrcDir
  #error SrcDir (the built release folder) is required
#endif
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef OutDir
  #define OutDir "."
#endif

[Setup]
AppId={{8E0B6C2A-4F5D-4C1E-9A43-5B2D7E61A0C9}
AppName=ALON Studio
AppVersion={#AppVersion}
AppVerName=ALON Studio {#AppVersion}
AppPublisher=ALON.ai
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\ALON Studio
DefaultGroupName=ALON Studio
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=ALON-Studio-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName=ALON Studio
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
CloseApplications=force
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "he"; MessagesFile: "compiler:Languages\Hebrew.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; an update replaces the program files completely, so nothing stale is left behind
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\ALON Studio"; Filename: "{app}\ALON Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Flags: runminimized
Name: "{autodesktop}\ALON Studio"; Filename: "{app}\ALON Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\ALON Studio.cmd"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,ALON Studio}"; Flags: nowait postinstall skipifsilent shellexec runminimized

[UninstallDelete]
; files the program writes next to itself while running (Python caches); the user's data is elsewhere
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\server"
Type: dirifempty; Name: "{app}"

[Code]
{ Stops a running studio from this folder (its server and any transcription) so files can be replaced or removed. }
procedure StopStudio();
var
  Code: Integer;
  Dir: String;
begin
  Dir := ExpandConstant('{app}') + '\runtime\';
  StringChangeEx(Dir, '''', '''''', True);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-Process node,python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith(''' + Dir + ''', [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopStudio();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopStudio();
end;
