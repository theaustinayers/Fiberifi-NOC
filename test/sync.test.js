import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openDatabase, seed } from '../src/db.js';
import { createIpam } from '../src/ipam.js';
import { createVyosClient, VyosError } from '../src/lib/vyos.js';
import { createSync } from '../src/sync.js';

const SECRET = 'test-secret-test-secret-test-secret';

describe('router changes', () => {
  let db;
  let ipam;
  let sync;
  let router;
  let dc;
  let otherDc;
  let customer;
  let range;

  const fakeClient = () => ({
    addresses: async () => {
      router.reads += 1;
      if (router.fail) throw new VyosError('Could not reach the router: timed out');
      return [...router.addresses];
    },
    configure: async (ops) => {
      router.configured.push(ops);
      if (router.refuse) throw new VyosError('Commit failed');
      if (router.ignore) return;
      for (const { op, path } of ops) {
        const address = path.at(-1);
        if (op === 'set') router.addresses.add(address);
        else router.addresses.delete(address);
      }
    },
    save: async () => { router.saves += 1; },
  });
  const ids = (plan) => plan.changes.map((change) => change.id);

  before(async () => {
    db = openDatabase(':memory:');
    await seed(db, { adminEmail: 'a@b.example', adminPassword: 'x'.repeat(12), production: false }, () => {});
    ipam = createIpam(db);
    router = { addresses: new Set(['206.168.244.1/22', '149.112.89.1/24', '206.168.244.249/29']), configured: [], saves: 0, reads: 0 };
    sync = createSync(db, { appSecret: SECRET, vyosClient: fakeClient }, ipam);
    dc = Number(db.prepare(`INSERT INTO datacenters (name) VALUES ('PIT')`).run().lastInsertRowid);
    otherDc = Number(db.prepare(`INSERT INTO datacenters (name) VALUES ('NYC')`).run().lastInsertRowid);
    customer = Number(db.prepare(`INSERT INTO users (role, email, name, company, password_hash) VALUES ('customer', 'c@x.example', 'C', 'Acme', 'h')`).run().lastInsertRowid);
    range = ipam.listPrefixes().find((p) => p.cidr === '206.168.244.0/22');
  });
  after(() => db.close());

  test('nothing can be read or applied before it is set up', async () => {
    await assert.rejects(sync.plan(), { code: 'sync_not_configured' });
    assert.throws(() => sync.saveSettings({ url: 'nope', interface: 'eth7', datacenterId: dc, key: 'k' }), /API address/);
    assert.throws(() => sync.saveSettings({ url: 'https://192.0.2.1', interface: 'eth7; rm -rf', datacenterId: dc, key: 'k' }), /interface name/);
    assert.throws(() => sync.saveSettings({ url: 'https://192.0.2.1', interface: 'eth7', datacenterId: 999, key: 'k' }), /datacenter/);
  });

  test('the API key is encrypted and not readable back', () => {
    sync.saveSettings({ url: 'https://192.0.2.1', interface: 'eth7', datacenterId: dc, key: 'super-secret-api-key' });
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'sync_key'`).get().value;
    assert.ok(!stored.includes('super-secret-api-key'));
    assert.equal(sync.settings().keyHint, '…-key');
    assert.ok(!JSON.stringify(sync.settings()).includes('super-secret-api-key'));
  });

  test('applying needs a tested connection first', async () => {
    await assert.rejects(sync.apply(['add:1.2.3.4/29']), { code: 'not_tested' });
    await sync.testConnection();
    assert.equal(router.configured.length, 0, 'testing only reads');
  });

  test('a new customer subnet is offered as an add, with the exact command', async () => {
    ipam.carve({ cidr: '206.168.244.232/29', customerId: customer, datacenterId: dc });
    const plan = await sync.plan();
    assert.deepEqual(ids(plan), ['add:206.168.244.233/29']);
    assert.equal(plan.changes[0].owner, 'Acme');
    assert.equal(plan.changes[0].command, 'set interfaces ethernet eth7 address 206.168.244.233/29');
    assert.equal(router.configured.length, 0, 'nothing is sent by looking');
  });

  test('main range addresses are never offered, and an unknown address is left alone', async () => {
    const plan = await sync.plan();
    assert.deepEqual(plan.unknown, ['206.168.244.249/29']);
    assert.ok(!ids(plan).some((id) => id.includes('206.168.244.1/22') || id.includes('149.112.89.1/24')));
    assert.ok(!ids(plan).some((id) => id.startsWith('remove:')));
  });

  test('other datacenters, unassigned prefixes, labels and IPv6 are ignored', async () => {
    ipam.carve({ cidr: '206.168.245.0/29', customerId: customer, datacenterId: otherDc });
    ipam.carve({ cidr: '206.168.245.8/29', datacenterId: dc });
    ipam.carve({ cidr: '206.168.244.232/30', datacenterId: dc });
    ipam.carve({ cidr: '2607:9340:1::/48', customerId: customer, datacenterId: dc });
    assert.deepEqual(ids(await sync.plan()), ['add:206.168.244.233/29']);
  });

  test('internal subnets count, and a subnet with no datacenter is flagged', async () => {
    ipam.carve({ cidr: '206.168.245.16/29', customerId: 'internal', datacenterId: dc });
    db.prepare(`INSERT INTO prefixes (family, cidr, length, start_hex, end_hex, status, customer_id)
      SELECT family, '206.168.245.32/29', 29, '000000000000000000000000cea8f520', '000000000000000000000000cea8f527', 'active', ? FROM prefixes LIMIT 1`).run(customer);
    const plan = await sync.plan();
    assert.ok(ids(plan).includes('add:206.168.245.17/29'));
    assert.deepEqual(plan.noDatacenter, ['206.168.245.32/29']);
  });

  test('an IP already on the interface with another size is a conflict, not an add', async () => {
    router.addresses.add('206.168.245.41/24');
    ipam.carve({ cidr: '206.168.245.40/29', customerId: customer, datacenterId: dc });
    const plan = await sync.plan();
    assert.ok(!ids(plan).includes('add:206.168.245.41/29'));
    assert.deepEqual(plan.conflicts.map((c) => c.existing), ['206.168.245.41/24']);
    router.addresses.delete('206.168.245.41/24');
    const conflicting = ipam.listPrefixes().find((p) => p.cidr === '206.168.245.40/29');
    ipam.unassignPrefix(conflicting.id);
    ipam.applyDelete(ipam.planDelete(conflicting.id, false));
  });

  test('a subnet sharing a main range IP can be added, and removing it leaves the range alone', async () => {
    const carved = ipam.carve({ cidr: '206.168.244.0/27', customerId: customer, datacenterId: dc });
    const plan = await sync.plan();
    const change = plan.changes.find((c) => c.address === '206.168.244.1/27');
    assert.equal(change.op, 'add');
    assert.equal(change.note, 'Shares its IP with 206.168.244.1/22');
    assert.equal(plan.conflicts.length, 0);

    await sync.apply([change.id]);
    assert.ok(router.addresses.has('206.168.244.1/27'));
    assert.ok(router.addresses.has('206.168.244.1/22'));
    assert.ok(!ids(await sync.plan()).includes(change.id), 'already there, so it stops being offered');

    ipam.unassignPrefix(carved.id);
    const after = await sync.plan();
    assert.ok(ids(after).includes('remove:206.168.244.1/27'));
    assert.ok(!ids(after).includes('remove:206.168.244.1/22'));
    await sync.apply(['remove:206.168.244.1/27']);
    assert.ok(router.addresses.has('206.168.244.1/22'), 'the main range is untouched');
    ipam.applyDelete(ipam.planDelete(carved.id, false));
  });

  test('the first block of a main range works at any size', async () => {
    for (const [cidr, gateway] of [['206.168.244.0/30', '206.168.244.1/30'], ['206.168.244.0/26', '206.168.244.1/26'], ['206.168.244.0/25', '206.168.244.1/25'], ['149.112.89.0/28', '149.112.89.1/28'], ['149.112.89.0/25', '149.112.89.1/25']]) {
      const carved = ipam.carve({ cidr, customerId: customer, datacenterId: dc });
      const plan = await sync.plan();
      const change = plan.changes.find((c) => c.address === gateway);
      assert.ok(change, cidr);
      assert.equal(change.op, 'add', cidr);
      assert.match(change.note, /^Shares its IP with/, cidr);
      assert.equal(plan.conflicts.length, 0, cidr);
      ipam.unassignPrefix(carved.id);
      ipam.applyDelete(ipam.planDelete(carved.id, false));
    }
  });

  test('applying sends only address changes on the one interface, then saves', async () => {
    const savesBefore = router.saves;
    const applied = await sync.apply(['add:206.168.244.233/29', 'add:206.168.245.17/29']);
    assert.equal(applied.length, 2);
    assert.deepEqual(router.configured.at(-1), [
      { op: 'set', path: ['interfaces', 'ethernet', 'eth7', 'address', '206.168.244.233/29'] },
      { op: 'set', path: ['interfaces', 'ethernet', 'eth7', 'address', '206.168.245.17/29'] },
    ]);
    assert.equal(router.saves, savesBefore + 1);
    assert.deepEqual(ids(await sync.plan()), []);
  });

  test('an id the panel did not offer is refused, so nothing arbitrary can be sent', async () => {
    const sent = router.configured.length;
    for (const id of ['add:8.8.8.8/32', 'remove:206.168.244.1/22', 'remove:206.168.244.249/29', 'add:1.1.1.1/24 ; delete system']) {
      await assert.rejects(sync.apply([id]), { code: 'plan_changed' }, id);
    }
    assert.equal(router.configured.length, sent);
  });

  test('deleting a subnet offers the removal, unticked in the UI and named', async () => {
    const prefix = ipam.listPrefixes().find((p) => p.cidr === '206.168.244.232/29');
    ipam.unassignPrefix(prefix.id);
    const plan = await sync.plan();
    assert.deepEqual(ids(plan), ['remove:206.168.244.233/29']);
    assert.equal(plan.changes[0].owner, 'Acme');
    assert.equal(plan.changes[0].command, 'delete interfaces ethernet eth7 address 206.168.244.233/29');
    assert.ok(router.addresses.has('206.168.244.233/29'), 'still on the router until applied');
  });

  test('a removal is applied only when asked', async () => {
    await sync.apply(['remove:206.168.244.233/29']);
    assert.ok(!router.addresses.has('206.168.244.233/29'));
    assert.deepEqual(ids(await sync.plan()), []);
  });

  test('a refused change is not saved and not remembered', async () => {
    ipam.carve({ cidr: '206.168.245.48/29', customerId: customer, datacenterId: dc });
    const saves = router.saves;
    router.refuse = true;
    await assert.rejects(sync.apply(['add:206.168.245.49/29']), { code: 'router_error' });
    router.refuse = false;
    assert.equal(router.saves, saves);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM router_addresses WHERE address = '206.168.245.49/29'`).get().n, 0);
  });

  test('a change the router accepts but does not make is caught before saving', async () => {
    const saves = router.saves;
    router.ignore = true;
    await assert.rejects(sync.apply(['add:206.168.245.49/29']), /not as expected/);
    router.ignore = false;
    assert.equal(router.saves, saves);
  });

  test('an address removed by hand stops being tracked', async () => {
    await sync.apply(['add:206.168.245.49/29']);
    ipam.unassignPrefix(ipam.listPrefixes().find((p) => p.cidr === '206.168.245.48/29').id);
    router.addresses.delete('206.168.245.49/29');
    assert.deepEqual(ids(await sync.plan()), []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM router_addresses WHERE address = '206.168.245.49/29'`).get().n, 0);
  });

  test('a change deleted from the queue stays gone, and cannot be applied', async () => {
    const carved = ipam.carve({ cidr: '206.168.245.64/29', customerId: customer, datacenterId: dc });
    const id = 'add:206.168.245.65/29';
    assert.ok(ids(await sync.plan()).includes(id));

    await sync.dismiss(id);
    const plan = await sync.plan();
    assert.ok(!ids(plan).includes(id));
    assert.deepEqual(plan.dismissed.map((c) => c.id), [id]);
    assert.ok(!(await sync.plan()).changes.some((c) => c.id === id), 'still gone on the next look');
    await assert.rejects(sync.apply([id]), { code: 'plan_changed' });
    assert.ok(!router.addresses.has('206.168.245.65/29'));

    sync.restore(id);
    assert.ok(ids(await sync.plan()).includes(id), 'restoring brings it back');

    await sync.dismiss(id);
    ipam.unassignPrefix(carved.id);
    ipam.applyDelete(ipam.planDelete(carved.id, false));
    assert.deepEqual((await sync.plan()).dismissed, [], 'forgotten once it no longer applies');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_dismissed').get().n, 0);
  });

  test('deleting a removal from the queue leaves the address on the router', async () => {
    const carved = ipam.carve({ cidr: '206.168.245.72/29', customerId: customer, datacenterId: dc });
    await sync.apply(['add:206.168.245.73/29']);
    ipam.unassignPrefix(carved.id);
    await sync.dismiss('remove:206.168.245.73/29');
    assert.ok(router.addresses.has('206.168.245.73/29'));
    assert.ok(!ids(await sync.plan()).includes('remove:206.168.245.73/29'));
    sync.restore('remove:206.168.245.73/29');
    await sync.apply(['remove:206.168.245.73/29']);
    ipam.applyDelete(ipam.planDelete(carved.id, false));
  });

  test('only a change in the queue can be deleted from it', async () => {
    await assert.rejects(sync.dismiss('remove:206.168.244.1/22'), { code: 'plan_changed' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_dismissed').get().n, 0);
  });

  test('a router that cannot be reached is reported, and a batch is limited', async () => {
    router.fail = true;
    await assert.rejects(sync.plan(), { code: 'router_error' });
    router.fail = false;
    await assert.rejects(sync.apply([]), /at least one/);
    await assert.rejects(sync.apply(Array(21).fill('x')), /at most 20/);
  });

  test('a new API address has to be tested again', async () => {
    sync.saveSettings({ url: 'https://192.0.2.2', interface: 'eth7', datacenterId: dc });
    await assert.rejects(sync.apply(['add:x']), { code: 'not_tested' });
    assert.ok(range);
  });
});

describe('VyOS API client', () => {
  let server;
  let url;
  const seen = [];
  let reply = { success: true, data: ['192.0.2.1/24'], error: null };

  before(async () => {
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ path: req.url, type: req.headers['content-type'], body });
      res.writeHead(reply.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('requests are multipart forms with data and key, as the VyOS docs show', async () => {
    const client = createVyosClient({ url, key: 'the-key', fingerprint: '' });
    assert.deepEqual(await client.addresses('eth7'), ['192.0.2.1/24']);
    const { path, type, body } = seen.at(-1);
    assert.equal(path, '/retrieve');
    assert.match(type, /^multipart\/form-data; boundary=/);
    assert.match(body, /name="key"\r\n\r\nthe-key\r\n/);
    assert.match(body, /"op":"returnValues"/);
    assert.match(body, /"path":\["interfaces","ethernet","eth7","address"\]/);
  });

  test('configure and save go to the documented endpoints', async () => {
    const client = createVyosClient({ url, key: 'k', fingerprint: '' });
    await client.configure([{ op: 'set', path: ['interfaces', 'ethernet', 'eth7', 'address', '192.0.2.9/29'] }]);
    assert.equal(seen.at(-1).path, '/configure');
    await client.save();
    assert.equal(seen.at(-1).path, '/config-file');
    assert.match(seen.at(-1).body, /"op":"save"/);
  });

  test('an interface with no addresses is empty, and other errors are reported', async () => {
    const client = createVyosClient({ url, key: 'k', fingerprint: '' });
    reply = { success: false, data: null, error: 'Configuration under specified path is empty' };
    assert.deepEqual(await client.addresses('eth9'), []);
    reply = { success: false, data: null, error: 'Valid API key is required' };
    await assert.rejects(client.addresses('eth7'), /Valid API key/);
    await assert.rejects(client.configure([]), VyosError);
  });
});
