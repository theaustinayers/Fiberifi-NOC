// Shared by both roles. Customers are scoped to their own subnets by ipam.prefixForUser, admins see all.
import { Router } from 'express';
import { createLimiter } from '../lib/security.js';
import { ApiError, positiveInt, ptrHostname, text, toCsv } from '../validate.js';

export function subnetRoutes({ ipam, rdns, audit }) {
  const router = Router();
  const rdnsWrites = createLimiter({ windowMs: 60 * 1000, max: 60 });

  function guardRate(req) {
    if (!rdnsWrites.allow(req.user.id)) {
      throw new ApiError(429, 'rate_limited', 'Too many DNS changes in a short time. Wait a minute and try again.');
    }
  }

  router.get('/', (req, res) => {
    res.json({ subnets: ipam.customerPrefixes(req.user.id) });
  });

  router.get('/:id', (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    res.json({ subnet: ipam.serialize(row) });
  });

  router.get('/:id/addresses', (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    res.json(
      ipam.listAddresses(row, req.user, {
        page: positiveInt(req.query.page, 0),
        view: req.query.view === 'used' ? 'used' : 'all',
        search: text(req.query.q, { max: 100, label: 'Search' }),
      }),
    );
  });

  router.get('/:id/export.csv', (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    const rows = ipam
      .exportAddresses(row)
      .map((r) => [r.ip, r.hostname, r.status, r.mac, r.device, r.description, r.ptr ?? '']);
    res.type('text/csv');
    res.attachment(`${row.cidr.replace(/[/:]/g, '_')}.csv`);
    res.send(toCsv(['ip', 'hostname', 'status', 'mac', 'device', 'description', 'ptr'], rows));
  });

  router.put('/:id/addresses/:ip', (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    const ip = ipam.saveRecord(row, req.params.ip, req.body ?? {}, req.user);
    audit(req, 'address.save', ip.text);
    res.json({ ok: true });
  });

  router.delete('/:id/addresses/:ip', (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    const ip = ipam.deleteRecord(row, req.params.ip, req.user);
    audit(req, 'address.delete', ip.text);
    res.json({ ok: true });
  });

  router.put('/:id/rdns/:ip', async (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    const ip = ipam.editableAddress(row, req.params.ip, req.user);
    const hostname = ptrHostname(req.body?.hostname);
    guardRate(req);
    const result = await rdns.setPtr(ip, hostname, req.user);
    audit(req, 'rdns.set', ip.text, hostname);
    res.json(result);
  });

  router.delete('/:id/rdns/:ip', async (req, res) => {
    const row = ipam.prefixForUser(req.params.id, req.user);
    const ip = ipam.editableAddress(row, req.params.ip, req.user);
    guardRate(req);
    const removed = await rdns.removePtr(ip);
    audit(req, 'rdns.delete', ip.text, removed.hostname);
    res.json({ ok: true });
  });

  return router;
}
