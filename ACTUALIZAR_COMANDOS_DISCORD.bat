@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" call npm install
echo Actualizando comandos de Discord...
node deploy-commands.js
if errorlevel 1 (
  echo.
  echo ERROR: revisa TOKEN, CLIENT_ID y GUILD_ID en .env.
) else (
  echo.
  echo Comandos actualizados correctamente.
)
pause
endlocal
