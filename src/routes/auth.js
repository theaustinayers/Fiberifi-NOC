import { Router } from 'express';
import { accountIdOf, canEdit, canManageTeam } from '../ipam.js';
import {
  createLimiter,
  DUMMY_HASH,
  hashPassword,
  hashToken,
  newSessionToken,
  verifyPassword,
} from '../lib/security.js';
import { ApiError, password as checkPassword } from '../validate.js';

export function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    company: user.company,
    accountId: accountIdOf(user),
    accountName: user.owner_company || user.owner_name || user.company || '',
    isMember: Boolean(user.parent_id),
    canEdit: canEdit(user),
    canManageTeam: canManageTeam(user),
    mustChangePassword: Boolean(user.must_change_password),
  };
}

export function authRoutes({ db, config, audit, cookieName, rdns }) {
  const router = Router();
  const perAccount = createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const perAddress = createLimiter({ windowMs: 15 * 60 * 1000, max: 40 });
  const sessionMs = config.sessionHours * 3600 * 1000;
  const cookie = { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/' };

  function requireUser(req) {
    if (!req.user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return req.user;
  }

  router.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const secret = String(req.body?.password ?? '');
    const accountKey = `${req.ip}|${email}`;
    if (!perAccount.allow(accountKey) || !perAddress.allow(req.ip)) {
      throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Wait 15 minutes and try again.');
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const matches = await verifyPassword(secret, user?.password_hash ?? DUMMY_HASH);
    const owner = user?.parent_id ? db.prepare('SELECT disabled FROM users WHERE id = ?').get(user.parent_id) : null;
    if (!user || !matches || user.disabled || owner?.disabled) {
      req.auditActor = email.slice(0, 254) || 'anonymous';
      audit(req, 'auth.login_failed');
      throw new ApiError(401, 'bad_credentials', 'That email and password do not match');
    }

    perAccount.reset(accountKey);
    const token = newSessionToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      hashToken(token),
      user.id,
      Date.now() + sessionMs,
    );
    db.prepare(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(user.id);
    req.user = user;
    audit(req, 'auth.login');
    res.cookie(cookieName, token, { ...cookie, maxAge: sessionMs });
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    if (req.tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    res.clearCookie(cookieName, cookie);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const user = requireUser(req);
    res.json({ user: publicUser(user), rdnsEnabled: rdns.enabled() });
  });

  router.post('/change-password', async (req, res) => {
    const user = requireUser(req);
    if (!(await verifyPassword(String(req.body?.currentPassword ?? ''), user.password_hash))) {
      throw new ApiError(400, 'invalid', 'Your current password is not correct', { field: 'currentPassword' });
    }
    const next = checkPassword(req.body?.newPassword, 'newPassword');
    if (next === req.body?.currentPassword) {
      throw new ApiError(400, 'invalid', 'Choose a password you have not just used', { field: 'newPassword' });
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(next), user.id);
    // Any other device signed in with the old password loses access.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, req.tokenHash);
    audit(req, 'auth.password_changed');
    res.json({ user: publicUser({ ...user, must_change_password: 0 }) });
  });

  return router;
}
