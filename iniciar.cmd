@echo off
rem Arranca StudioMix Live (descarga MediaMTX la primera vez).
cd /d "%~dp0"
if not exist vendor\mediamtx\mediamtx.exe node scripts\setup.mjs || goto :error
node server\index.js
goto :eof
:error
echo No se pudo preparar MediaMTX.
pause
