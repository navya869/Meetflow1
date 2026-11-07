@echo off
title Meetflow MERN
cd /d "%~dp0"
echo.
echo ========================================
echo          MEETFLOW MERN STARTUP
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer was not found.
  echo Install Node.js from https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js from https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example.
  echo Set MongoDB, JWT and OTP secrets, Twilio, and SMTP settings in .env first.
  echo See README.md for setup instructions.
  pause
  exit /b 1
)

echo Installing project dependencies...
call npm install
if errorlevel 1 goto error

echo Opening Meetflow...
start "" "http://127.0.0.1:5173"
call npm run dev
goto end

:error
echo.
echo Startup failed. Check the error above and see README.md for setup instructions.
pause
exit /b 1

:end
pause
