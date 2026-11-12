@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set REPO=https://github.com/DaRealDante/DownloadManager.git

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed.
  echo Install it from https://git-scm.com/download/win and run this file again.
  pause
  exit /b 1
)

if not exist .git (
  echo Preparing the repository...
  git init >nul
  git branch -M main
)
git remote get-url origin >nul 2>nul
if errorlevel 1 git remote add origin %REPO%

set GN=
for /f "delims=" %%a in ('git config user.name') do set GN=%%a
if not defined GN git config user.name "DaRealDante"
set GE=
for /f "delims=" %%a in ('git config user.email') do set GE=%%a
if not defined GE git config user.email "DaRealDante@users.noreply.github.com"

set MSG=Update
set /p MSG=Commit message (press Enter for "Update"): 
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "%MSG%"
) else (
  echo No file changes to upload.
)

set VER=
set /p VER=New version to release, for example 1.0.1 (press Enter to skip): 
if not defined VER goto push
echo !VER!| findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Wrong format. Use three numbers, for example 1.0.1
  pause
  exit /b 1
)
powershell -NoProfile -Command "(Get-Content package.json -Raw) -replace '(.version.: .)[0-9.]+','${1}!VER!' | Set-Content package.json -NoNewline -Encoding ASCII"
git add package.json
git commit -q -m "Version !VER!"
git tag v!VER!
if errorlevel 1 (
  echo Tag v!VER! already exists. Use a higher version number.
  pause
  exit /b 1
)

:push
echo Uploading to GitHub...
git ls-remote --exit-code --heads origin main >nul 2>nul
if errorlevel 1 goto plainpush
git pull origin main --rebase --allow-unrelated-histories >nul 2>nul
if not errorlevel 1 goto plainpush
git rebase --abort >nul 2>nul
echo GitHub has different files than this folder.
set FORCE=
set /p FORCE=Replace the GitHub files with the files in this folder? Type Y to confirm: 
if /i not "!FORCE!"=="Y" (
  echo Stopped. Nothing was changed on GitHub.
  pause
  exit /b 1
)
git push -u origin main --force
goto afterpush

:plainpush
git push -u origin main

:afterpush
if errorlevel 1 (
  echo.
  echo Upload failed. Read the message above.
  pause
  exit /b 1
)
if defined VER git push origin v!VER!
echo.
echo Done. Files are on GitHub.
if defined VER echo The setup file appears in about 5 minutes at:
if defined VER echo https://github.com/DaRealDante/DownloadManager/releases
pause
