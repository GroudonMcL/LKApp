@echo off
title LK Companion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again,
  echo or use the Windows package instead ^(see README.md, "Installing on Windows"^).
  pause
  exit /b 1
)
node scripts\launcher.mjs
if errorlevel 1 pause
