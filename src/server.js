// src/server.js — Citation Audit Pro — Server with Per-User Login
'use strict';

require('dotenv').config();

process.on('uncaughtException',  err    => console.error('[Server] Uncaught:', err.message));
process.on('unhandledRejection', reason => console.error('[Server] Rejected:', reason?.message || reason));

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { initDb, stmts } = require('./db');
const { auditPage, getBrowser, AUDIT_KEYS } = require('./domAuditor');
const { auditViaScreenshot }                = require('./screenshotOcr');
const { google }                            = require('googleapis');
const fs_                                   = require('fs');
const path_                                 = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 3;

// Token TTL — 30 days
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Allow all origins including Chrome extensions
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    // AND Chrome extensions (chrome-extension://)
    // AND all web origins
    callback(null, true);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
}));

// Handle preflight requests
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const activeSessions = new Map();

// ════════════════════════════════════════════════════════════════════════════════
// AUTH HELPERS
// ════════════════════════════════════════════════════════════════════════════════

function createToken(userId) {
  const token     = uuid() + '-' + uuid();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
  stmts.createToken.run({ token, user_id: userId, created_at: now.toISOString(), expires_at: expiresAt });
  return token;
}

function getTokenFromRequest(req) {
  // For API calls from the extension — prefer Authorization header over cookie
  // This prevents the browser's admin dashboard cookie from overriding
  // the extension's user token
  const headerToken = (req.headers.authorization || '').replace('Bearer ', '').trim()
    || req.headers['x-user-token'];

  // If request is an API call (path starts with /api/) — use header only
  if (req.path.startsWith('/api/')) {
    return headerToken || null;
  }

  // For browser dashboard routes — cookie first, then header
  return req.cookies?.auth_token || headerToken || null;
}

function requireLogin(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Not logged in' });
  }
  const user = stmts.getTokenUser.get(token);
  if (!user) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
  req.user  = user;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin') {
      if (req.accepts('html')) return res.status(403).send(page403());
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// HTML HELPERS
// ════════════════════════════════════════════════════════════════════════════════
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0d0f14;color:#c8d0e0;min-height:100vh}
  a{color:#4f8eff;text-decoration:none} a:hover{text-decoration:underline}
  .wrap{max-width:1300px;margin:0 auto;padding:24px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;
          padding-bottom:14px;border-bottom:1px solid #1e2438}
  .topbar h1{font-size:18px;color:#00e5a0}
  .topbar .sub{font-size:12px;color:#6b7590;margin-top:2px}
  .topbar-right{display:flex;gap:14px;align-items:center;font-size:12px}
  .badge{background:#1e2438;padding:4px 10px;border-radius:20px;font-size:11px}
  .badge.admin{background:rgba(255,184,48,.15);color:#ffb830}
  .badge.user{background:rgba(79,142,255,.15);color:#4f8eff}
  .stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#161a24;border:1px solid #1e2438;border-radius:10px;padding:14px 18px;min-width:110px}
  .stat .val{font-size:22px;font-weight:700;color:#4f8eff}
  .stat .lbl{font-size:10px;color:#6b7590;margin-top:2px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#161a24;color:#6b7590;padding:8px 10px;text-align:left;
     border-bottom:1px solid #1e2438;white-space:nowrap;font-size:10px;
     text-transform:uppercase;letter-spacing:.05em}
  td{padding:7px 10px;border-bottom:1px solid #1a1e2c;vertical-align:middle}
  tr:hover td{background:#161a24}
  tr.running td{border-left:3px solid #ffb830}
  tr.cancelled td{opacity:.5}
  .yes{color:#00e5a0;font-weight:700} .no{color:#ff4f6a;font-weight:700}
  .review{color:#ffb830;font-weight:700}
  .status{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#6b7590}
  .btn{display:inline-block;padding:7px 16px;border-radius:7px;font-size:12px;
       font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:opacity .2s}
  .btn:hover{opacity:.85} .btn-green{background:#00e5a0;color:#0d0f14}
  .btn-blue{background:#4f8eff;color:#fff} .btn-red{background:#ff4f6a;color:#fff}
  .btn-grey{background:#1e2438;color:#c8d0e0;border:1px solid #2a3050}
  .form-box{background:#161a24;border:1px solid #1e2438;border-radius:12px;
            padding:32px;max-width:400px;margin:80px auto}
  .form-box h2{font-size:18px;color:#00e5a0;margin-bottom:6px}
  .form-box p{font-size:12px;color:#6b7590;margin-bottom:24px}
  .field{margin-bottom:16px}
  .field label{display:block;font-size:11px;color:#6b7590;margin-bottom:5px;
               text-transform:uppercase;letter-spacing:.04em}
  .field input{width:100%;background:#0d0f14;border:1px solid #1e2438;border-radius:7px;
               color:#c8d0e0;padding:9px 12px;font-size:13px;outline:none;
               transition:border-color .2s;font-family:inherit}
  .field input:focus{border-color:#4f8eff}
  .alert{padding:10px 14px;border-radius:7px;font-size:12px;margin-bottom:16px}
  .alert-err{background:rgba(255,79,106,.1);border:1px solid rgba(255,79,106,.3);color:#ff4f6a}
  .alert-ok{background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.3);color:#00e5a0}
  .section-title{font-size:13px;font-weight:700;color:#c8d0e0;margin:24px 0 12px}
  .auto-refresh{font-size:10px;color:#6b7590;margin-left:12px}
  .nav{display:flex;gap:6px}
`;

function htmlShell(title, body, user) {
  const userBadge = user
    ? `<div class="topbar-right">
         <span>👤 ${esc(user.username)}</span>
         <span class="badge ${user.role}">${user.role}</span>
         ${user.role === 'admin' ? `<a href="/admin" class="btn btn-grey" style="padding:4px 10px">⚙ Admin</a>` : ''}
         <a href="/dashboard" class="btn btn-grey" style="padding:4px 10px">📊 My Logs</a>
         <a href="/logout" class="btn btn-grey" style="padding:4px 10px">⏏ Logout</a>
       </div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Citation Audit</title>
  <style>${CSS}</style></head>
<body><div class="wrap">
  <div class="topbar">
    <div><h1>📋 Citation Audit Pro</h1><div class="sub">${esc(title)}</div></div>
    ${userBadge}
  </div>
  ${body}
</div></body></html>`;
}

function page403() {
  return htmlShell('Access Denied', '<div style="text-align:center;padding:60px;color:#ff4f6a">⛔ Admin access required</div>', null);
}

function sessionTable(sessions, showUser, liveMap) {
  if (!sessions.length) {
    return '<p style="color:#6b7590;padding:20px 0">No audit sessions yet.</p>';
  }
  const rows = sessions.map(s => {
    const live = liveMap?.get(s.session_id);
    let yesC = s.yes_count || 0, noC = s.no_count || 0, revC = s.needs_review || 0;
    let durStr = s.duration_sec ? (+s.duration_sec).toFixed(1) + 's' : '—';
    let statusStr = s.status;
    let note = '';
    if (live && !live.done) {
      let ly = 0, ln = 0, lr = 0;
      for (const r of Object.values(live.results || {})) {
        if (!r) continue;
        if (r._blocked) { lr++; continue; }  // any blocked → needs review
        const activeK = live.biz ? AUDIT_KEYS.filter(k => live.biz[k] && String(live.biz[k]).trim()) : AUDIT_KEYS;
        const y = activeK.filter(k => r[k] === 'Yes').length;
        const n = activeK.filter(k => r[k] === 'No').length;
        const a = activeK.filter(k => r[k] === 'N/A').length;
        ly += y; ln += n;
        if (n > y || (a > 0 && y === 0 && n === 0) || r._ocrError) lr++;
      }
      yesC = ly; noC = ln; revC = lr;
      durStr    = ((Date.now() - live.startedAt) / 1000).toFixed(0) + 's';
      statusStr = `running ${live.idx}/${live.total}`;
      note      = `<br><span style="font-size:9px;color:#6b7590">${esc(live.currentLabel || '')}</span>`;
    }
    const userCol = showUser ? `<td>${esc(s.username || '—')}</td>` : '';
    return `<tr class="${s.status === 'done' ? '' : s.status === 'running' ? 'running' : 'cancelled'}">
      <td>${s.started_at.slice(0,19).replace('T',' ')}</td>
      ${userCol}
      <td>${esc(s.business_name)}${note}</td>
      <td>${s.total_urls}</td><td>${s.live_urls}</td><td>${s.pending_urls}</td>
      <td class="yes">${yesC}</td><td class="no">${noC}</td>
      <td class="review">${revC}</td>
      <td>${durStr}</td><td class="status">${statusStr}</td>
      <td>${esc(s.ip_address || '—')}</td>
    </tr>`;
  }).join('');

  const userHeader = showUser ? '<th>User</th>' : '';
  return `<table>
    <thead><tr>
      <th>Started At</th>${userHeader}<th>Business Name</th>
      <th>Total</th><th>Live</th><th>Pending</th>
      <th>Yes ✓</th><th>No ✗</th><th>Needs Review</th>
      <th>Duration</th><th>Status</th><th>IP</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// GET /login
app.get('/login', (req, res) => {
  const err = req.query.err || '';
  const msg = err === 'bad'      ? 'Invalid username or password.'
            : err === 'disabled' ? 'Your account has been disabled.'
            : err === 'expired'  ? 'Session expired — please log in again.'
            : '';
  res.send(htmlShell('Login', `
    <div class="form-box">
      <h2>🔐 Sign In</h2>
      <p>Enter your credentials to access the audit dashboard</p>
      ${msg ? `<div class="alert alert-err">${esc(msg)}</div>` : ''}
      <form method="POST" action="/login">
        <div class="field">
          <label>Username</label>
          <input type="text" name="username" autocomplete="username" required autofocus>
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" name="password" autocomplete="current-password" required>
        </div>
        <button type="submit" class="btn btn-green" style="width:100%;padding:10px">Sign In →</button>
      </form>
    </div>
  `, null));
});

// POST /login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?err=bad');

  const user = stmts.getUserByUsername.get(username.trim());
  if (!user) return res.redirect('/login?err=bad');
  if (!user.active) return res.redirect('/login?err=disabled');

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.redirect('/login?err=bad');

  stmts.updateLastLogin.run(user.id);
  const token = createToken(user.id);

  res.cookie('auth_token', token, {
    httpOnly: true,
    maxAge:   TOKEN_TTL_MS,
    sameSite: 'lax',
  });

  // Redirect admins to admin panel, users to their dashboard
  res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
});

// GET /logout
app.get('/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) stmts.deleteToken.run(token);
  res.clearCookie('auth_token');
  res.redirect('/login');
});

// ════════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ════════════════════════════════════════════════════════════════════════════════

app.get('/admin', requireAdmin, (req, res) => {
  const sessions = stmts.listSessions.all(200);
  const stats    = stmts.getStats.get() || {};
  const users    = stmts.listUsers.all();

  const statCards = `
    <div class="stats">
      <div class="stat"><div class="val">${stats.total_sessions||0}</div><div class="lbl">Total Sessions</div></div>
      <div class="stat"><div class="val">${stats.total_urls_audited||0}</div><div class="lbl">URLs Audited</div></div>
      <div class="stat"><div class="val">${stats.total_live||0}</div><div class="lbl">Live DOM</div></div>
      <div class="stat"><div class="val">${stats.total_pending||0}</div><div class="lbl">Pending OCR</div></div>
      <div class="stat"><div class="val">${stats.total_needs_review||0}</div><div class="lbl">Needs Review</div></div>
      <div class="stat"><div class="val">${stats.avg_duration_sec ? (+stats.avg_duration_sec).toFixed(0)+'s' : '—'}</div><div class="lbl">Avg Duration</div></div>
      <div class="stat"><div class="val">${users.length}</div><div class="lbl">Total Users</div></div>
    </div>`;

  // Users table
  const userRows = users.map(u => `
    <tr>
      <td>${esc(u.username)}</td>
      <td><span class="badge ${u.role}">${u.role}</span></td>
      <td>${u.created_at.slice(0,10)}</td>
      <td>${u.last_login ? u.last_login.slice(0,16).replace('T',' ') : '—'}</td>
      <td>${u.active ? '✅ Active' : '🚫 Disabled'}</td>
      <td>${u.machine_id
        ? `<span style="font-size:10px;font-family:monospace;color:#6b7590" title="${esc(u.machine_id)}">🔒 ${esc(u.machine_id.slice(0,16))}…</span>`
        : '<span style="font-size:10px;color:#ffb830">⚠️ Not bound yet</span>'
      }</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${u.active
          ? `<form method="POST" action="/admin/user/${u.id}/disable" style="display:inline">
               <button class="btn btn-red" style="padding:3px 10px;font-size:11px">Disable</button></form>`
          : `<form method="POST" action="/admin/user/${u.id}/enable" style="display:inline">
               <button class="btn btn-green" style="padding:3px 10px;font-size:11px">Enable</button></form>`
        }
        ${u.machine_id
          ? `<form method="POST" action="/admin/user/${u.id}/reset-device" style="display:inline"
               onsubmit="return confirm('Reset device lock for ${esc(u.username)}? They can log in from any machine once.')">
               <button class="btn btn-grey" style="padding:3px 10px;font-size:11px" title="Allow this user to log in from a new machine">🔄 Reset Device</button></form>`
          : ''
        }
        <form method="POST" action="/admin/user/${u.id}/reset-password" style="display:inline;display:flex;gap:4px;align-items:center">
          <input name="newpw" placeholder="new password" style="background:#0d0f14;border:1px solid #1e2438;border-radius:5px;color:#c8d0e0;padding:3px 7px;font-size:11px;width:110px">
          <button class="btn btn-blue" style="padding:3px 10px;font-size:11px">Reset PW</button>
        </form>
      </td>
    </tr>`).join('');

  // Add user form
  const addUserForm = `
    <div style="background:#161a24;border:1px solid #1e2438;border-radius:10px;padding:16px;max-width:500px;margin-bottom:20px">
      <div class="section-title" style="margin-top:0">➕ Add New User</div>
      <form method="POST" action="/admin/user/create" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="margin:0;flex:1;min-width:120px">
          <label>Username</label>
          <input type="text" name="username" required>
        </div>
        <div class="field" style="margin:0;flex:1;min-width:120px">
          <label>Password</label>
          <input type="password" name="password" required>
        </div>
        <div class="field" style="margin:0">
          <label>Role</label>
          <select name="role" style="background:#0d0f14;border:1px solid #1e2438;border-radius:7px;color:#c8d0e0;padding:9px 10px;font-size:13px">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" class="btn btn-green" style="height:38px">Add User</button>
      </form>
      ${req.query.msg === 'created'    ? '<div class="alert alert-ok"  style="margin-top:10px">✅ User created successfully!</div>' : ''}
      ${req.query.msg === 'exists'     ? '<div class="alert alert-err" style="margin-top:10px">⚠️ Username already exists — choose a different one.</div>' : ''}
      ${req.query.msg === 'pwreset'    ? '<div class="alert alert-ok"  style="margin-top:10px">✅ Password updated!</div>' : ''}
      ${req.query.msg === 'devicereset'? '<div class="alert alert-ok"  style="margin-top:10px">✅ Device reset — user can now log in from a new machine.</div>' : ''}
      ${req.query.msg === 'nousername' ? '<div class="alert alert-err" style="margin-top:10px">⚠️ Username is required.</div>' : ''}
      ${req.query.msg === 'nopassword' ? '<div class="alert alert-err" style="margin-top:10px">⚠️ Password is required.</div>' : ''}
      ${req.query.msg === 'err'        ? `<div class="alert alert-err" style="margin-top:10px">⚠️ Error: ${esc(req.query.detail || 'Could not create user — check server console.')}` + '</div>' : ''}
    </div>`;

  const body = `
    ${statCards}
    <div class="section-title">👥 Users</div>
    ${addUserForm}
    <table style="margin-bottom:28px">
      <thead><tr>
        <th>Username</th><th>Role</th><th>Created</th><th>Last Login</th><th>Status</th><th>Machine</th><th>Actions</th>
      </tr></thead>
      <tbody>${userRows || '<tr><td colspan="7" style="color:#6b7590;padding:16px">No users yet</td></tr>'}</tbody>
    </table>
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      📋 All Sessions
      <div style="display:flex;gap:8px;align-items:center">
        <span class="auto-refresh" id="cd">Auto-refresh in <b id="s">30</b>s</span>
      </div>
    </div>
    ${sessionTable(sessions, true, activeSessions)}
    <script>
    let s=30;
    // Strip ?msg= from URL immediately so it doesn't re-show on auto-refresh
    if(window.location.search.includes('msg='))
      window.history.replaceState({},'',window.location.pathname);
    const _cd=setInterval(()=>{
      s--;
      const e=document.getElementById('s');
      if(e)e.textContent=s;
      if(s<=0){clearInterval(_cd);location.reload();}
    },1000);
    // Auto-dismiss alert messages after 4 seconds
    setTimeout(()=>{
      document.querySelectorAll('.alert').forEach(el=>{
        el.style.transition='opacity 0.5s';
        el.style.opacity='0';
        setTimeout(()=>el.remove(),500);
      });
    },4000);
    </script>
  `;

  res.send(htmlShell('Admin Dashboard', body, req.user));
});

// POST /admin/user/create
app.post('/admin/user/create', requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    console.log('[Admin] Create user request — username:', username, 'role:', role);

    if (!username || !username.trim()) return res.redirect('/admin?msg=nousername');
    if (!password || !password.trim()) return res.redirect('/admin?msg=nopassword');

    const existing = stmts.getUserByUsername.get(username.trim());
    console.log('[Admin] Existing user check:', existing ? 'EXISTS' : 'NEW');
    if (existing) return res.redirect('/admin?msg=exists');

    // Create the user
    const hash     = await bcrypt.hash(password, 10);
    const userRole = role === 'admin' ? 'admin' : 'user';
    stmts.createUser.run({
      username:      username.trim(),
      password_hash: hash,
      role:          userRole,
      created_at:    new Date().toISOString(),
    });

    console.log('[Admin] User created successfully:', username.trim());
    res.redirect('/admin?msg=created');
  } catch(e) {
    console.error('[Admin] Create user ERROR:', e.message);
    res.redirect('/admin?msg=err&detail=' + encodeURIComponent(e.message.slice(0, 80)));
  }
});

// POST /admin/user/:id/disable
app.post('/admin/user/:id/disable', requireAdmin, (req, res) => {
  stmts.setUserActive.run(req.params.id, 0);
  res.redirect('/admin');
});

// POST /admin/user/:id/enable
app.post('/admin/user/:id/enable', requireAdmin, (req, res) => {
  stmts.setUserActive.run(req.params.id, 1);
  res.redirect('/admin');
});

// POST /admin/user/:id/reset-password
app.post('/admin/user/:id/reset-password', requireAdmin, async (req, res) => {
  const { newpw } = req.body;
  if (!newpw) return res.redirect('/admin');
  const hash = await bcrypt.hash(newpw, 10);
  stmts.updatePassword.run(req.params.id, hash);
  res.redirect('/admin?msg=pwreset');
});

// POST /admin/user/:id/reset-device — clears machine_id so user can log in from a new machine
app.post('/admin/user/:id/reset-device', requireAdmin, (req, res) => {
  stmts.resetMachineId.run(req.params.id);
  const user = stmts.getUserById.get(req.params.id);
  console.log(`[Admin] Device reset for user: ${user?.username || req.params.id}`);
  res.redirect('/admin?msg=devicereset');
});

// ════════════════════════════════════════════════════════════════════════════════
// USER DASHBOARD
// ════════════════════════════════════════════════════════════════════════════════

app.get('/dashboard', requireLogin, (req, res) => {
  const sessions = stmts.listSessionsByUser.all(req.user.id, 100);
  const stats    = stmts.getStatsByUser.get(req.user.id) || {};

  const statCards = `
    <div class="stats">
      <div class="stat"><div class="val">${stats.total_sessions||0}</div><div class="lbl">My Sessions</div></div>
      <div class="stat"><div class="val">${stats.total_urls_audited||0}</div><div class="lbl">URLs Audited</div></div>
      <div class="stat"><div class="val">${stats.total_needs_review||0}</div><div class="lbl">Needs Review</div></div>
      <div class="stat"><div class="val">${stats.avg_duration_sec ? (+stats.avg_duration_sec).toFixed(0)+'s' : '—'}</div><div class="lbl">Avg Duration</div></div>
    </div>`;

  const body = `
    ${statCards}
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      📋 My Audit Sessions
      <span class="auto-refresh" id="cd">Auto-refresh in <b id="s">30</b>s</span>
    </div>
    ${sessionTable(sessions, false, activeSessions)}
    <script>
    let s=30;
    // Strip ?msg= from URL immediately so it doesn't re-show on auto-refresh
    if(window.location.search.includes('msg='))
      window.history.replaceState({},'',window.location.pathname);
    const _cd=setInterval(()=>{
      s--;
      const e=document.getElementById('s');
      if(e)e.textContent=s;
      if(s<=0){clearInterval(_cd);location.reload();}
    },1000);
    // Auto-dismiss alert messages after 4 seconds
    setTimeout(()=>{
      document.querySelectorAll('.alert').forEach(el=>{
        el.style.transition='opacity 0.5s';
        el.style.opacity='0';
        setTimeout(()=>el.remove(),500);
      });
    },4000);
    </script>
  `;
  res.send(htmlShell('My Dashboard', body, req.user));
});

// Redirect root to dashboard or login
app.get('/', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) {
    const user = stmts.getTokenUser.get(token);
    if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
  }
  res.redirect('/login');
});

// ════════════════════════════════════════════════════════════════════════════════
// API — EXTENSION AUTH
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login  { username, password, machineId }  → { token, username, role }
app.post('/api/auth/login', async (req, res) => {
  const { username, password, machineId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = stmts.getUserByUsername.get(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.active) return res.status(403).json({ error: 'Account disabled' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  // ── Machine ID check for non-admin users ──────────────────────────────
  if (user.role !== 'admin' && machineId) {
    if (user.machine_id && user.machine_id !== machineId) {
      // Already bound to a different machine — reject login
      console.log(`[Login] BLOCKED — ${username} tried from wrong machine.`);
      return res.status(403).json({
        error: 'This account is locked to another machine. Contact admin to reset your device.'
      });
    }
    // First login on this machine — bind it now
    if (!user.machine_id) {
      stmts.bindMachineId.run(user.id, machineId);
      console.log(`[Login] Machine bound for ${username}: ${machineId.slice(0,12)}...`);
    }
  }

  stmts.updateLastLogin.run(user.id);
  const token = createToken(user.id);
  console.log(`[Login] SUCCESS — ${username} from machine: ${machineId ? machineId.slice(0,12)+'...' : 'unknown'}`);
  res.json({ token, username: user.username, role: user.role, userId: user.id });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) stmts.deleteToken.run(token);
  res.json({ ok: true });
});

// GET /api/auth/me — check if token is still valid
app.get('/api/auth/me', requireLogin, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, userId: req.user.id });
});

// ════════════════════════════════════════════════════════════════════════════════
// API — AUDIT (requires login token)
// ════════════════════════════════════════════════════════════════════════════════

// POST /api/audit/start
app.post('/api/audit/start', requireLogin, (req, res) => {
  const { businessName, urls, biz } = req.body;
  console.log(`[Audit] START — user: ${req.user.username} (id:${req.user.id}) token: ${getTokenFromRequest(req)?.slice(0,8)}...`);
  if (!urls?.length)     return res.status(400).json({ error: 'No URLs provided' });
  if (!biz?.businessName) return res.status(400).json({ error: 'No business data' });

  const sessionId = uuid();
  const startedAt = new Date().toISOString();
  const liveCount = urls.filter(u =>  u.isLive && !u.noAudit).length;
  const pendCount = urls.filter(u => !u.isLive && !u.noAudit).length;
  const ip        = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  stmts.insertSession.run({
    session_id:    sessionId,
    user_id:       req.user.id,
    username:      req.user.username,
    business_name: businessName || biz.businessName,
    started_at:    startedAt,
    total_urls:    urls.length,
    live_urls:     liveCount,
    pending_urls:  pendCount,
    ip_address:    ip,
  });

  activeSessions.set(sessionId, {
    queue:        [...urls],
    results:      {},
    biz,
    startedAt:    Date.now(),
    idx:          0,
    total:        urls.length,
    done:         false,
    cancelled:    false,
    currentLabel: '',
    userId:       req.user.id,
    username:     req.user.username,
  });

  res.json({ sessionId, total: urls.length });
  runAuditSession(sessionId).catch(e => console.error('[Server] Session error:', e.message));
});

// GET /api/audit/progress/:sessionId
app.get('/api/audit/progress/:sessionId', requireLogin, (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    const dbSess = stmts.getSession.get(req.params.sessionId);
    if (dbSess) return res.json({ running: false, done: true, idx: dbSess.total_urls, total: dbSess.total_urls, results: {}, currentLabel: 'Complete' });
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    running:      !session.done && !session.cancelled,
    done:         session.done,
    cancelled:    session.cancelled,
    idx:          session.idx,
    total:        session.total,
    currentLabel: session.currentLabel,
    results:      session.results,
  });
});

// POST /api/audit/cancel/:sessionId
app.post('/api/audit/cancel/:sessionId', requireLogin, (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (session) {
    session.cancelled = true;
    stmts.cancelSession.run({ session_id: req.params.sessionId, finished_at: new Date().toISOString() });
  }
  res.json({ ok: true });
});

// GET /api/health  — public
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT RUNNER
function computeCounts(results, biz) {
  // Only count fields that have a value in the business data
  // This matches exactly what the CSV shows (filtered by biz[key])
  const activeKeys = biz
    ? AUDIT_KEYS.filter(k => biz[k] && String(biz[k]).trim())
    : AUDIT_KEYS;

  let yes = 0, no = 0, na = 0, review = 0;
  for (const r of Object.values(results)) {
    if (!r) { na++; continue; }
    if (r._blocked || r._ok === false || r._error) { na += activeKeys.length; review++; continue; }
    let y = 0, n = 0, a = 0;
    for (const k of activeKeys) {
      if (r[k] === 'Yes') y++;
      else if (r[k] === 'No') n++;
      else a++;
    }
    yes += y; no += n; na += a;
    const allNA = a > 0 && y === 0 && n === 0;
    if (n > y || allNA || r._ocrError) review++;
  }
  return { yesCount: yes, noCount: no, naCount: na, needsReview: review };
}

async function runAuditSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  console.log(`[Server] Session ${sessionId} (${session.username}) — ${session.queue.length} URLs`);

  let browser;
  try {
    browser = await Promise.race([
      getBrowser(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Browser launch timed out 30s')), 30000)),
    ]);
    console.log('[Server] Browser ready');
  } catch(e) {
    console.error('[Server] Browser FAILED:', e.message);
    for (const entry of session.queue) {
      const r = {}; AUDIT_KEYS.forEach(k => { r[k] = 'N/A'; });
      r._serverError = 'Browser failed: ' + e.message.slice(0, 80);
      session.results[entry.label] = r; session.idx++;
    }
    session.done = true; session.currentLabel = 'Browser error';
    stmts.finishSession.run({ session_id: sessionId, finished_at: new Date().toISOString(), duration_sec: 0, yes_count: 0, no_count: 0, needs_review: 0, na_count: session.total });
    return;
  }

  const pagePool = [];
  const actual   = Math.min(MAX_CONCURRENT, session.queue.length);
  for (let i = 0; i < actual; i++) {
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', req => { if (['image','media','font'].includes(req.resourceType())) req.abort(); else req.continue(); });
      pagePool.push(page);
    } catch(e) { console.error('[Server] Page create error:', e.message); }
  }

  if (!pagePool.length) {
    session.done = true; session.currentLabel = 'No pages created';
    return;
  }
  console.log(`[Server] ${pagePool.length} worker(s) ready`);

  try {
    const workers = pagePool.map(async (page) => {
      while (!session.cancelled && session.queue.length > 0) {
        const entry = session.queue.shift();
        if (!entry) break;
        session.currentLabel = entry.label.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30);
        console.log(`[Server] [${session.idx+1}/${session.total}] ${session.currentLabel} (${session.username})`);
        const t0 = Date.now();
        let result, auditType = 'pending';
        try {
          if (entry.noAudit) {
            result = {}; AUDIT_KEYS.forEach(k => { result[k] = 'Pending'; });
          } else if (entry.isLive && entry.url) {
            auditType = 'live_dom';
            result = await Promise.race([
              auditPage(page, entry.url, session.biz),
              new Promise((_, rej) => setTimeout(() => rej(new Error('Page timeout 40s')), 40000)),
            ]);
          } else if (!entry.isLive && entry.screenshot) {
            auditType = 'screenshot_ocr';
            result = await auditViaScreenshot(entry.screenshot, session.biz);
          } else {
            result = {}; AUDIT_KEYS.forEach(k => { result[k] = 'Pending'; });
          }
        } catch(e) {
          console.error('[Server] Entry error:', e.message.slice(0, 60));
          result = {}; AUDIT_KEYS.forEach(k => { result[k] = 'N/A'; });
        }
        session.results[entry.label] = result;
        session.idx++;
        try {
          const dur = (Date.now() - t0) / 1000;
          const y = AUDIT_KEYS.filter(k => result[k] === 'Yes').length;
          const n = AUDIT_KEYS.filter(k => result[k] === 'No').length;
          stmts.insertSiteResult.run({
            session_id: sessionId, site_label: entry.label.slice(0, 300), audit_type: auditType,
            started_at: new Date(t0).toISOString(), finished_at: new Date().toISOString(),
            duration_sec: dur, result_json: JSON.stringify(result),
            needs_review: (() => {
              if (result._blocked || result._ok === false || result._error || result._ocrError) return 1;
              const activeK = session.biz ? AUDIT_KEYS.filter(k => session.biz[k] && String(session.biz[k]).trim()) : AUDIT_KEYS;
              const y = activeK.filter(k => result[k] === 'Yes').length;
              const n = activeK.filter(k => result[k] === 'No').length;
              const a = activeK.filter(k => result[k] === 'N/A').length;
              return (n > y || (a > 0 && y === 0 && n === 0)) ? 1 : 0;
            })(),
            blocked: result._blocked ? 1 : 0,
          });
        } catch(e) { console.error('[Server] DB insert error:', e.message); }
      }
      try { await page.close(); } catch(_) {}
    });
    await Promise.all(workers);
  } finally {
    session.done = true; session.currentLabel = 'Complete';
    try {
      const { yesCount, noCount, naCount, needsReview } = computeCounts(session.results, session.biz);
      const dur = (Date.now() - session.startedAt) / 1000;
      stmts.finishSession.run({
        session_id: sessionId, finished_at: new Date().toISOString(),
        duration_sec: dur, yes_count: yesCount, no_count: noCount,
        needs_review: needsReview, na_count: naCount,
      });
      console.log(`[Server] ✅ ${session.username} — Done in ${dur.toFixed(1)}s | yes:${yesCount} no:${noCount} review:${needsReview}`);
    } catch(e) { console.error('[Server] finishSession error:', e.message); }
    setTimeout(() => activeSessions.delete(sessionId), 5 * 60 * 1000);
  }
}


// ════════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE CSV PARSING — extension sends raw CSV text, server parses it
// This removes ALL parsing logic from the extension
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/csv/parse', requireLogin, (req, res) => {
  const { csvText } = req.body;
  if (!csvText) return res.status(400).json({ error: 'No CSV text provided' });
  try {
    const parsed = parseCSVOnServer(csvText);
    res.json({ data: parsed });
  } catch(e) {
    res.status(400).json({ error: 'CSV parse error: ' + e.message });
  }
});

function parseRow(row) {
  const result = []; let cur = '', inQ = false;
  for (const ch of row) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function parseCSVOnServer(text) {
  const data = { business: {}, credentials: [] };
  const kvMap = {
    'business name':'businessName','contact name':'contactName',
    'address line 1':'address','location':'city','state':'state',
    'zip code':'zip','country':'country','phone':'phone',
    'business email':'email','website':'website','category':'category',
    'keyword':'keywords','description':'description','logo url':'logoUrl',
    'facebook':'facebook','instagram':'instagram','youtube':'youtube',
    'working hours':'hours','create email id':'loginEmail','password':'loginPassword',
  };
  const lines  = text.split(/\r?\n/);
  let inTable  = false, headers = [];
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    if (!inTable && raw.toLowerCase().includes('site name') && raw.toLowerCase().includes('username')) {
      inTable = true;
      headers = parseRow(raw).map(h => h.trim().toLowerCase());
      continue;
    }
    if (inTable) {
      const cols = parseRow(raw);
      if (cols.length < 2) continue;
      const row = {};
      headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
      const site = row['site name'];
      if (site) {
        data.credentials.push({
          site,
          username:   row['username']          || '',
          password:   row['password']          || '',
          status:     row['status']            || '',
          liveUrl:    row['live url']          || '',
          screenshot: row['extra screenshoot'] || row['extra screenshot'] || '',
          nap:        row['nap']               || '',
          logo:       row['logo']              || '',
          website:    row['website']           || '',
          email:      row['business email']    || '',
          social:     row['social link']       || '',
          video:      row['video']             || '',
        });
      }
      continue;
    }
    const cols  = parseRow(raw);
    if (cols.length >= 2) {
      const keyRaw = (cols[0]||'').trim().toLowerCase().replace(/\s*:\s*$/,'').replace(/:$/,'').trim();
      const val    = (cols[1]||'').trim();
      const mapped = kvMap[keyRaw];
      if (mapped && val) data.business[mapped] = val;
    }
  }
  return data;
}

// ════════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE CSV GENERATION — server builds the updated CSV, extension downloads it
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/csv/generate', requireLogin, (req, res) => {
  const { businessData, fieldAuditResults, sessionId } = req.body;
  if (!businessData) return res.status(400).json({ error: 'No business data' });
  try {
    let authoritative = fieldAuditResults || {};

    // If sessionId provided, use server's own DB records as SOLE source
    // Server records are authoritative — they always match the admin count
    if (sessionId) {
      const siteResults = stmts.getSiteResults.all(sessionId);
      if (siteResults && siteResults.length > 0) {
        const serverResults = {};
        for (const sr of siteResults) {
          try {
            const parsed = JSON.parse(sr.result_json || '{}');
            serverResults[sr.site_label] = parsed;
            // Debug: log each result's review status
            const y = Object.values(parsed).filter(v => v === 'Yes').length;
            const n = Object.values(parsed).filter(v => v === 'No').length;
            const a = Object.values(parsed).filter(v => v === 'N/A').length;
            const blocked = parsed._blocked;
            const isReview = blocked || n > y || a === 17;
            console.log(`[CSV-DEBUG] ${sr.site_label.slice(0,50)} → yes:${y} no:${n} na:${a} blocked:${!!blocked} review:${isReview}`);
          } catch(_) {}
        }
        // Use server records exclusively — ignore extension's fieldAuditResults
        authoritative = serverResults;
        console.log(`[CSV] Using ${siteResults.length} server records for session ${sessionId}`);

        // Count expected Needs Review
        let expectedReview = 0;
        for (const r of Object.values(serverResults)) {
          if (!r) continue;
          if (r._blocked) { expectedReview++; continue; }
          const y = Object.keys(r).filter(k => r[k] === 'Yes').length;
          const n = Object.keys(r).filter(k => r[k] === 'No').length;
          const a = Object.keys(r).filter(k => r[k] === 'N/A').length;
          if (n > y || a === 17) expectedReview++;
        }
        console.log(`[CSV] Expected Needs Review count: ${expectedReview}`);
      }
    }

    const csv = generateCSVOnServer(businessData, authoritative);
    res.json({ csv });
  } catch(e) {
    console.error('[CSV] generate error:', e.message);
    res.status(500).json({ error: 'CSV generation failed: ' + e.message });
  }
});

const AUDIT_KEYS_CSV = [
  'contactName','businessName','address','city','state','zip','country',
  'phone','email','website','category','keywords','description',
  'logoUrl','facebook','instagram','youtube',
];

function generateCSVOnServer(businessData, fieldAuditResults) {
  const biz   = businessData.business   || {};
  const creds = businessData.credentials || [];

  function cell(val) {
    const s = String(val == null ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const rows = [];

  // Business info section
  const kvRows = [
    ['Contact Name : ',   biz.contactName  || ''],
    ['Business Name : ',  biz.businessName || ''],
    ['Address Line 1 : ', biz.address      || ''],
    ['Location : ',       biz.city         || ''],
    ['State : ',          biz.state        || ''],
    ['Zip code : ',       biz.zip          || ''],
    ['Country : ',        biz.country      || ''],
    ['Phone : ',          biz.phone        || ''],
    ['Business Email : ', biz.email        || ''],
    ['Website : ',        biz.website      || ''],
    ['Category : ',       biz.category     || ''],
    ['Keyword : ',        biz.keywords     || ''],
    ['Description : ',    biz.description  || ''],
    ['Logo Url : ',       biz.logoUrl      || ''],
    ['Facebook : ',       biz.facebook     || ''],
    ['Instagram : ',      biz.instagram    || ''],
    ['YouTube :',         biz.youtube      || ''],
    ['Working hours : ',  biz.hours        || ''],
    ['Create Email ID : ',biz.loginEmail   || ''],
    ['Password :',        biz.loginPassword|| ''],
    ['',                  'Local Citation' ],
  ];
  for (const r of kvRows) rows.push([cell(r[0]), cell(r[1]), '', '', '', '', '', '', '', '', '', ''].join(','));

  // Credentials table header
  rows.push('Site Name,Username,Password,Status,Live URL,Extra Screenshoot,NAP,Logo,Website,Business Email,Social Link,Video,Review');

  // Each site row with Yes/No from audit results
  for (const c of creds) {
    const isPending = (c.status || '').toLowerCase() === 'pending';

    // Try multiple key variants to find the result
    // Server stores by entry.label which may differ slightly from c.liveUrl
    let r = null;
    const keyVariants = [];
    if (!isPending && c.liveUrl) {
      keyVariants.push(c.liveUrl);
      keyVariants.push(c.liveUrl.replace(/\/$/, ''));        // strip trailing slash
      keyVariants.push(c.liveUrl + '/');                     // add trailing slash
      keyVariants.push(c.liveUrl.replace(/^https?:\/\/www\./, 'https://'));
      keyVariants.push(c.liveUrl.replace(/^https?:\/\//, 'https://www.'));
    }
    keyVariants.push(c.site);
    // Also try case-insensitive match against all keys
    const allKeys = Object.keys(fieldAuditResults);
    for (const key of keyVariants) {
      if (fieldAuditResults[key]) { r = fieldAuditResults[key]; break; }
      // Case-insensitive fallback
      const match = allKeys.find(k => k.toLowerCase() === key.toLowerCase());
      if (match) { r = fieldAuditResults[match]; break; }
    }
    // Last resort: partial URL match (domain + path)
    if (!r && !isPending && c.liveUrl) {
      try {
        const urlObj = new URL(c.liveUrl);
        const pathKey = urlObj.hostname + urlObj.pathname;
        const partialMatch = allKeys.find(k => {
          try { const ku = new URL(k); return (ku.hostname + ku.pathname).replace(/\/$/,'') === pathKey.replace(/\/$/,''); }
          catch(_) { return false; }
        });
        if (partialMatch) r = fieldAuditResults[partialMatch];
      } catch(_) {}
    }

    function fieldVal(k, fallback) {
      if (!r) return fallback || '';
      const v = r[k];
      return (v === 'Yes' || v === 'No') ? v : (fallback || '');
    }

    let nap = c.nap || '';
    if (r && !r._ocrError) {
      const score = [r.businessName, r.address, r.phone].filter(v => v === 'Yes').length;
      nap = score === 3 ? 'Yes' : score > 0 ? `Partial (${score}/3)` : 'No';
    }

    let social = c.social || '';
    if (r && !r._ocrError) {
      social = (r.facebook === 'Yes' || r.instagram === 'Yes' || r.youtube === 'Yes') ? 'Yes' : 'No';
    }

    // Compute Review value — No > Yes or all N/A or blocked/error → Needs Review
    let reviewVal = 'OK';
    if (!r) {
      reviewVal = '';
    } else if (r._blocked || r._ok === false || r._error || r._ocrError) {
      reviewVal = '[!] Needs Review';
    } else {
      const biz = businessData.business || {};
      const activeK = AUDIT_KEYS.filter(k => biz[k] && String(biz[k]).trim());
      const checkK = activeK.length > 0 ? activeK : AUDIT_KEYS;
      const y = checkK.filter(k => r[k] === 'Yes').length;
      const n = checkK.filter(k => r[k] === 'No').length;
      const a = checkK.filter(k => r[k] === 'N/A').length;
      const allNA = a > 0 && y === 0 && n === 0;
      if (n > y || allNA) reviewVal = '[!] Needs Review';
    }

    const row = [
      c.site, c.username, c.password, c.status,
      c.liveUrl || '', c.screenshot || '',
      nap,
      fieldVal('logoUrl', c.logo    || ''),
      fieldVal('website', c.website || ''),
      fieldVal('email',   c.email   || ''),
      social,
      fieldVal('youtube', c.video   || ''),
      reviewVal,
    ];
    rows.push(row.map(cell).join(','));
  }

  return rows.join('\r\n');
}


// ════════════════════════════════════════════════════════════════════════════════
// GOOGLE SHEETS PUSH
// Exact same format as the extension's "Download Field Audit CSV" button
// Columns: Site/URL | Audit Type | Field1 (value) | ... | Review
// ════════════════════════════════════════════════════════════════════════════════

// Same field definitions as extension AUDIT_FIELDS
const AUDIT_FIELDS_SHEET = [
  { key: 'contactName',  label: 'Contact Name'   },
  { key: 'businessName', label: 'Business Name'  },
  { key: 'address',      label: 'Address Line 1' },
  { key: 'city',         label: 'Location'        },
  { key: 'state',        label: 'State'           },
  { key: 'zip',          label: 'Zip Code'        },
  { key: 'country',      label: 'Country'         },
  { key: 'phone',        label: 'Phone'           },
  { key: 'email',        label: 'Business Email'  },
  { key: 'website',      label: 'Website'         },
  { key: 'category',     label: 'Category'        },
  { key: 'keywords',     label: 'Keywords'        },
  { key: 'description',  label: 'Description'     },
  { key: 'logoUrl',      label: 'Logo URL'        },
  { key: 'facebook',     label: 'Facebook'        },
  { key: 'instagram',    label: 'Instagram'       },
  { key: 'youtube',      label: 'YouTube'         },
];

function getGoogleAuth() {
  const keyPath = process.env.GOOGLE_SERVICE_KEY_PATH || './google-service-key.json';
  const abs = path_.resolve(keyPath);
  if (!fs_.existsSync(abs)) throw new Error('google-service-key.json not found at: ' + abs);
  const key = JSON.parse(fs_.readFileSync(abs, 'utf-8'));
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function extractSheetId(urlOrId) {
  const m = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : urlOrId.trim();
}

function getTodayLabel() {
  const d = new Date();
  const day   = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year  = d.getFullYear();
  return `${day}-${month}-${year}`; // e.g. 20-Mar-2026
}

// Mirrors getAuditUrls() from extension popup.js
function getAuditUrlsServer(credentials) {
  const urls = [];
  const seen = new Set();
  for (const c of credentials) {
    const statusRaw     = (c.status || '').trim().toLowerCase();
    const isLive        = statusRaw === 'live';
    const isPending     = statusRaw === 'pending';
    const hasRealUrl    = c.liveUrl && !c.liveUrl.includes('snipboard');
    const pendingImgUrl = isPending ? (c.liveUrl || '').trim() : '';
    const hasScreenshot = pendingImgUrl !== '';

    if (isLive && hasRealUrl) {
      const key = c.liveUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push({ label: c.liveUrl, site: c.site, isLive: true });
    } else if (isPending && hasScreenshot) {
      const key = 'pending|' + c.site;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push({ label: c.site, site: c.site, isLive: false });
    } else if (isPending && !hasScreenshot) {
      const key = 'pending|' + c.site;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push({ label: c.site, site: c.site, isLive: false });
    }
  }
  return urls;
}

app.post('/api/sheets/push', requireLogin, async (req, res) => {
  const { sheetUrl, businessData, fieldAuditResults, sessionId } = req.body;
  if (!sheetUrl)     return res.status(400).json({ error: 'No Google Sheet URL provided' });
  if (!businessData) return res.status(400).json({ error: 'No business data provided' });

  try {
    // ── Resolve authoritative results from DB (same as /api/csv/generate) ────
    let authoritative = fieldAuditResults || {};
    if (sessionId) {
      const siteResults = stmts.getSiteResults.all(sessionId);
      if (siteResults && siteResults.length > 0) {
        const serverResults = {};
        for (const sr of siteResults) {
          try { serverResults[sr.site_label] = JSON.parse(sr.result_json || '{}'); } catch(_) {}
        }
        authoritative = serverResults;
        console.log(`[Sheets] Using ${siteResults.length} DB records for session ${sessionId}`);
      }
    }

    const biz   = businessData.business    || {};
    const creds = businessData.credentials || [];

    // ── Only fields where biz has a value — mirrors: AUDIT_FIELDS.filter(f => biz[f.key]) ──
    const fields = AUDIT_FIELDS_SHEET.filter(f => biz[f.key]);

    // ── Header row — exact match to extension ────────────────────────────────
    // Extension: ['Site / URL', 'Audit Type', ...fields.map(f => f.label + ' (' + biz[f.key] + ')'), 'Review']
    const header = [
      'Site / URL',
      'Audit Type',
      ...fields.map(f => f.label + ' (' + (biz[f.key] || '') + ')'),
      'Review',
    ];

    // ── Data rows — exact match to extension loop ─────────────────────────────
    const urls = getAuditUrlsServer(creds);
    const dataRows = [];

    for (const u of urls) {
      // Find result — try label first, then URL variants
      let result = authoritative[u.label] || null;
      if (!result) {
        const allKeys = Object.keys(authoritative);
        // case-insensitive match
        const match = allKeys.find(k => k.toLowerCase() === u.label.toLowerCase());
        if (match) result = authoritative[match];
      }
      // URL variants fallback (trailing slash, www, https)
      if (!result && u.isLive && u.label) {
        const variants = [
          u.label.replace(/\/$/, ''),
          u.label + '/',
          u.label.replace(/^https?:\/\/www\./, 'https://'),
          u.label.replace(/^https?:\/\/(?!www)/, 'https://www.'),
        ];
        const allKeys = Object.keys(authoritative);
        for (const v of variants) {
          if (authoritative[v]) { result = authoritative[v]; break; }
          const m = allKeys.find(k => k.toLowerCase() === v.toLowerCase());
          if (m) { result = authoritative[m]; break; }
        }
      }
      // Partial hostname+path fallback
      if (!result && u.isLive && u.label) {
        try {
          const urlObj  = new URL(u.label);
          const pathKey = (urlObj.hostname + urlObj.pathname).replace(/\/$/, '');
          const pm = Object.keys(authoritative).find(k => {
            try {
              const ku = new URL(k);
              return (ku.hostname + ku.pathname).replace(/\/$/, '') === pathKey;
            } catch(_) { return false; }
          });
          if (pm) result = authoritative[pm];
        } catch(_) {}
      }

      // rowLabel — mirrors extension: u.isLive ? u.label : (u.site || u.label)
      const rowLabel  = u.isLive ? u.label : (u.site || u.label);
      const isOcr     = result && result._ocr;
      const auditType = isOcr ? 'Screenshot OCR' : 'Live DOM';

      const row = [rowLabel, auditType];
      let yes = 0, no = 0, na = 0;

      for (const f of fields) {
        const raw = result ? result[f.key] : undefined;
        // Normalize exactly as extension does:
        // (raw === 'Yes' || raw === 'No' || raw === 'N/A') ? raw : (result ? 'No' : '')
        const val = (raw === 'Yes' || raw === 'No' || raw === 'N/A') ? raw : (result ? 'No' : '');
        if (val === 'Yes')      yes++;
        else if (val === 'No')  no++;
        else if (val === 'N/A') na++;
        row.push(val);
      }

      // Review logic — exact match to extension
      let needsReview;
      if (!result) {
        needsReview = false;
      } else if (result._blocked || result._ok === false || result._error || result._ocrError) {
        needsReview = true;
      } else {
        const allNA = na > 0 && yes === 0 && no === 0;
        needsReview = no > yes || allNA;
      }
      row.push(needsReview ? '[!] Needs Review' : 'OK');
      dataRows.push(row);
    }

    // ── Connect to Google Sheets ──────────────────────────────────────────────
    const auth          = getGoogleAuth();
    const sheets        = google.sheets({ version: 'v4', auth });
    const spreadsheetId = extractSheetId(sheetUrl);

    // ── Get existing tab names to avoid duplicates ────────────────────────────
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingNames = meta.data.sheets.map(s => s.properties.title);
    const baseLabel = 'QC Sheet ' + getTodayLabel();
    let   tabName   = baseLabel;
    let   counter   = 2;
    while (existingNames.includes(tabName)) {
      tabName = `${baseLabel} (${counter++})`;
    }

    // ── Create new tab ────────────────────────────────────────────────────────
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    const newSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

    // ── Write all rows ────────────────────────────────────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...dataRows] },
    });

    // ── Format: bold header + freeze row + auto-resize columns ───────────────
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            // Bold header with dark background
            repeatCell: {
              range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.13, green: 0.09, blue: 0.22 },
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          {
            // Freeze header row
            updateSheetProperties: {
              properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            // Auto-resize all columns
            autoResizeDimensions: {
              dimensions: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: header.length },
            },
          },
        ],
      },
    });

    console.log(`[Sheets] Pushed ${dataRows.length} rows → tab "${tabName}" in ${spreadsheetId}`);
    res.json({ success: true, tabName, rowCount: dataRows.length });

  } catch(e) {
    console.error('[Sheets] push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add license link to admin dashboard

// ════════════════════════════════════════════════════════════════════════════════
// STARTUP — create default admin if no users exist
// ════════════════════════════════════════════════════════════════════════════════
initDb().then(async () => {
  // Clean up expired tokens
  stmts.deleteExpiredTokens.run();

  // Create default admin if no users exist
  const users = stmts.listUsers.all();
  if (users.length === 0) {
    const defaultPass = process.env.ADMIN_PASSWORD || 'Admin@1234';
    const hash = await bcrypt.hash(defaultPass, 10);
    stmts.createUser.run({
      username:      'admin',
      password_hash: hash,
      role:          'admin',
      created_at:    new Date().toISOString(),
    });
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║  Default admin account created:              ║');
    console.log('║  Username: admin                             ║');
    console.log(`║  Password: ${defaultPass.padEnd(34)}║`);
    console.log('║  👆 Change this password after first login!  ║');
    console.log('╚══════════════════════════════════════════════╝\n');
  }


    app.listen(PORT, () => {
    console.log(`✅ Citation Audit Server running on http://localhost:${PORT}`);
    console.log(`   Login:  http://localhost:${PORT}/login`);
    console.log(`   Admin:  http://localhost:${PORT}/admin`);
    console.log(`   Health: http://localhost:${PORT}/api/health\n`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
