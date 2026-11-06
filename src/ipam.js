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
const MAX_EXPLORE_BITS = 8; // 256 rows per level

const SELECT_PREFIX = `
  SELECT p.*, u.name AS customer_name, u.company AS customer_company, u.email AS customer_email,
    d.name AS datacenter_name, d.code AS datacenter_code
  FROM prefixes p
  LEFT JOIN users u ON u.id = p.customer_id
  LEFT JOIN datacenters d ON d.id = p.datacenter_id`;

function bounds(row) {
  return { family: row.family, length: row.length, network: fromHex(row.start_hex), last: fromHex(row.end_hex) };
}

// Every prefix has these, containers included. Which one applies to an address is decided by roleAt.
function rolesOf(row) {
  const gateway = row.gateway ? parseIp(row.gateway).value : null;
  return subnetRoles({ ...bounds(row), gateway });
}

// A sub-user acts on behalf of the customer account above them.
export function accountIdOf(user) {
  return user.parent_id ?? user.id;
}

export function canEdit(user) {
  return user.role === 'admin' || !user.parent_id || user.access === 'admin';
}

export function canManageTeam(user) {
  return user.role === 'customer' && canEdit(user);
}

// Reserved addresses are locked for customers. Admins can edit any row.
export function isLocked(role, user) {
  return Boolean(role) && user.role !== 'admin';
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
    withinFull: db.prepare(`${SELECT_PREFIX} WHERE p.family = ? AND p.start_hex >= ? AND p.end_hex <= ? ORDER BY p.start_hex, p.length`),
    within: db.prepare(
      'SELECT * FROM prefixes WHERE family = ? AND start_hex >= ? AND end_hex <= ? ORDER BY start_hex, length',
    ),
    overlapping: db.prepare('SELECT * FROM prefixes WHERE family = ? AND start_hex <= ? AND end_hex >= ?'),
    internalWithin: db.prepare(
      'SELECT cidr FROM prefixes WHERE family = ? AND internal = 1 AND id <> ? AND start_hex >= ? AND end_hex <= ? LIMIT 1',
    ),
    customerOverlap: db.prepare(
      `SELECT cidr FROM prefixes
       WHERE family = ? AND customer_id IS NOT NULL AND id <> ? AND start_hex <= ? AND end_hex >= ? LIMIT 1`,
    ),
    countRecords: db.prepare('SELECT COUNT(*) AS n FROM ip_records WHERE family = ? AND ip_hex BETWEEN ? AND ?'),
    countRdns: db.prepare('SELECT COUNT(*) AS n FROM rdns_records WHERE family = ? AND ip_hex BETWEEN ? AND ?'),
    customer: db.prepare(`SELECT id, name, company, disabled FROM users WHERE id = ? AND role = 'customer' AND parent_id IS NULL`),
  };

  function requirePrefix(id) {
    const row = q.byId.get(Number(id));
    if (!row) throw new ApiError(404, 'not_found', 'That prefix does not exist');
    return row;
  }

  // Customers get a 404, not a 403, so subnet ids cannot be probed.
  function prefixForUser(id, user) {
    const row = q.byId.get(Number(id));
    if (!row || (user.role !== 'admin' && row.customer_id !== accountIdOf(user))) {
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
    const isLabel = !row.customer_id && q.covering.all(row.family, row.start_hex, row.end_hex).some((r) => r.customer_id);
    const roles = isLabel ? { network: null, gateway: null, broadcast: null } : rolesOf(row);
    const { records, rdns } = counts(row);
    const fmt = (v) => (v === null ? null : formatIp(row.family, v));
    return {
      id: row.id,
      cidr: row.cidr,
      family: row.family,
      length: row.length,
      status: row.status,
      description: row.description,
      datacenter: row.datacenter_id ? { id: row.datacenter_id, name: row.datacenter_name, code: row.datacenter_code } : null,
      vlan: row.vlan,
      parentId: row.parent_id ?? null,
      depth: row.depth ?? 0,
      internal: Boolean(row.internal),
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

  // Ownership works by the smallest assignment winning, so a customer can sit inside Fiberifi's own range.
  // Two things stay refused: sharing an address with another customer, and swallowing a smaller internal block.
  function assertNoAssignedOverlap(family, id, startHex, endHex) {
    const clash = q.customerOverlap.get(family, id, endHex, startHex);
    if (clash) {
      throw new ApiError(409, 'assignment_overlap', `This overlaps ${clash.cidr}, which is already assigned`);
    }
    const ours = q.internalWithin.get(family, id, startHex, endHex);
    if (ours) {
      throw new ApiError(409, 'assignment_overlap', `This contains ${ours.cidr}, which is marked as internal. Release it first.`);
    }
  }

  function assertNotInsideCustomer(family, id, startHex, endHex) {
    const owner = q.covering.all(family, startHex, endHex).find((r) => r.customer_id && r.id !== id);
    if (owner) {
      throw new ApiError(409, 'assignment_overlap', `This is inside ${owner.cidr}, which is assigned to a customer`);
    }
  }

  // Inserts a prefix and gives it to whoever input.customerId names: a customer, 'internal', or nobody.
  function claim(p, fields, input, wanted) {
    const start = toHex(p.network);
    const end = toHex(p.last);
    const internal = input.customerId === 'internal';
    const customerId = !internal && input.customerId ? requireCustomer(input.customerId).id : null;
    if (customerId) assertNoAssignedOverlap(p.family, 0, start, end);
    if (internal) assertNotInsideCustomer(p.family, 0, start, end);
    const owned = internal || customerId;
    const status = owned ? (wanted === 'container' ? 'active' : wanted) : statusFor(p, wanted);
    const newId = insertPrefix(p, { ...fields, status });
    if (customerId) {
      db.prepare(
        `UPDATE prefixes SET customer_id = ?, assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(customerId, newId);
    }
    if (internal) db.prepare('UPDATE prefixes SET internal = 1 WHERE id = ?').run(newId);
    return newId;
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
        `INSERT INTO prefixes (family, cidr, length, start_hex, end_hex, status, description, datacenter_id, vlan)
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
        fields.datacenter_id,
        fields.vlan,
      );
    return Number(result.lastInsertRowid);
  }

  function datacenterId(value) {
    if (value === null || value === undefined || value === '') return null;
    const found = db.prepare('SELECT id FROM datacenters WHERE id = ?').get(Number(value));
    if (!found) throw invalid('Choose a datacenter from the list', 'datacenterId');
    return found.id;
  }

  function prefixFields(input) {
    return {
      description: text(input.description, { max: 200, field: 'description', label: 'Description' }),
      datacenter_id: datacenterId('datacenterId' in input ? input.datacenterId : input.datacenter_id),
      vlan: vlan(input.vlan),
    };
  }

  function assertUnique(cidr, ignoreId = 0) {
    const existing = db.prepare('SELECT id FROM prefixes WHERE cidr = ? AND id <> ?').get(cidr, ignoreId);
    if (existing) throw new ApiError(409, 'duplicate', `${cidr} already exists`, { field: 'cidr' });
  }

  // Prefixes may nest freely, but one that overlaps an assigned subnet is only a label. If it were active,
  // its own network and gateway would lock addresses the customer is entitled to use.
  function statusFor(p, wanted) {
    const start = toHex(p.network);
    const end = toHex(p.last);
    return q.customerOverlap.get(p.family, 0, end, start) ? 'container' : wanted;
  }

  function createPrefix(input) {
    const p = asApiError(() => parseCidr(input.cidr));
    assertUnique(p.cidr);
    const fields = prefixFields(input);
    const hasParent = q.covering.all(p.family, toHex(p.network), toHex(p.last)).length > 0;
    const status = input.status ? oneOf(input.status, PREFIX_STATUSES, 'status') : hasParent ? 'active' : 'container';
    return getPrefix(insertPrefix(p, { ...fields, status: statusFor(p, status) }));
  }

  function updatePrefix(id, input) {
    const row = requirePrefix(id);
    const fields = prefixFields({ ...row, ...input });
    const status = input.status === undefined ? row.status : oneOf(input.status, PREFIX_STATUSES, 'status');
    if (row.customer_id && status === 'container') {
      throw invalid('An assigned subnet cannot be a container', 'status');
    }
    if (!row.customer_id && status !== 'container' && q.customerOverlap.get(row.family, row.id, row.end_hex, row.start_hex)) {
      throw invalid('A prefix that overlaps an assigned subnet has to stay a container', 'status');
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
      `UPDATE prefixes SET cidr = ?, length = ?, start_hex = ?, end_hex = ?, status = ?, description = ?, datacenter_id = ?,
       vlan = ?, gateway = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(cidr, moved.length, moved.start_hex, moved.end_hex, status, fields.description, fields.datacenter_id, fields.vlan, gateway, row.id);
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

  function markInternal(row, gateway) {
    if (row.customer_id) {
      throw new ApiError(409, 'already_assigned', `${row.cidr} is assigned to ${row.customer_name}. Unassign it first.`);
    }
    assertNotInsideCustomer(row.family, row.id, row.start_hex, row.end_hex);
    db.prepare(
      `UPDATE prefixes SET internal = 1, gateway = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(cleanGateway(gateway, row), row.id);
    return { prefix: getPrefix(row.id), customer: { company: 'Internal' } };
  }

  function assignPrefix(id, { customerId, gateway }) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      if (customerId === 'internal') return markInternal(row, gateway);
      const customer = requireCustomer(customerId);
      if (row.internal) {
        throw new ApiError(409, 'already_assigned', `${row.cidr} is marked as internal. Release it first.`);
      }
      if (row.customer_id && row.customer_id !== customer.id) {
        throw new ApiError(409, 'already_assigned', `${row.cidr} is assigned to ${row.customer_name}. Unassign it first.`);
      }
      assertNoAssignedOverlap(row.family, row.id, row.start_hex, row.end_hex);
      const active = { ...row, status: row.status === 'container' ? 'active' : row.status };
      const gatewayAddress = cleanGateway(gateway, active);
      db.prepare(
        `UPDATE prefixes SET customer_id = ?, gateway = ?, status = ?,
         assigned_at = COALESCE(assigned_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(customer.id, gatewayAddress, active.status, row.id);
      return { prefix: getPrefix(row.id), customer };
    });
  }

  // The outgoing customer's notes must never be visible to whoever gets the subnet next.
  function unassignPrefix(id) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      // Internal records and PTRs are Fiberifi's own, so releasing a block keeps them.
      if (row.internal) {
        db.prepare(`UPDATE prefixes SET internal = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(row.id);
        return { previous: row, recordsRemoved: 0, internal: true };
      }
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
    if (Number(length) === row.length) return { cidr: row.cidr, size: sizeLabel(row.family, row.length), whole: true };
    const n = checkChildLength(row, length);
    const next = nextAvailable(bounds(row), directChildren(row).map(bounds), n);
    return next ? { cidr: next.cidr, size: sizeLabel(next.family, next.length) } : null;
  }

  // Allocating a prefix at its own size means using the whole thing, so it is updated rather than subdivided.
  function useWhole(row, input) {
    const fields = prefixFields({
      ...row,
      datacenterId: input.datacenterId,
      description: input.description || row.description,
      vlan: input.vlan || row.vlan,
    });
    if (!fields.datacenter_id) throw invalid('Choose a datacenter', 'datacenterId');
    if (input.customerId) assignPrefix(row.id, { customerId: input.customerId, gateway: row.gateway });
    db.prepare(
      `UPDATE prefixes SET description = ?, datacenter_id = ?, vlan = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(fields.description, fields.datacenter_id, fields.vlan, row.id);
    return getPrefix(row.id);
  }

  function allocate(id, input) {
    const whole = requirePrefix(id);
    if (Number(input.length) === whole.length) return useWhole(whole, input);
    return transaction(db, () => {
      const row = requirePrefix(id);
      const n = checkChildLength(row, input.length);
      const next = nextAvailable(bounds(row), directChildren(row).map(bounds), n);
      if (!next) throw new ApiError(409, 'no_space', `No free /${n} left in ${row.cidr}`, { field: 'length' });
      const fields = prefixFields(input);
      if (!fields.datacenter_id) throw invalid('Choose a datacenter', 'datacenterId');
      const status = input.status ? oneOf(input.status, PREFIX_STATUSES, 'status') : 'active';
      return getPrefix(claim(next, fields, input, status));
    });
  }

  // Makes a real prefix out of any block, inside any prefix, and optionally assigns it.
  function carve(input) {
    return transaction(db, () => {
      const p = asApiError(() => parseCidr(input.cidr));
      const start = toHex(p.network);
      const end = toHex(p.last);
      assertUnique(p.cidr);
      if (!q.covering.all(p.family, start, end).length) throw invalid(`${p.cidr} is not inside any of your prefixes`, 'cidr');
      const fields = prefixFields(input);
      if (!fields.datacenter_id) throw invalid('Choose a datacenter', 'datacenterId');
      return getPrefix(claim(p, fields, input, 'active'));
    });
  }

  function split(id, length) {
    return transaction(db, () => {
      const row = requirePrefix(id);
      const n = checkChildLength(row, length);
      const count = 1 << Math.min(n - row.length, 30);
      if (count > MAX_SPLIT) throw invalid(`That would create ${count.toLocaleString('en-US')} prefixes. The limit is ${MAX_SPLIT}.`, 'length');
      const stride = prefixSize(row.family, n);
      const start = fromHex(row.start_hex);
      const exists = db.prepare('SELECT 1 FROM prefixes WHERE cidr = ?');
      for (let i = 0n; i < BigInt(count); i += 1n) {
        const block = makePrefix(row.family, start + i * stride, n);
        if (exists.get(block.cidr)) continue;
        insertPrefix(block, { status: statusFor(block, 'active'), description: '', datacenter_id: row.datacenter_id, vlan: null });
      }
      if (!row.customer_id) db.prepare(`UPDATE prefixes SET status = 'container', gateway = NULL WHERE id = ?`).run(row.id);
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
      for (const value of Object.values(rolesOf(r))) {
        if (value === null) continue;
        const role = roleAt(row.family, value);
        if (role) map.set(toHex(value), role);
      }
    }
    return map;
  }

  // The smallest prefix decides, so a /22's gateway cannot take the usable address of a /31 inside it.
  // A customer's subnet is the exception: anything nested in it is a label and reserves nothing.
  function roleAt(family, value) {
    const hex = toHex(value);
    const covering = q.covering.all(family, hex, hex);
    const deciding = covering.find((r) => r.customer_id) ?? covering[0];
    if (!deciding) return null;
    for (const [role, roleValue] of Object.entries(rolesOf(deciding))) {
      if (roleValue === value) return role;
    }
    return null;
  }

  function addressRowBuilder(row, user) {
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
    return toRow;
  }

  function defaultStep({ family, length }) {
    if (family === 4 && length < 24) return Math.min(24, length + 8);
    return Math.min(BITS[family], length + 4);
  }

  // One level of the drill-down. Blocks are computed from the live prefix table, so they need not exist as prefixes.
  function explore(cidrText, lengthValue, user) {
    const p = asApiError(() => parseCidr(cidrText));
    const start = toHex(p.network);
    const end = toHex(p.last);
    const bits = BITS[p.family];
    if (p.length === bits) throw invalid('A single address cannot be opened any further', 'cidr');
    const covering = q.covering.all(p.family, start, end);
    if (!covering.length) throw new ApiError(404, 'not_found', `${p.cidr} is not inside any of your prefixes`);

    const options = [];
    for (let n = p.length + 1; n <= Math.min(bits, p.length + MAX_EXPLORE_BITS); n += 1) options.push(n);
    const length = lengthValue === undefined || lengthValue === '' ? defaultStep(p) : Number(lengthValue);
    if (!options.includes(length)) throw invalid(`Choose a size from /${options[0]} to /${options.at(-1)}`, 'length');

    const nearby = q.withinFull.all(p.family, start, end);
    const ancestors = covering.map((r) => q.byId.get(r.id));
    const known = [...ancestors, ...nearby.filter((r) => !ancestors.some((a) => a.id === r.id))];
    const smallestCovering = (from, to) =>
      known.filter((r) => r.start_hex <= from && r.end_hex >= to).sort((a, b) => b.length - a.length);
    const customerOf = (r) => ({ id: r.customer_id, name: r.customer_name, company: r.customer_company });

    const size = prefixSize(p.family, length);
    const count = 1 << (length - p.length);
    const blocks = [];
    for (let i = 0; i < count; i += 1) blocks.push(makePrefix(p.family, p.network + BigInt(i) * size, length));

    if (length === bits) {
      const toRow = addressRowBuilder({ family: p.family, start_hex: start, end_hex: end }, user);
      const rows = blocks.map((block) => {
        const hex = toHex(block.network);
        const over = smallestCovering(hex, hex);
        const owner = over.find((r) => r.customer_id);
        return { ...toRow(hex), prefixId: over[0].id, customer: owner ? customerOf(owner) : null, internal: over.some((r) => r.internal) };
      });
      return { cidr: p.cidr, length, options, kind: 'addresses', rows };
    }

    const rows = blocks.map((block) => {
      const from = toHex(block.network);
      const to = toHex(block.last);
      const over = smallestCovering(from, to);
      const exact = over.find((r) => r.cidr === block.cidr);
      const owner = over.find((r) => r.customer_id);
      const within = known.filter((r) => r.start_hex >= from && r.end_hex <= to && r.length > length);
      const assignedWithin = within.filter((r) => r.customer_id);
      const ours = over.some((r) => r.internal);
      const oursWithin = within.some((r) => r.internal);
      const customersInside = [...new Map(assignedWithin.map((r) => [r.customer_id, customerOf(r)])).values()].slice(0, 3);
      const inUse = within.length > 0 || over.some((r) => r.status !== 'container');
      let state = 'free';
      if (owner) state = 'assigned';
      else if (assignedWithin.length) state = 'partial';
      else if (ours) state = 'internal';
      else if (oursWithin) state = 'partial';
      else if (inUse) state = 'inuse';
      return {
        cidr: block.cidr,
        length,
        state,
        prefixId: exact?.id ?? null,
        customer: owner ? customerOf(owner) : null,
        customersInside,
        internalInside: oursWithin,
        description: exact?.description ?? '',
        datacenter: over.find((r) => r.datacenter_name)?.datacenter_name ?? null,
        datacenterId: over.find((r) => r.datacenter_id)?.datacenter_id ?? null,
        vlan: exact?.vlan ?? null,
        records: q.countRecords.get(p.family, from, to).n,
        ptrs: q.countRdns.get(p.family, from, to).n,
      };
    });
    return { cidr: p.cidr, length, options, kind: 'blocks', rows };
  }

  function listAddresses(row, user, { page = 0, view = 'all', search = '' }) {
    const b = bounds(row);
    const toRow = addressRowBuilder(row, user);

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

  function assertCanEdit(user) {
    if (!canEdit(user)) throw new ApiError(403, 'read_only', 'You have read-only access to this account');
  }

  function resolveAddress(row, ipText) {
    let ip;
    try {
      ip = parseIp(ipText);
    } catch (error) {
      throw invalid(error.message, 'ip');
    }
    if (ip.family !== row.family || !contains(bounds(row), ip.value)) {
      throw invalid(`${ipText} is not inside ${row.cidr}`, 'ip');
    }
    return { ...ip, text: formatIp(ip.family, ip.value), hex: toHex(ip.value) };
  }

  // Resolves an address inside a subnet and refuses it if this user may not touch it.
  function editableAddress(row, ipText, user) {
    assertCanEdit(user);
    const ip = resolveAddress(row, ipText);
    const role = roleAt(ip.family, ip.value);
    if (isLocked(role, user)) {
      throw new ApiError(403, 'locked', `The ${role} address cannot be edited`);
    }
    return ip;
  }

  // Customers can only publish PTRs on usable addresses. Admins can also publish one on a gateway.
  // Nobody can on a network or broadcast address, but admins can clear one a sync brought in.
  function ptrAddress(row, ipText, user, { removing = false } = {}) {
    assertCanEdit(user);
    const ip = resolveAddress(row, ipText);
    const role = roleAt(ip.family, ip.value);
    const allowed = !role || (user.role === 'admin' && (role === 'gateway' || removing));
    if (!allowed) {
      throw new ApiError(403, 'locked', `PTR records cannot be set on the ${role} address.`);
    }
    return ip;
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
        `${SELECT_PREFIX} WHERE p.cidr LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\'
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
    carve,
    explore,
    split,
    planDelete,
    applyDelete,
    listAddresses,
    ptrAddress,
    saveRecord,
    deleteRecord,
    exportAddresses,
    search,
  };
}
