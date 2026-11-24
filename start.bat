@echo off
title Bulk WhatsApp Sender
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install || (pause & exit /b 1)
)
node src\server.js
pause
