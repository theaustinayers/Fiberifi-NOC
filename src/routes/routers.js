import { Router } from 'express';

export function routerRoutes({ monitor, audit }) {
  const router = Router();

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

  router.get('/:id/interfaces/:interfaceId/history', (req, res) => {
    res.json(monitor.interfaceHistory(req.params.id, req.params.interfaceId, req.query.range));
  });

  return router;
}
