# Citation Audit Server — PowerShell Launcher
# Right-click this file → "Run with PowerShell"

$Host.UI.RawUI.WindowTitle = "Citation Audit Server"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Citation Audit Pro - Server" -ForegroundColor Cyan  
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVer = node --version 2>&1
    Write-Host "Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Download Node.js LTS from: https://nodejs.org/en/download"
    Read-Host "Press Enter to exit"
    exit 1
}

# Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host ""
    Write-Host "Installing dependencies (first run — may take 2-5 mins)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Dependencies installed!" -ForegroundColor Green
}

# Check .env
if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "ERROR: .env file not found!" -ForegroundColor Red
    Write-Host "Create a .env file with:"
    Write-Host "  PORT=3001"
    Write-Host "  API_SECRET=your-secret-key-here"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "Starting server..." -ForegroundColor Green
Write-Host ""
Write-Host "Dashboard: http://localhost:3001/?secret=YOUR_SECRET" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

node src/server.js

Read-Host "Server stopped. Press Enter to exit"
