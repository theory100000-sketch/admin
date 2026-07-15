@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   THUNDER ELITE LEAGUE - WEB + BOT
ECHO ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js no esta instalado.
  echo Instala Node.js y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Instalando dependencias por primera vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
echo.
echo Web disponible en: http://localhost:3000
echo Bot de Discord y web iniciados juntos.
echo Para cerrar ambos pulsa CTRL+C.
echo.
node start-all.js

pause
endlocal
