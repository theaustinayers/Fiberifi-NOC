import { DatabaseSync } from 'node:sqlite';
import { parseCidr, toHex } from './lib/ip.js';
import { generatePassword, hashPassword } from './lib/security.js';

export const DEFAULT_PREFIXES = ['2001:504:13A::/48', '2607:9340::/32', '149.112.89.0/24', '206.168.244.0/22'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- start_hex and end_hex are zero-padded to 32 characters, so plain string comparison is numeric comparison.
CREATE TABLE IF NOT EXISTS prefixes (
  id INTEGER PRIMARY KEY,
  family INTEGER NOT NULL CHECK (family IN (4, 6)),
  cidr TEXT NOT NULL UNIQUE,
  length INTEGER NOT NULL,
  start_hex TEXT NOT NULL,
  end_hex TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('container', 'active', 'reserved', 'deprecated')),
  description TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  vlan INTEGER,
  customer_id INTEGER REFERENCES users (id) ON DELETE RESTRICT,
  gateway TEXT,
  assigned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS prefixes_range ON prefixes (family, start_hex, end_hex);
CREATE INDEX IF NOT EXISTS prefixes_customer ON prefixes (customer_id);

CREATE TABLE IF NOT EXISTS ip_records (
  id INTEGER PRIMARY KEY,
  family INTEGER NOT NULL,
  ip_hex TEXT NOT NULL,
  ip TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'reserved', 'dhcp')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (family, ip_hex)
);

CREATE TABLE IF NOT EXISTS rdns_records (
  id INTEGER PRIMARY KEY,
  family INTEGER NOT NULL,
  ip_hex TEXT NOT NULL,
  ip TEXT NOT NULL,
  ptr_name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (family, ip_hex)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log (ts);
`;

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getSetting(db, key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

// Runs once per database. The flag matters: a default range an admin deletes must stay deleted after a restart.
export async function seed(db, config, log = console.log) {
  if (getSetting(db, 'seeded') === '1') return;

  const insert = db.prepare(
    `INSERT INTO prefixes (family, cidr, length, start_hex, end_hex, status, description)
     VALUES (?, ?, ?, ?, ?, 'container', 'Fiberifi allocation')`,
  );
  for (const text of DEFAULT_PREFIXES) {
    const p = parseCidr(text);
    insert.run(p.family, p.cidr, p.length, toHex(p.network), toHex(p.last));
  }

  const password = config.adminPassword || generatePassword();
  db.prepare(
    `INSERT INTO users (role, email, name, password_hash, must_change_password) VALUES ('admin', ?, 'Administrator', ?, 1)`,
  ).run(config.adminEmail, await hashPassword(password));
  setSetting(db, 'seeded', '1');

  // Never logged in production: journald would keep it. The installer prints one with noc-reset-admin instead.
  if (!config.adminPassword && !config.production) {
    log(`\nFirst admin account created. This password is shown once and must be changed at first login.`);
    log(`  Email:    ${config.adminEmail}\n  Password: ${password}\n`);
  }
}
