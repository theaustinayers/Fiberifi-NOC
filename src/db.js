import { DatabaseSync } from 'node:sqlite';
import { parseCidr, toHex } from './lib/ip.js';
import { generatePassword, hashPassword } from './lib/security.js';

export const DEFAULT_PREFIXES = ['2001:504:13A::/48', '2607:9340::/32', '149.112.89.0/24', '206.168.244.0/22'];

export const SCHEMA = `
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

// SCHEMA above is the original layout and stays frozen. Every later change is a migration, so a new install
// and a live server upgrading always end up with the same database.
const MIGRATIONS = [
  // 1: customer teams, and datacenters replacing the free-text site field.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN parent_id INTEGER REFERENCES users (id) ON DELETE CASCADE;
      ALTER TABLE users ADD COLUMN access TEXT NOT NULL DEFAULT 'admin' CHECK (access IN ('admin', 'read_only'));
      CREATE INDEX users_parent ON users (parent_id);

      CREATE TABLE datacenters (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        code TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      ALTER TABLE prefixes ADD COLUMN datacenter_id INTEGER REFERENCES datacenters (id) ON DELETE RESTRICT;
      CREATE INDEX prefixes_datacenter ON prefixes (datacenter_id);
    `);

    // Anything already typed into Site becomes a datacenter, so no data is lost.
    const addDatacenter = db.prepare('INSERT OR IGNORE INTO datacenters (name) VALUES (?)');
    const findDatacenter = db.prepare('SELECT id FROM datacenters WHERE name = ?');
    const link = db.prepare('UPDATE prefixes SET datacenter_id = ? WHERE site = ?');
    for (const { site } of db.prepare(`SELECT DISTINCT site FROM prefixes WHERE site <> ''`).all()) {
      addDatacenter.run(site);
      link.run(findDatacenter.get(site).id, site);
    }
    db.exec('ALTER TABLE prefixes DROP COLUMN site');
  },

  // 2: which customer account each PTR belongs to, so they can all be removed when the account is deleted.
  // No foreign key on purpose: the row has to outlive the login until Cloudflare confirms the removal.
  (db) => {
    db.exec(`
      ALTER TABLE rdns_records ADD COLUMN account_id INTEGER;
      CREATE INDEX rdns_account ON rdns_records (account_id);
      UPDATE rdns_records SET account_id = (
        SELECT COALESCE(u.parent_id, u.id) FROM users u WHERE u.email = rdns_records.updated_by AND u.role = 'customer'
      );
    `);
  },

  // 3: prefixes Fiberifi keeps for itself, as distinct from ones nobody has claimed yet.
  (db) => {
    db.exec('ALTER TABLE prefixes ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  },
];

export function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    transaction(db, () => {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
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
