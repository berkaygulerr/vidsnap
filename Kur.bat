@echo off
REM Vidsnap kurulumu: cift tiklayin. Klasoru tasidiginizda da bir kez calistirin.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
