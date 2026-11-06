// PTR management through Cloudflare. Cloudflare is the source of truth, rdns_records is our index of it.
import { getSetting, setSetting, transaction } from './db.js';
import { accountIdOf } from './ipam.js';
import { CloudflareClient } from './lib/cloudflare.js';
import { formatIp, ipFromPtr, parseCidr, ptrName, reverseZonesFor, toHex } from './lib/ip.js';
import { decryptSecret, encryptSecret } from './lib/security.js';
import { ApiError, invalid } from './validate.js';

const ZONE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TTL = 3600;

export function createRdns(db, config) {
  let zoneCache = null;

  function tokenSet() {
    return Boolean(getSetting(db, 'cf_token'));
  }

  function client() {
    const stored = getSetting(db, 'cf_token');
    if (!stored) throw new ApiError(503, 'rdns_not_configured', 'Reverse DNS is not set up yet. Add a Cloudflare API token in Settings.');
    return new CloudflareClient({
      token: decryptSecret(stored, config.appSecret),
      accountId: getSetting(db, 'cf_account_id'),
      baseUrl: config.cloudflareApiBase,
    });
  }

  function ttl() {
    return Number(getSetting(db, 'rdns_ttl', DEFAULT_TTL));
  }

  async function zones({ refresh = false } = {}) {
    if (!refresh && zoneCache && zoneCache.expires > Date.now()) return zoneCache.zones;
    const list = await client().listReverseZones();
    zoneCache = { zones: list, expires: Date.now() + ZONE_CACHE_MS };
    return list;
  }

  function match(list, name) {
    return list
      .filter((zone) => name === zone.name || name.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
  }

  async function zoneFor(name) {
    const found = match(await zones(), name) ?? match(await zones({ refresh: true }), name);
    if (!found) {
      throw new ApiError(409, 'no_zone', `Cloudflare has no reverse zone covering ${name}. Add the zone, then try again.`);
    }
    return found;
  }

  async function setPtr(ip, hostname, user) {
    const cf = client();
    const name = ptrName(ip.family, ip.value);
    const zone = await zoneFor(name);
    const body = { name, content: hostname, ttl: ttl(), comment: `noc.fiberifi.com user ${user.id}` };

    const [existing, ...duplicates] = await cf.findPtr(zone.id, name);
    const record = existing ? await cf.updatePtr(zone.id, existing.id, body) : await cf.createPtr(zone.id, body);
    // The panel shows one PTR per address, so what is live has to match what the customer sees.
    for (const extra of duplicates) await cf.deleteRecord(zone.id, extra.id);

    db.prepare(
      `INSERT INTO rdns_records (family, ip_hex, ip, ptr_name, hostname, zone_id, zone_name, record_id, ttl, updated_by, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (family, ip_hex) DO UPDATE SET hostname = excluded.hostname, zone_id = excluded.zone_id,
         zone_name = excluded.zone_name, record_id = excluded.record_id, ttl = excluded.ttl,
         updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         account_id = COALESCE(excluded.account_id, rdns_records.account_id)`,
    ).run(
      ip.family,
      ip.hex,
      ip.text,
      name,
      hostname,
      zone.id,
      zone.name,
      record.id,
      body.ttl,
      user.email,
      // An admin fixing a customer's PTR does not change whose it is.
      user.role === 'customer' ? accountIdOf(user) : null,
    );
    return { ip: ip.text, ptr: name, hostname, ttl: body.ttl };
  }

  async function removePtr(ip) {
    const row = db.prepare('SELECT * FROM rdns_records WHERE family = ? AND ip_hex = ?').get(ip.family, ip.hex);
    if (!row) throw new ApiError(404, 'not_found', `${ip.text} has no PTR record`);
    await client().deleteRecord(row.zone_id, row.record_id);
    db.prepare('DELETE FROM rdns_records WHERE id = ?').run(row.id);
    return row;
  }

  // Best effort by design: losing Cloudflare must not stop an admin revoking a subnet.
  // Anything that fails stays in rdns_records and is reported, so it can be retried from the prefix page.
  function removeRange(family, startHex, endHex) {
    return removeRows(
      db.prepare('SELECT * FROM rdns_records WHERE family = ? AND ip_hex BETWEEN ? AND ?').all(family, startHex, endHex),
    );
  }

  function countForAccount(accountId) {
    return db.prepare('SELECT COUNT(*) AS n FROM rdns_records WHERE account_id = ?').get(accountId).n;
  }

  function removeForAccount(accountId) {
    return removeRows(db.prepare('SELECT * FROM rdns_records WHERE account_id = ?').all(accountId));
  }

  async function removeRows(rows) {
    const result = { removed: 0, failed: [] };
    if (!rows.length) return result;
    if (!tokenSet()) return { removed: 0, failed: rows.map((row) => row.ip) };
    const cf = client();
    for (const row of rows) {
      try {
        await cf.deleteRecord(row.zone_id, row.record_id);
        db.prepare('DELETE FROM rdns_records WHERE id = ?').run(row.id);
        result.removed += 1;
      } catch {
        result.failed.push(row.ip);
      }
    }
    return result;
  }

  // Pulls PTRs that already exist in Cloudflare into the panel and drops ones that have gone.
  // Only addresses inside a known prefix are indexed.
  async function sync(user) {
    const cf = client();
    const list = await zones({ refresh: true });
    const seen = [];
    for (const zone of list) {
      for (const record of await cf.listPtr(zone.id)) {
        const ip = ipFromPtr(record.name);
        if (!ip) continue;
        const hex = toHex(ip.value);
        const managed = db
          .prepare('SELECT 1 FROM prefixes WHERE family = ? AND start_hex <= ? AND end_hex >= ? LIMIT 1')
          .get(ip.family, hex, hex);
        if (managed) seen.push({ ...ip, hex, record, zone });
      }
    }

    return transaction(db, () => {
      const known = db.prepare('SELECT id, family, ip_hex, zone_id FROM rdns_records').all();
      const live = new Set(seen.map((s) => `${s.family}:${s.hex}`));
      const zoneIds = new Set(list.map((zone) => zone.id));
      let removed = 0;
      for (const row of known) {
        if (zoneIds.has(row.zone_id) && !live.has(`${row.family}:${row.ip_hex}`)) {
          db.prepare('DELETE FROM rdns_records WHERE id = ?').run(row.id);
          removed += 1;
        }
      }
      const upsert = db.prepare(
        `INSERT INTO rdns_records (family, ip_hex, ip, ptr_name, hostname, zone_id, zone_name, record_id, ttl, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (family, ip_hex) DO UPDATE SET hostname = excluded.hostname, zone_id = excluded.zone_id,
           zone_name = excluded.zone_name, record_id = excluded.record_id, ttl = excluded.ttl`,
      );
      for (const s of seen) {
        const hostname = s.record.content.replace(/\.$/, '').toLowerCase();
        upsert.run(s.family, s.hex, formatIp(s.family, s.value), s.record.name, hostname, s.zone.id, s.zone.name, s.record.id, s.record.ttl, user.email);
      }
      return { zones: list.length, records: seen.length, removed };
    });
  }

  // Which reverse zones each top-level prefix needs, and whether Cloudflare has them.
  async function coverage() {
    const list = await zones({ refresh: true });
    const rows = db.prepare('SELECT cidr FROM prefixes ORDER BY family, start_hex, length').all();
    const tops = [];
    for (const row of rows) {
      const p = parseCidr(row.cidr);
      if (!tops.some((t) => t.family === p.family && p.network >= t.network && p.last <= t.last)) tops.push(p);
    }
    return {
      zones: list,
      prefixes: tops.map((p) => ({
        cidr: p.cidr,
        zones: reverseZonesFor(p).map((name) => {
          const found = match(list, name);
          return { name, found: found?.name ?? null };
        }),
      })),
    };
  }

  function getSettings() {
    const stored = getSetting(db, 'cf_token');
    return {
      configured: Boolean(stored),
      tokenHint: stored ? `…${decryptSecret(stored, config.appSecret).slice(-4)}` : '',
      accountId: getSetting(db, 'cf_account_id'),
      ttl: ttl(),
    };
  }

  function saveSettings({ token, accountId, ttl: newTtl, clearToken }) {
    if (newTtl !== undefined) {
      const n = Number(newTtl);
      if (!Number.isInteger(n) || (n !== 1 && (n < 60 || n > 86400))) {
        throw invalid('TTL must be 1 (automatic) or from 60 to 86400 seconds', 'ttl');
      }
      setSetting(db, 'rdns_ttl', n);
    }
    if (accountId !== undefined) {
      const id = String(accountId).trim();
      if (id && !/^[0-9a-f]{32}$/i.test(id)) throw invalid('Account ID should be 32 hexadecimal characters', 'accountId');
      setSetting(db, 'cf_account_id', id);
    }
    if (clearToken) {
      db.prepare(`DELETE FROM settings WHERE key = 'cf_token'`).run();
    } else if (token) {
      const value = String(token).trim();
      if (!/^[\w-]{20,}$/.test(value)) throw invalid('That does not look like a Cloudflare API token', 'token');
      setSetting(db, 'cf_token', encryptSecret(value, config.appSecret));
    }
    zoneCache = null;
    return getSettings();
  }

  return { enabled: tokenSet, setPtr, removePtr, removeRange, countForAccount, removeForAccount, sync, coverage, getSettings, saveSettings };
}
