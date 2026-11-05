// Prints a one-time password for an admin account. Used by the installer, and to recover from a lockout:
//   sudo noc-reset-admin admin@fiberifi.com
import path from 'node:path';
import { openDatabase } from './db.js';
import { generatePassword, hashPassword } from './lib/security.js';

const email = process.argv[2];
const dbPath = process.env.DB_PATH || path.join(path.resolve(process.env.DATA_DIR || 'data'), 'noc.db');
const db = openDatabase(dbPath);

const admins = db.prepare(`SELECT id, email FROM users WHERE role = 'admin' ORDER BY id`).all();
const user = email ? admins.find((a) => a.email.toLowerCase() === email.toLowerCase()) : admins[0];
if (!user) {
  console.error(email ? `No admin account has the email ${email}` : 'There are no admin accounts yet. Start the service first.');
  process.exit(1);
}

const password = generatePassword();
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, disabled = 0 WHERE id = ?').run(await hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
db.prepare(`INSERT INTO audit_log (actor, action, target) VALUES ('console', 'user.reset_password', ?)`).run(user.email);
db.close();

console.log(`Email:    ${user.email}`);
console.log(`Password: ${password}`);
