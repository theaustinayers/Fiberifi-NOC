import { Router } from 'express';
import { createLimiter, verifyPassword } from '../lib/security.js';
import { ApiError } from '../validate.js';

export function routerRoutes({ monitor, sync, audit }) {
  const router = Router();
  const applyAttempts = createLimiter({ windowMs: 60 * 1000, max: 5 });

  router.get('/sync/settings', (req, res) => {
    const { fingerprint, ...settings } = sync.settings();
    res.json({ settings: { ...settings, fingerprint: Boolean(fingerprint) } });
  });

  router.put('/sync/settings', (req, res) => {
    sync.saveSettings(req.body ?? {});
    audit(req, 'settings.update', 'router-api', { keyChanged: Boolean(req.body?.key) });
    res.json({ ok: true });
  });

  router.post('/sync/test', async (req, res) => {
    const { addresses } = await sync.testConnection();
    audit(req, 'router.sync_test', sync.settings().url);
    res.json({ addresses });
  });

  router.get('/sync/plan', async (req, res) => res.json(await sync.plan()));

  // Changes a live core router, so it asks for the password again even in a signed-in session.
  router.post('/sync/apply', async (req, res) => {
    if (!applyAttempts.allow(req.user.id)) throw new ApiError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.');
    if (!(await verifyPassword(String(req.body?.password ?? ''), req.user.password_hash))) {
      audit(req, 'router.sync_refused', '', 'wrong password');
      throw new ApiError(403, 'bad_password', 'That password is not correct', { field: 'password' });
    }
    try {
      const applied = await sync.apply(req.body?.ids);
      audit(req, 'router.sync_apply', sync.settings().interface, applied.map((change) => `${change.op} ${change.address}`).join(', '));
      res.json({ applied: applied.length });
    } catch (error) {
      audit(req, 'router.sync_failed', sync.settings().interface, error.message);
      throw error;
    }
  });

  router.get('/settings', (req, res) => res.json({ snmp: monitor.getSettings() }));

  router.put('/settings', (req, res) => {
    const snmp = monitor.saveSettings(req.body ?? {});
    // Records that it happened, never the value.
    audit(req, 'settings.update', 'snmp', { passwordChanged: Boolean(req.body?.authPassword) });
    res.json({ snmp });
  });

  router.get('/', (req, res) => res.json({ routers: monitor.listRouters(), snmp: monitor.getSettings() }));

  router.post('/', async (req, res) => {
    const created = monitor.createRouter(req.body ?? {});
    audit(req, 'router.create', created.name, created.host);
    // Polled straight away, so the new router does not sit at Unknown until the next cycle.
    if (monitor.getSettings().configured) await monitor.pollRouter(created);
    res.status(201).json({ router: monitor.routerDetail(created.id) });
  });

  router.get('/:id', (req, res) => res.json({ router: monitor.routerDetail(req.params.id) }));

  router.patch('/:id', (req, res) => {
    const updated = monitor.updateRouter(req.params.id, req.body ?? {});
    audit(req, 'router.update', updated.name);
    res.json({ router: monitor.routerDetail(updated.id) });
  });

  router.delete('/:id', (req, res) => {
    const removed = monitor.deleteRouter(req.params.id);
    audit(req, 'router.delete', removed.name);
    res.json({ ok: true });
  });

  router.post('/:id/poll', async (req, res) => {
    await monitor.pollRouter(monitor.requireRouter(req.params.id));
    res.json({ router: monitor.routerDetail(req.params.id) });
  });

  router.get('/:id/history', (req, res) => res.json(monitor.routerHistory(req.params.id, req.query.range)));

  router.get('/:id/bgp/:sessionId/events', (req, res) => res.json({ events: monitor.bgpEvents(req.params.id, req.params.sessionId) }));

  router.patch('/:id/bgp/:sessionId', (req, res) => {
    const session = monitor.labelSession(req.params.id, req.params.sessionId, req.body ?? {});
    audit(req, 'bgp.label', session.peer_ip);
    res.json({ ok: true });
  });

  router.get('/:id/live', async (req, res) => res.json(await monitor.liveSample(req.params.id)));

  router.get('/:id/interfaces/:interfaceId/history', (req, res) => {
    res.json(monitor.interfaceHistory(req.params.id, req.params.interfaceId, req.query.range));
  });

  return router;
}
