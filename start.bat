@echo off
rem SmartSalle ISPITS - demarrage Windows
rem Les secrets sont fournis par Infisical (https://infisical.com), plus par un .env local.
setlocal
cd /d "%~dp0"

if exist ".tools\node-v24.21.0-win-x64\node.exe" (
  set "PATH=%CD%\.tools\node-v24.21.0-win-x64;%PATH%"
)

if not defined PORT set PORT=3000

where infisical >nul 2>nul
if errorlevel 1 goto noinfisical

echo Demarrage de SmartSalle ISPITS (secrets via Infisical) sur http://localhost:%PORT%
infisical run --env=dev -- node server/index.js
goto done

:noinfisical
echo [ATTENTION] CLI Infisical introuvable : les secrets ne seront PAS injectes.
echo   Installation : winget install infisical
echo   Puis, une seule fois : infisical login, puis infisical init
echo   Demarrage SANS Infisical, avec les valeurs par defaut.
echo.
echo Demarrage de SmartSalle ISPITS sur http://localhost:%PORT%
node server/index.js

:done
pause
