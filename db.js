// SQLite schema. Every script belongs to a workspace (one workspace per client/company).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.DB_FILE), { recursive: true });
const db = new DatabaseSync(config.DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key_hash TEXT UNIQUE,
    plan_status TEXT NOT NULL DEFAULT 'trial',   -- trial | active | past_due | canceled
    trial_ends_at TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    ns_account TEXT,
    ns_restlet_url TEXT,
    ns_creds_enc TEXT,                           -- encrypted JSON of the 4 TBA values
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ns_file_id TEXT,                             -- File Cabinet internal ID, enables drift check
    drift_status TEXT NOT NULL DEFAULT 'unknown',-- unknown | in_sync | drifted | error
    drift_error TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, name)
  );

  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    note TEXT,
    author TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (script_id, version_no)
  );

  CREATE INDEX IF NOT EXISTS idx_versions_script ON versions(script_id);
  CREATE INDEX IF NOT EXISTS idx_scripts_ws ON scripts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_users_ws ON users(workspace_id);
`);

module.exports = db;
