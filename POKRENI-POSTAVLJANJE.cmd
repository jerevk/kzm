@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".kzm-new-project" (
 echo POGRESNA MAPA. Prekida se.
 pause
 exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
 echo Nedostaje Node.js. Instaliraj aktualni Node.js LTS i ponovno otvori ovaj file.
 pause
 exit /b 1
)
echo POSTAVLJANJE ZASEBNOG NOVOG KZM-a. Ne mijenja original.
call npm install
if errorlevel 1 goto failure
call npm run setup
if errorlevel 1 goto failure
pause
exit /b 0
:failure
echo Doslo je do greske. Sacuvaj ispis i ne mijenjaj originalni projekt.
pause
exit /b 1
