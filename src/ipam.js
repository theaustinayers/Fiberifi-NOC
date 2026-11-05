// Prefix tree, assignments and address records. Every rule that protects customer data lives here,
// not in the routes, so the admin and customer APIs cannot drift apart.
import { transaction } from './db.js';
import {
  BITS,
  contains,
  formatIp,
  freeBlocks,
  fromHex,
  IpError,
  makePrefix,
  netmask,
  nextAvailable,
  parseCidr,
  parseIp,
  prefixSize,
  reverseZonesFor,
  sizeLabel,
  subnetRoles,
  toHex,
} from './lib/ip.js';
import { ApiError, invalid, mac, oneOf, text, vlan } from './validate.js';

export const PREFIX_STATUSES = ['container', 'active', 'reserved', 'deprecated'];
export const RECORD_STATUSES = ['in_use', 'reserved', 'dhcp'];
const PAGE_SIZE = 256;
const MAX_SPLIT = 256;

const SELECT_PREFIX = `
  SELECT p.*, u.name AS customer_name, u.company AS customer_company, u.email AS customer_email
  FROM prefixes p LEFT JOIN users u ON u.id = p.customer_id`;

function bounds(row) {
  return { family: row.family, length: row.length, network: fromHex(row.start_hex), last: fromHex(row.end_hex) };
}

function rolesOf(row) {
  if (row.status === 'container') return { network: null, gateway: null, broadcast: null };
  const gateway = row.gateway ? parseIp(row.gateway).value : null;
  return subnetRoles({ ...bounds(row), gateway });
}

// Network and broadcast are never editable. The gateway belongs to Fiberifi: admins can document it, customers cannot.
export function isLocked(role, user) {
  if (role === 'network' || role === 'broadcast') return true;
  return role === 'gateway' && user.role !== 'admin';
}

function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function asApiError(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof IpError) throw invalid(error.message, 'cidr');
    throw error;
  }
}

export function createIpam(db) {
  const q = {
    byId: db.prepare(`${SELECT_PREFIX} WHERE p.id = ?`),
    all: db.prepare(`${SELECT_PREFIX} ORDER BY p.family, p.start_hex, p.length`),
    byCustomer: db.prepare(`${SELECT_PREFIX} WHERE p.customer_id = ? ORDER BY p.family, p.start_hex`),
    covering: db.prepare(
      'SELECT * FROM prefixes WHERE family = ? AND start_hex <= ? AND end_hex >= ? ORDER BY length DESC',
    ),
    within: db.prepare(
      'SELECT * FROM prefixes WHERE family = ? AND start_hex >= ? AND end_hex <= ? ORDER BY start_hex, length',
    ),
    overlapping: db.prepare('SELECT * FROM prefixes WHERE family = ? AND start_hex <= ? AND end_hex >= ?'),
    assignedOverlap: db.prepare(
      `SELECT cidr FROM prefixes
       WHERE family = ? AND customer_id IS NOT NULL AND id <> ? AND start_hex <= ? AND end_hex >= ? LIMIT 1`,
    ),
    countRecords: db.prepare('SELECT COUNT(*) AS n FROM ip_records WHERE family = ? AND ip_hex BETWEEN ? AND ?'),
    countRdns: db.prepare('SELECT COUNT(*) AS n FROM rdns_records WHERE family = ? AND ip_hex BETWEEN ? AND ?'),
    customer: db.prepare(`SELECT id, name, company, disabled FROM users WHERE id = ? AND role = 'customer'`),
  };

  function requirePrefix(id) {
    const row = q.byId.get(Number(id));
    if (!row) throw new ApiError(404, 'not_found', 'That prefix does not exist');
    return row;
  }

  // Customers get a 404, not a 403, so subnet ids cannot be probed.
  function prefixForUser(id, user) {
    const row = q.byId.get(Number(id));
    if (!row || (user.role !== 'admin' && row.customer_id !== user.id)) {
      throw new ApiError(404, 'not_found', 'That subnet does not exist');
    }
    return row;
  }

  // CIDRs either nest or do not touch, so sorted rows plus a stack gives the tree in one pass.
  function tree(rows) {
    const stack = [];
    for (const row of rows) {
      while (stack.length) {
        const top = stack.at(-1);
        if (top.family === row.family && top.end_hex >= row.end_hex) break;
        stack.pop();
      }
      row.parent_id = stack.at(-1)?.id ?? null;
      row.depth = stack.length;
      stack.push(row);
    }
    return rows;
  }

  function directChildren(row) {
    const inside = q.within.all(row.family, row.start_hex, row.end_hex).filter((r) => r.id !== row.id);
    const children = [];
    let reach = '';
    for (const r of inside) {
      if (r.start_hex > reach) {
        children.push(r);
        reach = r.end_hex;
      }
    }
    return children;
  }

  function counts(row) {
    return {
      records: q.countRecords.get(row.family, row.start_hex, row.end_hex).n,
      rdns: q.countRdns.get(row.family, row.start_hex, row.end_hex).n,
    };
  }

  function usableCount(row) {
    const roles = Object.values(rolesOf(row)).filter((v) => v !== null).length;
    return prefixSize(row.family, row.length) - BigInt(roles);
  }

  function utilization(row, children, recordCount) {
    const size = prefixSize(row.family, row.length);
    if (children.length) {
      const used = children.reduce((sum, c) => sum + prefixSize(c.family, c.length), 0n);
      // Six decimals: one /48 in a /32 is 0.0015%, which must not round down to an empty prefix.
      return { pct: Number((used * 100000000n) / size) / 1000000, basis: 'prefixes' };
    }
    if (row.family === 4) {
      const usable = usableCount(row);
      const pct = usable > 0n ? Number((BigInt(recordCount) * 10000n) / usable) / 100 : 0;
      return { pct, basis: 'addresses' };
    }
    return { pct: null, basis: 'addresses' };
  }

  function serialize(row, childRows = directChildren(row)) {
    const b = bounds(row);
    const roles = rolesOf(row);
    const { records, rdns } = counts(row);
    const fmt = (v) => (v === null ? null : formatIp(row.family, v));
    return {
      id: row.id,
      cidr: row.cidr,
      family: row.family,
      length: row.length,
      status: row.status,
      description: row.description,
      site: row.site,
      vlan: row.vlan,
      parentId: row.parent_id ?? null,
      depth: row.depth ?? 0,
      customer: row.customer_id
        ? { id: row.customer_id, name: row.customer_name, company: row.customer_company, email: row.customer_email }
        : null,
      assignedAt: row.assigned_at,
      firstAddress: fmt(b.network),
      lastAddress: fmt(b.last),
      netmask: row.family === 4 ? netmask(row.length) : null,
      network: fmt(roles.network),
      gateway: fmt(roles.gateway),
      gatewayOverride: row.gateway,
      broadcast: fmt(roles.broadcast),
      size: sizeLabel(row.family, row.length),
      usable: row.family === 4 ? usableCount(row).toLocaleString('en-US') : sizeLabel(row.family, row.length),
      reverseZones: reverseZonesFor(b, 8),
      childCount: childRows.length,
      recordCount: records,
      rdnsCount: rdns,
      utilization: utilization(row, childRows, records),
    };
  }

  function listPrefixes() {
    const rows = tree(q.all.all());
    const childrenOf = new Map();
    for (const row of rows) {
      if (row.parent_id === null) continue;
      if (!childrenOf.has(row.parent_id)) childrenOf.set(row.parent_id, []);
      childrenOf.get(row.parent_id).push(row);
    }
    return rows.map((row) => serialize(row, childrenOf.get(row.id) ?? []));
  }

  function withTreePosition(row) {
    const ancestors = q.covering.all(row.family, row.start_hex, row.end_hex).filter((r) => r.id !== row.id);
    return { ...row, parent_id: ancestors[0]?.id ?? null, depth: ancestors.length };
  }

  function getPrefix(id) {
    const row = withTreePosition(requirePrefix(id));
    const children = directChildren(row);
    const ancestors = q.covering.all(row.family, row.start_hex, row.end_hex).filter((r) => r.id !== row.id).reverse();
    const childRows = children.map((c) => serialize(q.byId.get(c.id)));
    const free = freeBlocks(
      bounds(row),
      children.map((c) => bounds(c)),
    );
    return {
      ...serialize(row, children),
      ancestors: ancestors.map((a) => ({ id: a.id, cidr: a.cidr })),
      children: childRows.map((c, i) => ({
        ...c,
        startOffsetPct: offsetPct(row, children[i]),
        widthPct: widthPct(row, children[i]),
      })),
      free: free.slice(0, 64).map((f) => ({ cidr: f.cidr, size: sizeLabel(f.family, f.length), length: f.length })),
      freeTruncated: free.length > 64,
    };
  }

  function offsetPct(parent, child) {
    const span = prefixSize(parent.family, parent.length);
    return Number(((fromHex(child.start_hex) - fromHex(parent.start_hex)) * 100000n) / span) / 1000;
  }

  function widthPct(parent, child) {
    const span = prefixSize(parent.family, parent.length);
    return Number((prefixSize(child.family, child.length) * 100000n) / span) / 1000;
  }

  function assertNoAssignedOverlap(family, id, startHex, endHex) {
    const clash = q.assignedOverlap.get(family, id, endHex, startHex);
    if (clash) {
      throw new ApiError(409, 'assignment_overlap', `This overlaps ${clash.cidr}, which is already assigned to a customer`);
    }
  }

  function cleanGateway(value, row) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    const b = bounds(row);
    let ip;
    try {
      ip = parseIp(s);
    } catch (error) {
      throw invalid(error.message, 'gateway');
    }
    if (ip.family !== row.family || !contains(b, ip.value)) throw invalid(`The gateway must be inside ${row.cidr}`, 'gateway');
    const defaults = subnetRoles(b);
    if (BITS[row.family] === row.length) throw invalid('A single address has no gateway', 'gateway');
    if (ip.value === defaults.network || ip.value === defaults.broadcast) {
      throw invalid('The gateway cannot be the network or broadcast address', 'gateway');
    }
    return formatIp(ip.family, ip.value);
  }

  function requireCustomer(id) {
    const customer = q.customer.get(Number(id));
    if (!customer) throw invalid('Choose a customer', 'customerId');
    if (customer.disabled) throw invalid('That customer account is disabled', 'customerId');
    return customer;
  }

  function insertPrefix(p, fields) {
    const result = db
      .prepare(
        `INSERT INTO prefixes (family, cidr, length, start_hex, end_hex, status, description, site, vlan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.family,
        p.cidr,
        p.length,
        toHex(p.network),
        toHex(p.last),
        fields.status,
        fields.description,
        fields.site,
        fields.vlan,
      );
    return Number(result.lastInsertRowid);
  }

  function prefixFields(input) {
    return {
      description: text(input.description, { max: 200, field: 'description', label: 'Description' }),
      site: text(input.site, { max: 80, field: 'site', label: 'Site' }),
      vlan: vlan(input.vlan),
    };
  }

  function assertUnique(cidr, ignoreId = 0) {
    const existing = db.prepare('SELECT id FROM prefixes WHERE cidr = ? AND id <> ?').get(cidr, ignoreId);
    if (existing) throw new ApiError(409, 'duplicate', `${cidr} already exists`, { field: 'cidr' });
  }

  function createPrefix(input) {
    const p = asApiError(() => parseCidr(input.cidr));
    assertUnique(p.cidr);
    const fields = prefixFields(input);
    const hasParent = q.covering.all(p.family, toHex(p.network), toHex(p.last)).length > 0;
    const status = input.status ? oneOf(input.status, PREFIX_STATUSES, 'status') : hasParent ? 'active' : 'container';
    return getPrefix(insertPrefix(p, { ...fields, status }));
  }

  function updatePrefix(id, input) {
    const row = requirePrefix(id);
    const fields = prefixFields({ ...row, ...input });
    const status = input.status === undefined ? row.status : oneOf(input.status, PREFIX_STATUSES, 'status');
    if (row.customer_id && status === 'container') {
      throw invalid('An assigned subnet cannot be a container', 'status');
    }

    let next = bounds(row);
    let cidr = row.cidr;
    if (input.cidr !== undefined) {
      const p = asApiError(() => parseCidr(input.cidr));
      if (p.cidr !== row.cidr) {
        if (p.family !== row.family) throw invalid('A prefix cannot change address family', 'cidr');
        assertUnique(p.cidr, row.id);
        assertResizable(row, p);
        next = p;
        cidr = p.cidr;
      }
    }

    const moved = { ...row, cidr, length: next.length, start_hex: toHex(next.network), end_hex: toHex(next.last) };
    let gateway = input.gateway === undefined ? row.gateway : cleanGateway(input.gateway, moved);
    if (gateway && input.gateway === undefined && !contains(next, parseIp(gateway).value)) gateway = null;

    db.prepare(
      `UPDATE prefixes SET cidr = ?, length = ?, start_hex = ?, end_hex = ?, status = ?, description = ?, site = ?,
       vlan = ?, gateway = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(cidr, moved.length, moved.start_hex, moved.end_hex, status, fields.description, fields.site, fields.vlan, gateway, row.id);
    return getPrefix(row.id);
  }

  // A resize must not strand anything: child prefixes, address records and PTRs all have to stay inside it.
  function assertResizable(row, p) {
    const start = toHex(p.network);
    const end = toHex(p.last);
    const stranded = q.within
      .all(row.family, row.start_hex, row.end_hex)
      .filter((r) => r.id !== row.id && (r.start_hex < start || r.end_hex > end));
    if (stranded.length) {
      throw new ApiError(409, 'resize_blocked', `${stranded[0].cidr} would fall outside ${p.cidr}. Move or delete it first.`, {
        field: 'cidr',
      });
    }
    const outside = (table) =>
      db
        .prepare(`SELECT ip FROM ${table} WHERE family = ? AND ip_hex BETWEEN ? AND ? AND (ip_hex < ? OR ip_hex > ?) LIMIT 1`)
        .get(row.family, row.start_hex, row.end_hex, start, end);
    const record = outside('ip_records') ?? outside('rdns_records');
    if (record) {
      throw new ApiError(409, 'resize_blocked', `${record.ip} has records and would fall outside ${p.cidr}. Remove them first.`, {
        field: 'cidr',
      });
    }
    if (row.customer_id) assertNoAssignedOverlap(row.family, row.id, start, end);
  }

  function assignPrefix(id, { customerId, gateway }) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      const customer = requireCustomer(customerId);
      if (row.customer_id && row.customer_id !== customer.id) {
        throw new ApiError(409, 'already_assigned', `${row.cidr} is assigned to ${row.customer_name}. Unassign it first.`);
      }
      assertNoAssignedOverlap(row.family, row.id, row.start_hex, row.end_hex);
      const active = { ...row, status: row.status === 'container' ? 'active' : row.status };
      db.prepare(
        `UPDATE prefixes SET customer_id = ?, gateway = ?, status = ?,
         assigned_at = COALESCE(assigned_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(customer.id, cleanGateway(gateway, active), active.status, row.id);
      return { prefix: getPrefix(row.id), customer };
    });
  }

  // The outgoing customer's notes must never be visible to whoever gets the subnet next.
  function unassignPrefix(id) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      if (!row.customer_id) throw new ApiError(409, 'not_assigned', `${row.cidr} is not assigned`);
      const { changes } = db
        .prepare('DELETE FROM ip_records WHERE family = ? AND ip_hex BETWEEN ? AND ?')
        .run(row.family, row.start_hex, row.end_hex);
      db.prepare(
        `UPDATE prefixes SET customer_id = NULL, assigned_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(row.id);
      return { previous: row, recordsRemoved: Number(changes) };
    });
  }

  function checkChildLength(row, length) {
    const n = Number(length);
    if (!Number.isInteger(n) || n <= row.length || n > BITS[row.family]) {
      throw invalid(`Choose a length from /${row.length + 1} to /${BITS[row.family]}`, 'length');
    }
    return n;
  }

  function suggestNext(id, length) {
    const row = requirePrefix(id);
    const n = checkChildLength(row, length);
    const next = nextAvailable(bounds(row), directChildren(row).map(bounds), n);
    return next ? { cidr: next.cidr, size: sizeLabel(next.family, next.length) } : null;
  }

  function allocate(id, input) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      const n = checkChildLength(row, input.length);
      const next = nextAvailable(bounds(row), directChildren(row).map(bounds), n);
      if (!next) throw new ApiError(409, 'no_space', `No free /${n} left in ${row.cidr}`, { field: 'length' });
      const fields = prefixFields(input);
      const status = input.status ? oneOf(input.status, PREFIX_STATUSES, 'status') : 'active';
      const customerId = input.customerId ? requireCustomer(input.customerId).id : null;
      if (customerId) assertNoAssignedOverlap(next.family, 0, toHex(next.network), toHex(next.last));
      const newId = insertPrefix(next, { ...fields, status: customerId && status === 'container' ? 'active' : status });
      if (customerId) {
        db.prepare(
          `UPDATE prefixes SET customer_id = ?, assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(customerId, newId);
      }
      return getPrefix(newId);
    });
  }

  function split(id, length) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      const n = checkChildLength(row, length);
      if (row.customer_id) throw new ApiError(409, 'assigned', 'Unassign this subnet before splitting it');
      if (directChildren(row).length) {
        throw new ApiError(409, 'has_children', 'This prefix already has child prefixes. Allocate from its free space instead.');
      }
      const count = 1 << Math.min(n - row.length, 30);
      if (count > MAX_SPLIT) throw invalid(`That would create ${count.toLocaleString('en-US')} prefixes. The limit is ${MAX_SPLIT}.`, 'length');
      const stride = prefixSize(row.family, n);
      const start = fromHex(row.start_hex);
      for (let i = 0n; i < BigInt(count); i += 1n) {
        insertPrefix(makePrefix(row.family, start + i * stride, n), { status: 'active', description: '', site: row.site, vlan: null });
      }
      db.prepare(`UPDATE prefixes SET status = 'container', gateway = NULL WHERE id = ?`).run(row.id);
      return getPrefix(row.id);
    });
  }

  // Works out what a delete would do, without doing it, so the caller can clear Cloudflare first.
  function planDelete(id, cascade) {
    const row = requirePrefix(id);
    const inside = q.within.all(row.family, row.start_hex, row.end_hex);
    const assigned = inside.find((r) => r.customer_id);
    if (assigned) {
      throw new ApiError(409, 'assigned', `${assigned.cidr} is assigned to a customer. Unassign it first.`);
    }
    const descendants = inside.filter((r) => r.id !== row.id);
    if (descendants.length && !cascade) {
      throw new ApiError(409, 'has_children', `${row.cidr} contains ${descendants.length} child prefixes`, {
        children: descendants.length,
      });
    }
    const hasAncestor = q.covering.all(row.family, row.start_hex, row.end_hex).some((r) => r.id !== row.id);
    return { row, ids: inside.map((r) => r.id), orphansRecords: !hasAncestor };
  }

  function applyDelete({ row, ids, orphansRecords }) {
    transaction(db, () => {
      const remove = db.prepare('DELETE FROM prefixes WHERE id = ?');
      for (const id of ids) remove.run(id);
      if (orphansRecords) {
        db.prepare('DELETE FROM ip_records WHERE family = ? AND ip_hex BETWEEN ? AND ?').run(
          row.family,
          row.start_hex,
          row.end_hex,
        );
      }
    });
  }

  function rolesInRange(row) {
    const map = new Map();
    for (const r of q.overlapping.all(row.family, row.end_hex, row.start_hex)) {
      if (r.status === 'container') continue;
      for (const [role, value] of Object.entries(rolesOf(r))) {
        if (value !== null) map.set(toHex(value), role);
      }
    }
    return map;
  }

  function roleAt(family, value) {
    const hex = toHex(value);
    for (const r of q.covering.all(family, hex, hex)) {
      if (r.status === 'container') continue;
      for (const [role, roleValue] of Object.entries(rolesOf(r))) {
        if (roleValue === value) return role;
      }
    }
    return null;
  }

  function listAddresses(row, user, { page = 0, view = 'all', search = '' }) {
    const b = bounds(row);
    const roles = rolesInRange(row);
    const records = db.prepare('SELECT * FROM ip_records WHERE family = ? AND ip_hex = ?');
    const rdns = db.prepare('SELECT hostname, ttl, updated_at FROM rdns_records WHERE family = ? AND ip_hex = ?');

    const toRow = (hex) => {
      const value = fromHex(hex);
      const role = roles.get(hex) ?? null;
      const record = records.get(row.family, hex);
      const ptr = rdns.get(row.family, hex);
      return {
        ip: formatIp(row.family, value),
        role,
        locked: isLocked(role, user),
        record: record
          ? {
              hostname: record.hostname,
              mac: record.mac,
              device: record.device,
              description: record.description,
              status: record.status,
              updatedBy: user.role === 'admin' ? record.updated_by : undefined,
              updatedAt: record.updated_at,
            }
          : null,
        rdns: ptr ? { hostname: ptr.hostname, ttl: ptr.ttl, updatedAt: ptr.updated_at } : null,
      };
    };

    const dense = row.family === 4 && view !== 'used' && !search;
    if (dense) {
      const total = prefixSize(4, row.length);
      const offset = BigInt(page) * BigInt(PAGE_SIZE);
      const rows = [];
      for (let i = offset; i < total && i < offset + BigInt(PAGE_SIZE); i += 1n) rows.push(toRow(toHex(b.network + i)));
      return { rows, page, pageSize: PAGE_SIZE, total: Number(total), dense };
    }

    const args = [row.family, row.start_hex, row.end_hex];
    const pattern = search ? likePattern(search) : '%';
    const used = `
      SELECT ip_hex FROM ip_records WHERE family = ? AND ip_hex BETWEEN ? AND ?
        AND (ip LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
             OR mac LIKE ? ESCAPE '\\' OR device LIKE ? ESCAPE '\\')
      UNION
      SELECT ip_hex FROM rdns_records WHERE family = ? AND ip_hex BETWEEN ? AND ?
        AND (ip LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\')`;
    const params = [...args, pattern, pattern, pattern, pattern, pattern, ...args, pattern, pattern];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${used})`).get(...params).n;
    const hexes = db
      .prepare(`${used} ORDER BY ip_hex LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, page * PAGE_SIZE)
      .map((r) => r.ip_hex);

    // Pinned first so the greyed-out rows are visible in sparse IPv6 views too.
    if (page === 0 && !search) {
      const own = Object.values(rolesOf(row)).filter((v) => v !== null).map(toHex);
      for (const hex of own.reverse()) if (!hexes.includes(hex)) hexes.unshift(hex);
      hexes.sort();
    }
    return { rows: hexes.map(toRow), page, pageSize: PAGE_SIZE, total, dense };
  }

  // Resolves an address inside a subnet and refuses it if this user may not touch it.
  function editableAddress(row, ipText, user) {
    let ip;
    try {
      ip = parseIp(ipText);
    } catch (error) {
      throw invalid(error.message, 'ip');
    }
    if (ip.family !== row.family || !contains(bounds(row), ip.value)) {
      throw invalid(`${ipText} is not inside ${row.cidr}`, 'ip');
    }
    const role = roleAt(ip.family, ip.value);
    if (isLocked(role, user)) {
      throw new ApiError(403, 'locked', `The ${role} address is managed by Fiberifi and cannot be changed`);
    }
    return { ...ip, text: formatIp(ip.family, ip.value), hex: toHex(ip.value) };
  }

  function saveRecord(row, ipText, input, user) {
    const ip = editableAddress(row, ipText, user);
    const fields = {
      hostname: text(input.hostname, { max: 253, field: 'hostname', label: 'Hostname' }),
      mac: mac(input.mac),
      device: text(input.device, { max: 120, field: 'device', label: 'Device' }),
      description: text(input.description, { max: 200, field: 'description', label: 'Description' }),
      status: oneOf(input.status || 'in_use', RECORD_STATUSES, 'status'),
    };
    db.prepare(
      `INSERT INTO ip_records (family, ip_hex, ip, hostname, mac, device, description, status, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (family, ip_hex) DO UPDATE SET hostname = excluded.hostname, mac = excluded.mac,
         device = excluded.device, description = excluded.description, status = excluded.status,
         updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(ip.family, ip.hex, ip.text, fields.hostname, fields.mac, fields.device, fields.description, fields.status, user.email);
    return ip;
  }

  function deleteRecord(row, ipText, user) {
    const ip = editableAddress(row, ipText, user);
    db.prepare('DELETE FROM ip_records WHERE family = ? AND ip_hex = ?').run(ip.family, ip.hex);
    return ip;
  }

  function exportAddresses(row) {
    return db
      .prepare(
        `SELECT r.ip, r.hostname, r.status, r.mac, r.device, r.description, d.hostname AS ptr
         FROM ip_records r LEFT JOIN rdns_records d ON d.family = r.family AND d.ip_hex = r.ip_hex
         WHERE r.family = ? AND r.ip_hex BETWEEN ? AND ?
         UNION
         SELECT d.ip, '', '', '', '', '', d.hostname FROM rdns_records d
         WHERE d.family = ? AND d.ip_hex BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM ip_records r WHERE r.family = d.family AND r.ip_hex = d.ip_hex)`,
      )
      .all(row.family, row.start_hex, row.end_hex, row.family, row.start_hex, row.end_hex);
  }

  function search(term) {
    const s = String(term ?? '').trim();
    if (!s) return { prefixes: [], addresses: [], rdns: [], customers: [] };
    const pattern = likePattern(s);
    const prefixes = db
      .prepare(
        `${SELECT_PREFIX} WHERE p.cidr LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.site LIKE ? ESCAPE '\\'
         ORDER BY p.family, p.start_hex LIMIT 25`,
      )
      .all(pattern, pattern, pattern);

    // Typing an address also finds the prefixes it sits in, which a text match cannot do.
    let exact = null;
    try {
      exact = parseIp(s);
    } catch {
      /* not an address, the text match above is enough */
    }
    if (exact) {
      const hex = toHex(exact.value);
      for (const r of q.covering.all(exact.family, hex, hex)) {
        if (!prefixes.some((p) => p.id === r.id)) prefixes.push(q.byId.get(r.id));
      }
    }

    const owner = (family, hex) => q.covering.all(family, hex, hex)[0]?.id ?? null;
    const addresses = db
      .prepare(
        `SELECT family, ip_hex, ip, hostname, description, mac, device FROM ip_records
         WHERE ip LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
           OR mac LIKE ? ESCAPE '\\' OR device LIKE ? ESCAPE '\\' ORDER BY family, ip_hex LIMIT 25`,
      )
      .all(pattern, pattern, pattern, pattern, pattern)
      .map((r) => ({ ip: r.ip, hostname: r.hostname, description: r.description, prefixId: owner(r.family, r.ip_hex) }));
    const rdns = db
      .prepare(
        `SELECT family, ip_hex, ip, hostname FROM rdns_records
         WHERE ip LIKE ? ESCAPE '\\' OR hostname LIKE ? ESCAPE '\\' ORDER BY family, ip_hex LIMIT 25`,
      )
      .all(pattern, pattern)
      .map((r) => ({ ip: r.ip, hostname: r.hostname, prefixId: owner(r.family, r.ip_hex) }));
    const customers = db
      .prepare(
        `SELECT id, name, company, email FROM users WHERE role = 'customer'
         AND (name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') LIMIT 25`,
      )
      .all(pattern, pattern, pattern);

    return {
      prefixes: prefixes.map((p) => ({ id: p.id, cidr: p.cidr, description: p.description, customer: p.customer_name ?? null })),
      addresses,
      rdns,
      customers,
    };
  }

  return {
    requirePrefix,
    prefixForUser,
    listPrefixes,
    getPrefix,
    serialize,
    customerPrefixes: (userId) => q.byCustomer.all(userId).map((row) => withTreePosition(row)).map((row) => serialize(row)),
    createPrefix,
    updatePrefix,
    assignPrefix,
    unassignPrefix,
    suggestNext,
    allocate,
    split,
    planDelete,
    applyDelete,
    listAddresses,
    editableAddress,
    saveRecord,
    deleteRecord,
    exportAddresses,
    search,
  };
}
