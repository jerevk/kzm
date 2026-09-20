@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ===============================================
echo KZM - spremanje baselinea na GitHub (V2)
echo ===============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo GRESKA: Git nije instaliran ili nije u PATH-u.
  pause
  exit /b 1
)

where gh >nul 2>nul
if errorlevel 1 (
  echo GRESKA: GitHub CLI nije instaliran ili nije u PATH-u.
  echo Instaliraj ga naredbom: winget install --id GitHub.cli -e --source winget
  pause
  exit /b 1
)

if not exist .git (
  git init -b main
  if errorlevel 1 exit /b 1
) else (
  git checkout -B main
  if errorlevel 1 exit /b 1
)

for /f "delims=" %%A in ('git config --get user.name 2^>nul') do set "GITNAME=%%A"
for /f "delims=" %%A in ('git config --get user.email 2^>nul') do set "GITEMAIL=%%A"
if not defined GITNAME (
  echo GRESKA: Git user.name nije postavljen.
  echo Pokreni: git config --global user.name "Tvoje ime"
  pause
  exit /b 1
)
if not defined GITEMAIL (
  echo GRESKA: Git user.email nije postavljen.
  echo Pokreni: git config --global user.email "tvoj-github-email"
  pause
  exit /b 1
)

git add .
if errorlevel 1 exit /b 1

git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 (
  echo Radim prvi commit...
  git commit -m "Baseline: working KZM before live API repair"
  if errorlevel 1 exit /b 1
) else (
  git diff --cached --quiet
  if errorlevel 1 (
    echo Postoje nove promjene - spremam ih u commit...
    git commit -m "Baseline: working KZM before live API repair"
    if errorlevel 1 exit /b 1
  ) else (
    echo Lokalni commit vec postoji i nema novih promjena. Nastavljam na GitHub.
  )
)

git tag -f baseline-working-2026-09-20

gh auth status >nul 2>nul
if errorlevel 1 (
  echo.
  echo Otvara se GitHub prijava...
  gh auth login
  if errorlevel 1 exit /b 1
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  gh repo view kzm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Kreiram PRIVATNI GitHub repo kzm i pusham baseline...
    gh repo create kzm --private --source=. --remote=origin --push
    if errorlevel 1 (
      echo GRESKA: GitHub repo nije kreiran/pushan.
      pause
      exit /b 1
    )
  ) else (
    for /f "delims=" %%U in ('gh repo view kzm --json url -q .url') do set "REPOURL=%%U"
    if not defined REPOURL (
      echo GRESKA: Repo kzm postoji, ali URL nije procitan.
      pause
      exit /b 1
    )
    git remote add origin "%REPOURL%.git"
    if errorlevel 1 exit /b 1
    git push -u origin main
    if errorlevel 1 exit /b 1
  )
) else (
  echo.
  echo Origin vec postoji - pusham main...
  git push -u origin main
  if errorlevel 1 exit /b 1
)

git push origin --tags
if errorlevel 1 exit /b 1

echo.
echo ===============================================
echo GOTOVO - baseline je spremljen na GitHub.
echo Repo: kzm
echo Branch: main
echo Tag: baseline-working-2026-09-20
echo ===============================================
pause
