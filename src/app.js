import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createIpam } from './ipam.js';
import { CloudflareError } from './lib/cloudflare.js';
import { hashToken } from './lib/security.js';
import { createRdns } from './rdns.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { subnetRoutes } from './routes/subnets.js';
import { teamRoutes } from './routes/team.js';
import { createTeam } from './team.js';
import { ApiError } from './validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createApp(db, config) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      strictTransportSecurity: config.secureCookies,
    }),
  );

  const ctx = {
    db,
    config,
    ipam: createIpam(db),
    rdns: createRdns(db, config),
    team: createTeam(db),
    cookieName: config.secureCookies ? '__Host-noc_session' : 'noc_session',
    audit(req, action, target = '', detail = '') {
      db.prepare('INSERT INTO audit_log (actor_id, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
        req.user?.id ?? null,
        req.user?.email ?? req.auditActor ?? 'anonymous',
        action,
        String(target),
        typeof detail === 'string' ? detail : JSON.stringify(detail),
        req.ip ?? '',
      );
    },
  };

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // The session cookie is SameSite=Strict. This Origin check is a second, independent CSRF defence.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin) {
      const allowed = config.publicUrl ? new URL(config.publicUrl).host : req.get('host');
      if (new URL(origin).host !== allowed) throw new ApiError(403, 'bad_origin', 'Cross-site request refused');
    }
    next();
  });

  const findSession = db.prepare(
    `SELECT u.*, s.expires_at, o.name AS owner_name, o.company AS owner_company
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users o ON o.id = u.parent_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND COALESCE(o.disabled, 0) = 0`,
  );
  const extendSession = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');
  const sessionMs = config.sessionHours * 3600 * 1000;

  app.use('/api', (req, res, next) => {
    const token = readCookie(req, ctx.cookieName);
    if (token) {
      const tokenHash = hashToken(token);
      const user = findSession.get(tokenHash, Date.now());
      if (user) {
        req.user = user;
        req.tokenHash = tokenHash;
        // Sliding expiry, written at most every few minutes rather than on every request.
        if (user.expires_at - Date.now() < sessionMs - 5 * 60 * 1000) extendSession.run(Date.now() + sessionMs, tokenHash);
      }
    }
    next();
  });

  app.use('/api/auth', authRoutes(ctx));

  app.use('/api', (req, res, next) => {
    if (!req.user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    if (req.user.must_change_password) {
      throw new ApiError(403, 'password_change_required', 'Set a new password to continue');
    }
    next();
  });

  app.use('/api/subnets', subnetRoutes(ctx));
  app.use('/api/team', teamRoutes(ctx));
  app.use(
    '/api/admin',
    (req, res, next) => {
      if (req.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Admin access required');
      next();
    },
    adminRoutes(ctx),
  );

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));

  const fontsDir = (pkg) => path.join(root, 'node_modules', '@fontsource-variable', pkg, 'files');
  const staticOptions = { immutable: true, maxAge: '30d' };
  app.use('/fonts/inter', express.static(fontsDir('inter'), staticOptions));
  app.use('/fonts/mono', express.static(fontsDir('jetbrains-mono'), staticOptions));
  // Revalidated on every load (a cheap 304), so an upgrade reaches browsers straight away.
  app.use(express.static(path.join(root, 'public'), { index: false, maxAge: 0 }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(root, 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof CloudflareError) {
      console.error('Cloudflare:', error.message);
      // Admins need the real reason. Customers only need to know it is not their input.
      const message =
        req.user?.role === 'admin' ? error.message : 'The DNS update did not go through. Try again, or contact Fiberifi support.';
      return res.status(502).json({ error: { code: 'cloudflare_error', message } });
    }
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message, ...error.extra } });
    }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'invalid', message: 'That request could not be read' } });
    }
    console.error(error);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side' } });
  });

  return app;
}
