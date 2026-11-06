import { Router } from 'express';
import { generatePassword, hashPassword } from '../lib/security.js';
import { ApiError, email as checkEmail, oneOf, positiveInt, requiredText, text, toCsv } from '../validate.js';

const USER_FIELDS = `id, role, parent_id, access, email, name, company, phone, notes, disabled, must_change_password, created_at, last_login_at`;

function ownerNote(prefix) {
  if (prefix.internal) return 'internal';
  return prefix.customer ? `to ${prefix.customer.company || prefix.customer.name}` : '';
}

export function adminRoutes({ db, ipam, rdns, team, audit }) {
  const router = Router();

  // ---- overview ----

  router.get('/overview', (req, res) => {
    const prefixes = ipam.listPrefixes();
    const count = (sql) => db.prepare(sql).get().n;
    res.json({
      stats: {
        prefixes: prefixes.length,
        assigned: prefixes.filter((p) => p.customer).length,
        customers: count(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND parent_id IS NULL`),
        addresses: count('SELECT COUNT(*) AS n FROM ip_records'),
        ptrRecords: count('SELECT COUNT(*) AS n FROM rdns_records'),
      },
      aggregates: prefixes.filter((p) => p.parentId === null),
      rdnsEnabled: rdns.enabled(),
      recent: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8').all(),
    });
  });

  router.get('/explore', (req, res) => res.json(ipam.explore(req.query.cidr, req.query.length, req.user)));

  router.get('/search', (req, res) => res.json(ipam.search(text(req.query.q, { max: 100, label: 'Search' }))));

  // ---- prefixes ----

  router.get('/prefixes', (req, res) => res.json({ prefixes: ipam.listPrefixes() }));

  router.get('/prefixes/export.csv', (req, res) => {
    const rows = ipam
      .listPrefixes()
      .map((p) => [p.cidr, p.status, p.internal ? 'Internal' : p.customer?.company || p.customer?.name || '', p.gateway ?? '', p.description, p.datacenter?.name ?? '', p.vlan ?? '']);
    res.type('text/csv');
    res.attachment('prefixes.csv');
    res.send(toCsv(['prefix', 'status', 'customer', 'gateway', 'description', 'datacenter', 'vlan'], rows));
  });

  router.post('/prefixes', (req, res) => {
    const prefix = ipam.createPrefix(req.body ?? {});
    audit(req, 'prefix.create', prefix.cidr);
    res.status(201).json({ prefix });
  });

  router.post('/prefixes/carve', (req, res) => {
    const prefix = ipam.carve(req.body ?? {});
    audit(req, 'prefix.create', prefix.cidr, ownerNote(prefix));
    res.status(201).json({ prefix });
  });

  router.get('/prefixes/:id', (req, res) => res.json({ prefix: ipam.getPrefix(req.params.id) }));

  router.patch('/prefixes/:id', (req, res) => {
    const before = ipam.requirePrefix(req.params.id).cidr;
    const prefix = ipam.updatePrefix(req.params.id, req.body ?? {});
    audit(req, 'prefix.update', prefix.cidr, before === prefix.cidr ? '' : `was ${before}`);
    res.json({ prefix });
  });

  router.delete('/prefixes/:id', async (req, res) => {
    const plan = ipam.planDelete(req.params.id, req.query.cascade === 'true');
    const { row } = plan;
    const ptr = plan.orphansRecords
      ? await rdns.removeRange(row.family, row.start_hex, row.end_hex)
      : { removed: 0, failed: [] };
    ipam.applyDelete(plan);
    audit(req, 'prefix.delete', row.cidr, { prefixes: plan.ids.length, ptrRemoved: ptr.removed, ptrFailed: ptr.failed });
    res.json({ ok: true, ptrRemoved: ptr.removed, ptrFailed: ptr.failed });
  });

  router.post('/prefixes/:id/assign', (req, res) => {
    const { prefix, customer } = ipam.assignPrefix(req.params.id, req.body ?? {});
    audit(req, 'prefix.assign', prefix.cidr, `to ${customer.company || customer.name}`);
    res.json({ prefix });
  });

  // Access is revoked first. Only then are the PTRs cleared, so a Cloudflare outage cannot delay a revocation.
  router.post('/prefixes/:id/unassign', async (req, res) => {
    const { previous, recordsRemoved, internal } = ipam.unassignPrefix(req.params.id);
    const ptr =
      internal || req.body?.removeRdns === false
        ? { removed: 0, failed: [] }
        : await rdns.removeRange(previous.family, previous.start_hex, previous.end_hex);
    audit(req, 'prefix.unassign', previous.cidr, {
      from: internal ? 'Internal' : previous.customer_name,
      recordsRemoved,
      ptrRemoved: ptr.removed,
      ptrFailed: ptr.failed,
    });
    res.json({ prefix: ipam.getPrefix(previous.id), recordsRemoved, ptrRemoved: ptr.removed, ptrFailed: ptr.failed });
  });

  router.get('/prefixes/:id/next-available', (req, res) => {
    res.json({ next: ipam.suggestNext(req.params.id, req.query.length) });
  });

  router.post('/prefixes/:id/allocate', (req, res) => {
    const prefix = ipam.allocate(req.params.id, req.body ?? {});
    audit(req, 'prefix.allocate', prefix.cidr, ownerNote(prefix));
    res.status(201).json({ prefix });
  });

  router.post('/prefixes/:id/split', (req, res) => {
    const prefix = ipam.split(req.params.id, req.body?.length);
    audit(req, 'prefix.split', prefix.cidr, `into /${req.body?.length}`);
    res.json({ prefix });
  });

  // ---- accounts ----

  function requireUser(id) {
    const user = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(Number(id));
    if (!user) throw new ApiError(404, 'not_found', 'That account does not exist');
    return user;
  }

  function assertNotLastAdmin(user) {
    if (user.role !== 'admin') return;
    const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?`).get(user.id).n;
    if (!others) throw new ApiError(409, 'last_admin', 'This is the only active admin account');
  }

  function profile(input) {
    return {
      name: requiredText(input.name, { max: 120, field: 'name', label: 'Name' }),
      company: text(input.company, { max: 120, field: 'company', label: 'Company' }),
      phone: text(input.phone, { max: 40, field: 'phone', label: 'Phone' }),
      notes: text(input.notes, { max: 1000, field: 'notes', label: 'Notes' }),
    };
  }

  function subnetCount(id) {
    return db.prepare('SELECT COUNT(*) AS n FROM prefixes WHERE customer_id = ?').get(id).n;
  }

  router.get('/users', (req, res) => {
    const users = db
      .prepare(
        `SELECT ${USER_FIELDS}, (SELECT COUNT(*) FROM prefixes p WHERE p.customer_id = users.id) AS subnets,
           (SELECT COUNT(*) FROM users m WHERE m.parent_id = users.id) AS members
         FROM users WHERE parent_id IS NULL ORDER BY role DESC, company, name`,
      )
      .all();
    res.json({ users });
  });

  router.post('/users', async (req, res) => {
    const input = req.body ?? {};
    const address = checkEmail(input.email);
    const fields = profile(input);
    const role = oneOf(input.role ?? 'customer', ['admin', 'customer'], 'role');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(address)) {
      throw new ApiError(409, 'duplicate', 'An account with that email already exists', { field: 'email' });
    }
    const temporaryPassword = generatePassword();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO users (role, email, name, company, phone, notes, password_hash, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(role, address, fields.name, fields.company, fields.phone, fields.notes, await hashPassword(temporaryPassword));
    audit(req, 'user.create', address, role);
    res.status(201).json({ user: requireUser(lastInsertRowid), temporaryPassword });
  });

  router.get('/users/:id', (req, res) => {
    const user = requireUser(req.params.id);
    const subnets = ipam.listPrefixes().filter((p) => p.customer?.id === user.id);
    const isAccount = user.role === 'customer' && !user.parent_id;
    res.json({
      user,
      subnets,
      members: isAccount ? team.list(user.id).members : [],
      owner: user.parent_id ? requireUser(user.parent_id) : null,
      ptrCount: isAccount ? rdns.countForAccount(user.id) : 0,
    });
  });

  router.post('/users/:id/members', async (req, res) => {
    const { member, temporaryPassword } = await team.add(Number(req.params.id), req.body ?? {});
    audit(req, 'team.add', member.email, member.access);
    res.status(201).json({ member, temporaryPassword });
  });

  router.patch('/users/:id', (req, res) => {
    const user = requireUser(req.params.id);
    const input = req.body ?? {};
    if (user.parent_id) {
      const member = team.update(user.parent_id, user.id, input);
      audit(req, 'team.update', member.email, { access: member.access, disabled: Boolean(member.disabled) });
      return res.json({ user: requireUser(user.id) });
    }
    const fields = profile({ ...user, ...input });
    const address = input.email === undefined ? user.email : checkEmail(input.email);
    const clash = db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(address, user.id);
    if (clash) throw new ApiError(409, 'duplicate', 'An account with that email already exists', { field: 'email' });

    const disabled = input.disabled === undefined ? user.disabled : input.disabled ? 1 : 0;
    if (disabled && !user.disabled) {
      if (user.id === req.user.id) throw new ApiError(409, 'self', 'You cannot disable your own account');
      assertNotLastAdmin(user);
      // Includes the account's team: they lose access along with it.
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id = ? OR parent_id = ?)').run(user.id, user.id);
    }
    db.prepare('UPDATE users SET email = ?, name = ?, company = ?, phone = ?, notes = ?, disabled = ? WHERE id = ?').run(
      address,
      fields.name,
      fields.company,
      fields.phone,
      fields.notes,
      disabled,
      user.id,
    );
    audit(req, disabled === user.disabled ? 'user.update' : disabled ? 'user.disable' : 'user.enable', address);
    res.json({ user: requireUser(user.id) });
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const user = requireUser(req.params.id);
    const temporaryPassword = generatePassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
      await hashPassword(temporaryPassword),
      user.id,
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit(req, 'user.reset_password', user.email);
    res.json({ temporaryPassword });
  });

  router.delete('/users/:id', async (req, res) => {
    const user = requireUser(req.params.id);
    if (user.id === req.user.id) throw new ApiError(409, 'self', 'You cannot delete your own account');
    assertNotLastAdmin(user);
    const subnets = subnetCount(user.id);
    if (subnets) throw new ApiError(409, 'has_subnets', `This account still has ${subnets === 1 ? '1 assigned subnet' : `${subnets} assigned subnets`}. Unassign ${subnets === 1 ? 'it' : 'them'} first.`);

    // Includes PTRs from the account's team. The account stays until Cloudflare confirms every removal,
    // because once it is gone nothing would tie the leftovers to anyone.
    const isAccount = user.role === 'customer' && !user.parent_id;
    const ptr = isAccount ? await rdns.removeForAccount(user.id) : { removed: 0, failed: [] };
    if (ptr.failed.length) {
      audit(req, 'user.delete_blocked', user.email, { ptrRemoved: ptr.removed, ptrFailed: ptr.failed });
      throw new ApiError(
        502,
        'ptr_removal_failed',
        `The account was not deleted because these PTR records could not be removed from Cloudflare: ${ptr.failed.slice(0, 5).join(', ')}. Try again.`,
      );
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    audit(req, 'user.delete', user.email, { ptrRemoved: ptr.removed });
    res.json({ ok: true, ptrRemoved: ptr.removed });
  });

  // ---- datacenters ----

  function requireDatacenter(id) {
    const datacenter = db.prepare('SELECT * FROM datacenters WHERE id = ?').get(Number(id));
    if (!datacenter) throw new ApiError(404, 'not_found', 'That datacenter does not exist');
    return datacenter;
  }

  function datacenterFields(input) {
    const name = requiredText(input.name, { max: 120, field: 'name', label: 'Name' });
    return {
      name,
      code: text(input.code, { max: 20, field: 'code', label: 'Code' }),
      address: text(input.address, { max: 300, field: 'address', label: 'Address' }),
      notes: text(input.notes, { max: 1000, field: 'notes', label: 'Notes' }),
    };
  }

  function assertDatacenterNameFree(name, ignoreId = 0) {
    if (db.prepare('SELECT 1 FROM datacenters WHERE name = ? AND id <> ?').get(name, ignoreId)) {
      throw new ApiError(409, 'duplicate', 'A datacenter with that name already exists', { field: 'name' });
    }
  }

  router.get('/datacenters', (req, res) => {
    const datacenters = db
      .prepare(
        `SELECT d.*, COUNT(p.id) AS prefixes, COUNT(p.customer_id) AS assigned
         FROM datacenters d LEFT JOIN prefixes p ON p.datacenter_id = d.id
         GROUP BY d.id ORDER BY d.name`,
      )
      .all();
    res.json({ datacenters });
  });

  router.post('/datacenters', (req, res) => {
    const fields = datacenterFields(req.body ?? {});
    assertDatacenterNameFree(fields.name);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO datacenters (name, code, address, notes) VALUES (?, ?, ?, ?)')
      .run(fields.name, fields.code, fields.address, fields.notes);
    audit(req, 'datacenter.create', fields.name);
    res.status(201).json({ datacenter: requireDatacenter(lastInsertRowid) });
  });

  router.get('/datacenters/:id', (req, res) => {
    const datacenter = requireDatacenter(req.params.id);
    res.json({ datacenter, prefixes: ipam.listPrefixes().filter((p) => p.datacenter?.id === datacenter.id) });
  });

  router.patch('/datacenters/:id', (req, res) => {
    const datacenter = requireDatacenter(req.params.id);
    const fields = datacenterFields({ ...datacenter, ...req.body });
    assertDatacenterNameFree(fields.name, datacenter.id);
    db.prepare('UPDATE datacenters SET name = ?, code = ?, address = ?, notes = ? WHERE id = ?').run(
      fields.name,
      fields.code,
      fields.address,
      fields.notes,
      datacenter.id,
    );
    audit(req, 'datacenter.update', fields.name);
    res.json({ datacenter: requireDatacenter(datacenter.id) });
  });

  router.delete('/datacenters/:id', (req, res) => {
    const datacenter = requireDatacenter(req.params.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM prefixes WHERE datacenter_id = ?').get(datacenter.id);
    if (n) throw new ApiError(409, 'in_use', `${n === 1 ? '1 prefix is' : `${n} prefixes are`} in this datacenter. Move ${n === 1 ? 'it' : 'them'} first.`);
    db.prepare('DELETE FROM datacenters WHERE id = ?').run(datacenter.id);
    audit(req, 'datacenter.delete', datacenter.name);
    res.json({ ok: true });
  });

  // ---- settings ----

  router.get('/settings', (req, res) => res.json({ cloudflare: rdns.getSettings() }));

  router.put('/settings', (req, res) => {
    const input = req.body ?? {};
    const cloudflare = rdns.saveSettings(input);
    // Records that it happened, never the value.
    audit(req, 'settings.update', 'cloudflare', { tokenChanged: Boolean(input.token) || Boolean(input.clearToken) });
    res.json({ cloudflare });
  });

  router.post('/settings/test-cloudflare', async (req, res) => res.json(await rdns.coverage()));

  router.post('/rdns/sync', async (req, res) => {
    const result = await rdns.sync(req.user);
    audit(req, 'rdns.sync', '', result);
    res.json(result);
  });

  // ---- audit ----

  router.get('/audit', (req, res) => {
    const page = positiveInt(req.query.page, 0);
    const pageSize = 50;
    const search = text(req.query.q, { max: 100, label: 'Search' });
    const where = search ? `WHERE actor LIKE ?1 OR action LIKE ?1 OR target LIKE ?1 OR detail LIKE ?1` : '';
    const args = search ? [`%${search.replace(/[%_]/g, '')}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...args).n;
    const entries = db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`)
      .all(...args);
    res.json({ entries, total, page, pageSize });
  });

  return router;
}
