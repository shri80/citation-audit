# Citation Audit Server — Windows Setup Guide

Node.js server that runs all audit logic (DOM scraping + Tesseract OCR) securely,
with full time logging of every audit session.

---

## Step 1 — Install Node.js (one time only)

1. Go to **https://nodejs.org/en/download**
2. Download the **LTS** version (Windows Installer `.msi`)
3. Run the installer — keep all defaults, click Next → Next → Install
4. After install, open **Command Prompt** and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x` ✅

---

## Step 2 — Configure the server

1. Extract `citation-audit-server.zip` to a folder, e.g. `C:\citation-server\`
2. Open the `.env` file in Notepad and set your values:

```
PORT=3001
API_SECRET=MySecretKey123
DB_PATH=./logs/audit_logs.db
MAX_CONCURRENT=3
```

> **API_SECRET** — choose any password-like string. The Chrome extension must
> use this exact same key. Keep it private.

---

## Step 3 — Start the server

**Option A — Double-click (easiest)**
- Double-click `START-SERVER.bat`
- First run downloads Chromium (~150MB) — takes 2–5 mins
- You'll see: `✅ Citation Audit Server running on http://localhost:3001`

**Option B — Command Prompt**
```cmd
cd C:\citation-server
npm install
node src/server.js
```

> ⚠️ **Windows Firewall** — When first started, Windows may ask to allow
> network access. Click **Allow** so the Chrome extension can connect.

---

## Step 4 — Configure the Chrome Extension

1. Open Chrome → click the extension icon → **Import** tab
2. Scroll down to **🖥️ Audit Server Settings**
3. Enter:
   - **Server URL:** `http://localhost:3001`
   - **Secret Key:** same value as `API_SECRET` in your `.env`
4. Click **🔗 Test** → should show `✅ Connected!`
5. Click **💾 Save**

---

## Step 5 — View the Dashboard

Open in Chrome: `http://localhost:3001/?secret=MySecretKey123`

Shows a table of every audit run:
- Business name, date/time, duration
- Total / Live / Pending URL counts  
- Yes ✓ / No ✗ / Needs Review counts
- IP address

---

## Keep server running after restart (optional)

```cmd
npm install -g pm2 pm2-windows-startup
cd C:\citation-server
pm2 start src/server.js --name citation-audit
pm2 save
pm2-startup install
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` fails | Run Command Prompt as Administrator |
| Cannot connect in extension | Check Windows Firewall allowed Node.js |
| Port in use | Change `PORT=3002` in `.env` and update extension URL |
| Puppeteer error | Delete `node_modules`, run `npm install` again |
