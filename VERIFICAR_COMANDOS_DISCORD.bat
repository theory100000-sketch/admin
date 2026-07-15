@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" call npm install
node verify-commands.js
if errorlevel 1 (
  echo.
  echo ERROR: faltan comandos en deploy-commands.js o index.js.
) else (
  echo.
  echo Los 26 comandos estan registrados y tienen controlador.
)
pause
endlocal
