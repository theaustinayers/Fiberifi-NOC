import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  let appSecret = env.APP_SECRET;
  if (production && (!appSecret || appSecret.length < 32)) {
    throw new Error('APP_SECRET must be set to at least 32 characters in production');
  }
  if (!appSecret) {
    const file = path.join(dataDir, 'dev-secret');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    appSecret = fs.readFileSync(file, 'utf8');
  }

  return {
    production,
    port: Number(env.PORT || 3100),
    host: env.HOST || (production ? '127.0.0.1' : '0.0.0.0'),
    dbPath: env.DB_PATH || path.join(dataDir, 'noc.db'),
    appSecret,
    publicUrl: env.PUBLIC_URL || '',
    trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : production ? 1 : 0,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : production,
    cloudflareApiBase: env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4',
    adminEmail: env.ADMIN_EMAIL || 'admin@fiberifi.com',
    adminPassword: env.ADMIN_PASSWORD || '',
    sessionHours: Number(env.SESSION_HOURS || 12),
  };
}
