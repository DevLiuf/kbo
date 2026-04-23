@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  set "NODE_EXE=%%i"
  goto :node_found
)

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

:node_found
if not defined NODE_EXE (
  echo.
  echo [kbo-helper-pc] Node.js not found.
  echo 1^) Install Node.js LTS ^(v18+^) from https://nodejs.org
  echo 2^) Reopen CMD and check: node -v
  echo 3^) Run this file again.
  echo.
  if /I "%KBO_HELPER_PAUSE%"=="1" pause
  exit /b 1
)

echo [kbo-helper-pc] Using Node: !NODE_EXE!

if exist "%~dp0..\..\.git" if exist "%~dp0..\..\scripts\helper-pc-train-and-tune.js" (
  set "WORKDIR=%~dp0..\.."
  set "TARGET_SCRIPT=scripts\helper-pc-train-and-tune.js"
  echo [kbo-helper-pc] Git clone detected. Running root pipeline at !WORKDIR!
) else (
  set "WORKDIR=%~dp0"
  set "TARGET_SCRIPT=scripts\helper-pc-train-and-tune.js"
  echo [kbo-helper-pc] Standalone bundle mode. Running local pipeline.
)

pushd "!WORKDIR!" >nul
if "%~1"=="" (
  echo [kbo-helper-pc] Running default train+tune...
  "!NODE_EXE!" !TARGET_SCRIPT! --from=20260331 --baseUrl=https://kbo-predictor.vercel.app --autoPush=true
) else (
  echo [kbo-helper-pc] Running with custom args: %*
  "!NODE_EXE!" !TARGET_SCRIPT! %*
)
set "RUN_EXIT=%ERRORLEVEL%"
popd >nul

if not "%RUN_EXIT%"=="0" (
  echo.
  echo [kbo-helper-pc] FAILED. Check logs above.
  if /I "%KBO_HELPER_PAUSE%"=="1" pause
  exit /b %RUN_EXIT%
)

echo.
echo [kbo-helper-pc] DONE.
if /I "%KBO_HELPER_PAUSE%"=="1" pause
exit /b 0
