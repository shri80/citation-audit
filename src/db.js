// src/db.js — SQLite database (sql.js — pure JS, no compilation needed)
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config();

const DB_PATH = path.resolve(process.env.DB_PATH || './logs/audit_logs.db');
const dir     = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const initSqlJs = require('sql.js');
let db = null;

async function initDb() {
  if (db) return db;
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('[DB] Loaded:', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created:', DB_PATH);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'user',
      machine_id    TEXT,
      created_at    TEXT    NOT NULL,
      last_login    TEXT,
      active        INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_tokens (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL UNIQUE,
      user_id       INTEGER,
      username      TEXT,
      business_name TEXT    NOT NULL,
      started_at    TEXT    NOT NULL,
      finished_at   TEXT,
      duration_sec  REAL,
      total_urls    INTEGER DEFAULT 0,
      live_urls     INTEGER DEFAULT 0,
      pending_urls  INTEGER DEFAULT 0,
      yes_count     INTEGER DEFAULT 0,
      no_count      INTEGER DEFAULT 0,
      needs_review  INTEGER DEFAULT 0,
      na_count      INTEGER DEFAULT 0,
      ip_address    TEXT,
      status        TEXT    DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS audit_site_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      site_label   TEXT    NOT NULL,
      audit_type   TEXT    NOT NULL,
      started_at   TEXT    NOT NULL,
      finished_at  TEXT,
      duration_sec REAL,
      result_json  TEXT,
      needs_review INTEGER DEFAULT 0,
      blocked      INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sess_user ON audit_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sess_time ON audit_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_site_sess ON audit_site_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_tok_user  ON user_tokens(user_id);
  `);

  // Add machine_id column to existing databases that don't have it yet
  try { db.run('ALTER TABLE users ADD COLUMN machine_id TEXT'); } catch(_) {}

  persist();
  return db;
}

function persist() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch(e) { console.error('[DB] persist error:', e.message); }
}

function run(sql, params = []) {
  try { db.run(sql, params); persist(); }
  catch(e) { console.error('[DB] run error:', e.message); throw e; }
}

function get(sql, params = []) {
  try {
    const s = db.prepare(sql);
    s.bind(params);
    const hasRow = s.step();
    const r = hasRow ? s.getAsObject() : null;
    s.free();
    return r;
  } catch(e) { console.error('[DB] get error:', e.message); return null; }
}

function all(sql, params = []) {
  try {
    const s = db.prepare(sql);
    const rows = [];
    s.bind(params);
    while (s.step()) rows.push(s.getAsObject());
    s.free();
    return rows;
  } catch(e) { console.error('[DB] all error:', e.message); return []; }
}

const stmts = {
  // ── Users ────────────────────────────────────────────────────────────────
  createUser: {
    run: (p) => run(
      `INSERT INTO users (username, password_hash, role, created_at)
       VALUES (?, ?, ?, ?)`,
      [p.username, p.password_hash, p.role || 'user', p.created_at]
    ),
  },
  getUserByUsername: {
    get: (username) => get(
      'SELECT * FROM users WHERE username = ? AND active = 1', [username]
    ),
  },
  getUserById: {
    get: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
  },
  listUsers: {
    all: () => all(
      'SELECT id, username, role, machine_id, created_at, last_login, active FROM users ORDER BY created_at DESC'
    ),
  },
  updateLastLogin: {
    run: (userId) => run(
      'UPDATE users SET last_login = ? WHERE id = ?',
      [new Date().toISOString(), userId]
    ),
  },
  setUserActive: {
    run: (id, active) => run(
      'UPDATE users SET active = ? WHERE id = ?', [active, id]
    ),
  },
  updatePassword: {
    run: (id, hash) => run(
      'UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]
    ),
  },
  // Bind machine ID to user (first login on a machine)
  bindMachineId: {
    run: (userId, machineId) => run(
      'UPDATE users SET machine_id = ? WHERE id = ?', [machineId, userId]
    ),
  },
  // Reset machine ID — allows user to activate on a new machine
  resetMachineId: {
    run: (userId) => run(
      'UPDATE users SET machine_id = NULL WHERE id = ?', [userId]
    ),
  },

  // ── Tokens ───────────────────────────────────────────────────────────────
  createToken: {
    run: (p) => run(
      `INSERT INTO user_tokens (token, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [p.token, p.user_id, p.created_at, p.expires_at]
    ),
  },
  getTokenUser: {
    get: (token) => get(
      `SELECT u.* FROM user_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.expires_at > ? AND u.active = 1`,
      [token, new Date().toISOString()]
    ),
  },
  deleteToken: {
    run: (token) => run('DELETE FROM user_tokens WHERE token = ?', [token]),
  },
  deleteExpiredTokens: {
    run: () => run(
      'DELETE FROM user_tokens WHERE expires_at < ?', [new Date().toISOString()]
    ),
  },

  // ── Audit Sessions ───────────────────────────────────────────────────────
  insertSession: {
    run: (p) => run(
      `INSERT OR IGNORE INTO audit_sessions
         (session_id, user_id, username, business_name, started_at,
          total_urls, live_urls, pending_urls, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.session_id, p.user_id, p.username, p.business_name, p.started_at,
       p.total_urls, p.live_urls, p.pending_urls, p.ip_address]
    ),
  },
  finishSession: {
    run: (p) => run(
      `UPDATE audit_sessions SET
         finished_at = ?, duration_sec = ?, yes_count = ?,
         no_count = ?, needs_review = ?, na_count = ?, status = 'done'
       WHERE session_id = ?`,
      [p.finished_at, p.duration_sec, p.yes_count,
       p.no_count, p.needs_review, p.na_count, p.session_id]
    ),
  },
  cancelSession: {
    run: (p) => run(
      `UPDATE audit_sessions SET finished_at = ?, status = 'cancelled'
       WHERE session_id = ?`,
      [p.finished_at, p.session_id]
    ),
  },
  getSession: {
    get: (id) => get('SELECT * FROM audit_sessions WHERE session_id = ?', [id]),
  },
  listSessions: {
    all: (limit) => all(
      'SELECT * FROM audit_sessions ORDER BY started_at DESC LIMIT ?', [limit]
    ),
  },
  listSessionsByUser: {
    all: (userId, limit) => all(
      'SELECT * FROM audit_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?',
      [userId, limit]
    ),
  },
  getStats: {
    get: () => get(`
      SELECT COUNT(*) AS total_sessions, SUM(total_urls) AS total_urls_audited,
             SUM(live_urls) AS total_live, SUM(pending_urls) AS total_pending,
             SUM(needs_review) AS total_needs_review, AVG(duration_sec) AS avg_duration_sec
      FROM audit_sessions WHERE status = 'done'
    `),
  },
  getStatsByUser: {
    get: (userId) => get(`
      SELECT COUNT(*) AS total_sessions, SUM(total_urls) AS total_urls_audited,
             SUM(needs_review) AS total_needs_review, AVG(duration_sec) AS avg_duration_sec
      FROM audit_sessions WHERE user_id = ? AND status = 'done'
    `, [userId]),
  },

  // ── Site Results ─────────────────────────────────────────────────────────
  insertSiteResult: {
    run: (p) => run(
      `INSERT INTO audit_site_results
         (session_id, site_label, audit_type, started_at, finished_at,
          duration_sec, result_json, needs_review, blocked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.session_id, p.site_label, p.audit_type, p.started_at, p.finished_at,
       p.duration_sec, p.result_json, p.needs_review, p.blocked]
    ),
  },
  getSiteResults: {
    all: (id) => all(
      'SELECT * FROM audit_site_results WHERE session_id = ? ORDER BY id', [id]
    ),
  },
};

module.exports = { initDb, stmts };
