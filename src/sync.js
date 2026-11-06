// Keeps a router's gateway addresses in step with the panel. Nothing here runs on its own: it works out the
// difference, and an admin reviews and applies it. These are the rules that keep a core router safe:
//   - Only ever touches addresses on the one configured interface. See opsFor.
//   - Only removes addresses the panel has seen a prefix for. Anything else on the router is left alone.
//   - Never touches a main range's address, and never adds an address the interface already has.
import { getSetting, setSetting } from './db.js';
import { contains, parseCidr, parseIp, toHex } from './lib/ip.js';
import { decryptSecret, encryptSecret } from './lib/security.js';
import { certificateFingerprint, createVyosClient, VyosError } from './lib/vyos.js';
import { ApiError, invalid } from './validate.js';

const MAX_CHANGES = 20;

function splitAddress(address) {
  const [ip, length] = String(address).split('/');
  try {
    const parsed = parseIp(ip);
    return length === undefined ? null : { ...parsed, ip, length: Number(length) };
  } catch {
    return null; // Not an address, such as 'dhcp'.
  }
}

export function createSync(db, config, ipam) {
  const makeClient = config.vyosClient ?? createVyosClient;

  function settings() {
    const stored = getSetting(db, 'sync_key');
    return {
      configured: Boolean(stored),
      url: getSetting(db, 'sync_url'),
      interface: getSetting(db, 'sync_interface', 'eth7'),
      datacenterId: Number(getSetting(db, 'sync_datacenter')) || null,
      fingerprint: getSetting(db, 'sync_fingerprint'),
      keyHint: stored ? `…${decryptSecret(stored, config.appSecret).slice(-4)}` : '',
    };
  }

  function saveSettings(input) {
    const previous = settings();
    let url;
    try {
      url = new URL(String(input.url ?? '').trim());
    } catch {
      throw invalid('Enter the router’s API address, like https://192.0.2.1', 'url');
    }
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && config.production)) {
      throw invalid('The API address must start with https://', 'url');
    }
    const iface = String(input.interface ?? '').trim();
    if (!/^[a-z]+[0-9]+(\.[0-9]+)?$/.test(iface)) throw invalid('Enter an interface name, like eth7', 'interface');
    const datacenterId = Number(input.datacenterId);
    if (!db.prepare('SELECT 1 FROM datacenters WHERE id = ?').get(datacenterId)) throw invalid('Choose the datacenter this router serves', 'datacenterId');
    const key = String(input.key ?? '').trim();
    if (!key && !previous.configured) throw invalid('Enter the API key', 'key');

    setSetting(db, 'sync_url', url.origin);
    setSetting(db, 'sync_interface', iface);
    setSetting(db, 'sync_datacenter', datacenterId);
    if (key) setSetting(db, 'sync_key', encryptSecret(key, config.appSecret));
    // A different address is a different router, so its certificate has to be accepted again.
    if (url.origin !== previous.url) setSetting(db, 'sync_fingerprint', '');
    return settings();
  }

  function clearKey() {
    db.prepare(`DELETE FROM settings WHERE key IN ('sync_key', 'sync_fingerprint')`).run();
  }

  function client() {
    const s = settings();
    if (!s.configured) throw new ApiError(409, 'sync_not_configured', 'Add the router’s API details first');
    return makeClient({ url: s.url, key: decryptSecret(getSetting(db, 'sync_key'), config.appSecret), fingerprint: s.fingerprint });
  }

  async function guarded(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof VyosError) throw new ApiError(502, 'router_error', error.message);
      throw error;
    }
  }

  // Reading the certificate here is what pins it, so this has to be run before anything can be applied.
  async function testConnection() {
    const s = settings();
    if (!s.configured) throw new ApiError(409, 'sync_not_configured', 'Add the router’s API details first');
    return guarded(async () => {
      const fingerprint = config.vyosClient ? 'test' : await certificateFingerprint(s.url);
      if (!s.fingerprint) setSetting(db, 'sync_fingerprint', fingerprint);
      const addresses = await client().addresses(s.interface);
      return { addresses, fingerprint: getSetting(db, 'sync_fingerprint') };
    });
  }

  // What should be on the interface, according to the panel.
  function wanted(s) {
    const result = new Map();
    const noDatacenter = [];
    for (const p of ipam.listPrefixes()) {
      const owned = p.customer || p.internal;
      if (!owned || p.parentId === null || p.family !== 4 || !p.gateway) continue;
      if (!p.datacenter) {
        noDatacenter.push(p.cidr);
        continue;
      }
      if (p.datacenter.id !== s.datacenterId) continue;
      const owner = p.internal ? 'Fiberifi' : p.customer.company || p.customer.name;
      result.set(`${p.gateway}/${p.length}`, { cidr: p.cidr, owner });
    }
    return { result, noDatacenter };
  }

  function isMainRange(address) {
    const parsed = splitAddress(address);
    if (!parsed) return true;
    return ipam
      .listPrefixes()
      .filter((p) => p.parentId === null)
      .some((p) => {
        const main = parseCidr(p.cidr);
        return main.family === parsed.family && main.length === parsed.length && contains(main, parsed.value);
      });
  }

  async function plan() {
    const s = settings();
    const actual = await guarded(() => client().addresses(s.interface));
    const { result: desired, noDatacenter } = wanted(s);
    const onRouter = new Set(actual);
    const ips = new Map(actual.map((address) => [splitAddress(address)?.ip, address]));
    const adopt = db.prepare('INSERT OR REPLACE INTO router_addresses (address, label, cidr) VALUES (?, ?, ?)');
    const known = () => new Map(db.prepare('SELECT * FROM router_addresses').all().map((row) => [row.address, row]));

    const changes = [];
    const conflicts = [];
    for (const [address, info] of desired) {
      if (onRouter.has(address)) {
        adopt.run(address, info.owner, info.cidr);
        continue;
      }
      const existing = ips.get(address.split('/')[0]);
      // A subnet at the start of a main range shares that range's IP. Linux keeps the two independently,
      // so this is safe, and removing the smaller one later leaves the main range alone.
      const sharesMainRange = existing && isMainRange(existing);
      if (existing && !sharesMainRange) conflicts.push({ address, cidr: info.cidr, existing });
      else changes.push({ id: `add:${address}`, op: 'add', address, cidr: info.cidr, owner: info.owner, note: sharesMainRange ? `Shares its IP with ${existing}` : '' });
    }

    const remembered = known();
    const unknown = [];
    for (const address of actual) {
      if (desired.has(address) || isMainRange(address)) continue;
      const row = remembered.get(address);
      if (row) changes.push({ id: `remove:${address}`, op: 'remove', address, cidr: row.cidr, owner: row.label });
      else if (splitAddress(address)) unknown.push(address);
    }

    // Removed by hand on the router, so there is nothing left to track.
    for (const address of remembered.keys()) {
      if (!onRouter.has(address) && !desired.has(address)) db.prepare('DELETE FROM router_addresses WHERE address = ?').run(address);
    }

    const sorted = changes
      .sort((a, b) => toHex(parseIp(a.address.split('/')[0]).value).localeCompare(toHex(parseIp(b.address.split('/')[0]).value)))
      .map((c) => ({ ...c, command: commandFor(c, s.interface) }));

    // A deleted change stays deleted only while it would otherwise be offered. Once the panel and the
    // router agree again it is forgotten, so the same address can come up fresh later.
    const dismissed = new Set(db.prepare('SELECT change_id FROM router_dismissed').all().map((row) => row.change_id));
    for (const id of dismissed) {
      if (!sorted.some((c) => c.id === id)) db.prepare('DELETE FROM router_dismissed WHERE change_id = ?').run(id);
    }
    return {
      interface: s.interface,
      addresses: actual,
      changes: sorted.filter((c) => !dismissed.has(c.id)),
      dismissed: sorted.filter((c) => dismissed.has(c.id)),
      conflicts,
      unknown,
      noDatacenter,
    };
  }

  function commandFor(change, iface) {
    return `${change.op === 'add' ? 'set' : 'delete'} interfaces ethernet ${iface} address ${change.address}`;
  }

  // The only place that builds router config, and the only shape it can produce.
  function opsFor(changes, iface) {
    return changes.map((change) => ({
      op: change.op === 'add' ? 'set' : 'delete',
      path: ['interfaces', 'ethernet', iface, 'address', change.address],
    }));
  }

  async function apply(ids) {
    if (!Array.isArray(ids) || !ids.length) throw invalid('Choose at least one change');
    if (ids.length > MAX_CHANGES) throw invalid(`Apply at most ${MAX_CHANGES} changes at a time`);
    const s = settings();
    if (!s.fingerprint) throw new ApiError(409, 'not_tested', 'Test the connection first');

    // Worked out again from the router right now, so a stale page can only apply what is still true.
    const current = await plan();
    const byId = new Map(current.changes.map((change) => [change.id, change]));
    const chosen = ids.map((id) => byId.get(id));
    if (chosen.some((change) => !change)) throw new ApiError(409, 'plan_changed', 'The router or the panel has changed. Review the list again.');

    return guarded(async () => {
      const router = client();
      await router.configure(opsFor(chosen, s.interface));
      const after = new Set(await router.addresses(s.interface));
      const wrong = chosen.filter((change) => after.has(change.address) !== (change.op === 'add'));
      if (wrong.length) throw new VyosError(`The router accepted the change, but ${wrong[0].address} is not as expected. It was not saved, so check the router.`);
      await router.save();
      for (const change of chosen) {
        if (change.op === 'add') db.prepare('INSERT OR REPLACE INTO router_addresses (address, label, cidr) VALUES (?, ?, ?)').run(change.address, change.owner, change.cidr);
        else db.prepare('DELETE FROM router_addresses WHERE address = ?').run(change.address);
      }
      return chosen;
    });
  }

  async function dismiss(id) {
    const current = await plan();
    const change = current.changes.find((c) => c.id === id);
    if (!change) throw new ApiError(409, 'plan_changed', 'That change is no longer in the queue. Review the list again.');
    db.prepare('INSERT OR IGNORE INTO router_dismissed (change_id) VALUES (?)').run(id);
    return change;
  }

  function restore(id) {
    db.prepare('DELETE FROM router_dismissed WHERE change_id = ?').run(String(id));
  }

  return { settings, saveSettings, clearKey, testConnection, plan, apply, dismiss, restore };
}
