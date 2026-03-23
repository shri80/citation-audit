@echo off
title Citation Audit Server
color 0A

echo ================================================
echo   Citation Audit Pro - Server v2
echo ================================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo ERROR: Node.js not installed.
    echo Download from: https://nodejs.org/en/download
    pause & exit /b
)

echo Node.js: & node --version
echo.

if exist "node_modules\express\package.json" goto START

echo Installing packages (first run - takes 1-2 mins)...
echo.
call npm install express cors cookie-parser bcryptjs sql.js dotenv uuid --save
call npm install tesseract.js --save
set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
set PUPPETEER_SKIP_DOWNLOAD=true
call npm install puppeteer --save

if not exist "node_modules\express\package.json" (
    color 0C
    echo FAILED: npm install failed. Try Run as Administrator.
    pause & exit /b
)
echo Packages installed!
echo.

:START
if not exist "logs\" mkdir logs
if not exist ".env" (
    color 0C
    echo ERROR: .env file not found. Please check setup.
    pause & exit /b
)

echo ================================================
echo   Starting server...
echo ================================================
echo.
echo   Login page:  http://localhost:3001/login
echo   Admin panel: http://localhost:3001/admin
echo.
echo   First run creates default admin account:
echo   Username: admin
echo   Password: Admin@1234  (change after first login!)
echo.
echo   Keep this window open. Press Ctrl+C to stop.
echo ================================================
echo.

node src/server.js

echo.
echo Server stopped.
pause
