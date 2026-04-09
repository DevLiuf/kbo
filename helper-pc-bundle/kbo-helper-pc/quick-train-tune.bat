@echo off
setlocal

cd /d "%~dp0"

if "%~1"=="" (
  echo [kbo-helper-pc] Running default train+tune...
  node scripts\helper-pc-train-and-tune.js --from=20260331 --baseUrl=https://kbo-predictor.vercel.app
) else (
  echo [kbo-helper-pc] Running with custom args: %*
  node scripts\helper-pc-train-and-tune.js %*
)

if errorlevel 1 (
  echo.
  echo [kbo-helper-pc] FAILED. Check logs above.
  pause
  exit /b 1
)

echo.
echo [kbo-helper-pc] DONE.
pause
exit /b 0
