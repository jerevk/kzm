@echo off
setlocal
cd /d "%~dp0"

echo ===============================================
echo KZM - spremanje baselinea na GitHub
echo ===============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo GRESKA: Git nije instaliran ili nije u PATH-u.
  echo Instaliraj Git for Windows pa ponovno pokreni ovu datoteku.
  pause
  exit /b 1
)

if not exist .git (
  git init -b main
  if errorlevel 1 exit /b 1
) else (
  git checkout -B main
)

git add .
if errorlevel 1 exit /b 1

echo.
echo Datoteke koje ce u prvi commit:
git status --short

echo.
git commit -m "Baseline: working KZM before live API repair"
if errorlevel 1 (
  echo.
  echo Ako Git trazi ime/e-mail, postavi ih pa ponovno pokreni skriptu:
  echo   git config --global user.name "Tvoje ime"
  echo   git config --global user.email "tvoj-github-email"
  pause
  exit /b 1
)

git tag -f baseline-working-2026-09-20

echo.
where gh >nul 2>nul
if errorlevel 1 (
  echo Lokalni Git commit je GOTOV.
  echo.
  echo GitHub CLI ^(gh^) nije pronaden.
  echo Na GitHubu napravi NOVI PRIVATNI repo naziva: kzm
  echo Nemoj dodavati README, .gitignore ni licencu na GitHub stranici.
  echo Zatim u ovom prozoru pokreni:
  echo.
  echo   git remote add origin https://github.com/TVOJ-USERNAME/kzm.git
  echo   git push -u origin main --tags
  echo.
  pause
  exit /b 0
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo Otvara se GitHub prijava...
  gh auth login
  if errorlevel 1 exit /b 1
)

echo.
echo Pokusavam napraviti PRIVATNI repo "kzm" i pushati baseline...
gh repo create kzm --private --source=. --remote=origin --push
if errorlevel 1 (
  echo.
  echo Repo mozda vec postoji. Lokalni commit je svejedno sigurno napravljen.
  echo Ako repo kzm vec postoji, postavi origin pa pushaj:
  echo   git remote add origin https://github.com/TVOJ-USERNAME/kzm.git
  echo   git push -u origin main --tags
  pause
  exit /b 1
)

git push origin --tags

echo.
echo ===============================================
echo GOTOVO - baseline je spremljen na GitHub.
echo Tag: baseline-working-2026-09-20
echo ===============================================
pause
