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
  echo [kbo-helper-pc] Install Node.js LTS ^(at least 20.18.1^), then reopen CMD.
  if /I "%KBO_HELPER_PAUSE%"=="1" pause
  exit /b 1
)

set "WORKDIR=%~dp0"
set "AUTO_PUSH=false"
if exist "%~dp0..\..\.git" (
  if exist "%~dp0..\..\scripts\helper-pc-train-and-tune.js" (
    set "WORKDIR=%~dp0..\.."
    set "AUTO_PUSH=true"
  )
)
if exist "%~dp0.git" set "AUTO_PUSH=true"
set "TARGET_SCRIPT=scripts\helper-pc-train-and-tune.js"
echo [kbo-helper-pc] Node: !NODE_EXE!
echo [kbo-helper-pc] Workdir: !WORKDIR! / autoPush: !AUTO_PUSH!

pushd "!WORKDIR!" >nul
if "%~1"=="" (
  "!NODE_EXE!" "!TARGET_SCRIPT!" --baseUrl=https://kbo-predictor.vercel.app --autoPush=!AUTO_PUSH!
) else (
  "!NODE_EXE!" "!TARGET_SCRIPT!" %*
)
set "RUN_EXIT=%ERRORLEVEL%"
popd >nul
if not "%RUN_EXIT%"=="0" (
  echo [kbo-helper-pc] FAILED. Existing model is preserved unless a validated run was promoted. Read helper_status.kbo.json.
  if /I "%KBO_HELPER_PAUSE%"=="1" pause
  exit /b %RUN_EXIT%
)
echo [kbo-helper-pc] Complete. Check deployment status; standalone runs do not deploy.
if /I "%KBO_HELPER_PAUSE%"=="1" pause
exit /b 0
