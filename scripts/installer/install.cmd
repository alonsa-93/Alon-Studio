@echo off
rem Copied into the release under a Hebrew name ("install"). Installs ALON Studio for this user (see runtime\installer\install.ps1).
rem Kept ASCII-only: the Hebrew message below is written as character codes. Regenerate with scripts/installer/gen-install-cmd.mjs.
if not exist "%~dp0runtime\installer\install.ps1" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0runtime\installer\install.ps1"
exit /b %errorlevel%
:notextracted
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show((-join [char[]](1511,1493,1491,1501,32,1510,1512,1497,1498,32,1500,1495,1500,1509,32,1488,1514,32,1511,1493,1489,1509,32,1492,45,122,105,112,58,10,1500,1495,1497,1510,1492,32,1497,1502,1504,1497,1514,32,1506,1500,32,1492,1511,1493,1489,1509,32,62,32,34,1495,1500,1509,32,1492,1499,1500,34,46,10,1488,1495,1512,32,1499,1498,32,1508,1493,1514,1495,1497,1501,32,1488,1514,32,1492,1514,1497,1511,1497,1497,1492,32,1513,1504,1493,1510,1512,1492,32,1493,1500,1493,1495,1510,1497,1501,32,1513,1493,1489,32,1506,1500,32,34,1492,1514,1511,1504,1492,34,46)), 'ALON Studio', 'OK', 'Warning', 'Button1', 'RtlReading, RightAlign')"
exit /b 1
