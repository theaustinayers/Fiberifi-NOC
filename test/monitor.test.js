import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase, seed } from '../src/db.js';
import { toBigInt } from '../src/lib/snmp.js';
import { createMonitor, rate } from '../src/monitor.js';

const SECRET = 'test-secret-test-secret-test-secret';
const PASSWORD = 'correct-horse-battery-staple';

function fakeRouter(overrides = {}) {
  return {
    sysName: 'vyos',
    sysDescr: 'VyOS test',
    uptimeSeconds: 86400,
    cpu: 12,
    memory: 40,
    load1: 0.25,
    interfaces: [
      { index: 1, name: 'eth1', alias: 'Uplink', speedMbps: 10000, admin: 'up', oper: 'up', inOctets: 1000n, outOctets: 2000n, inErrors: 0, outErrors: 0, inDiscards: 0, outDiscards: 0 },
      { index: 2, name: 'eth2', alias: '', speedMbps: 1000, admin: 'up', oper: 'down', inOctets: 0n, outOctets: 0n, inErrors: 2, outErrors: 1, inDiscards: 3, outDiscards: 0 },
    ],
    ...overrides,
  };
}

test('bandwidth is worked out from the change in the counters', () => {
  assert.equal(rate(1000n, 2000n, 10), 800);
});

test('a counter going backwards is a restart, not traffic', () => {
  assert.equal(rate(5000n, 100n, 30), null);
});

test('a long gap or no elapsed time gives no rate', () => {
  assert.equal(rate(0n, 100n, 0), null);
  assert.equal(rate(0n, 100n, 3600), null);
});

test('64-bit counters survive beyond what a Number can hold', () => {
  const big = 0xffffffffffffffffn;
  assert.equal(toBigInt(Buffer.from('ffffffffffffffff', 'hex')), big);
  assert.equal(toBigInt(Buffer.alloc(0)), 0n);
  assert.equal(toBigInt(42), 42n);
  assert.equal(rate(big - 1000n, big, 8), 1000);
});

describe('monitor', () => {
  let db;
  let monitor;
  let responses;

  const config = () => ({
    appSecret: SECRET,
    snmpReader: async (host, creds) => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.equal(creds.authPassword, PASSWORD);
      return next;
    },
  });

  before(() => {
    db = openDatabase(':memory:');
    monitor = createMonitor(db, config());
    responses = [];
  });
  after(() => db.close());

  test('polling needs credentials first', async () => {
    const router = monitor.createRouter({ name: 'PIT', host: '192.0.2.1', role: 'core' });
    await assert.rejects(monitor.pollRouter(router), { code: 'snmp_not_configured' });
  });

  test('credentials are encrypted and the password is not readable back', () => {
    monitor.saveSettings({ user: 'noc', authPassword: PASSWORD });
    const stored = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'snmp%'`).all();
    assert.ok(!JSON.stringify(stored).includes(PASSWORD));
    assert.deepEqual(monitor.getSettings(), { configured: true, user: 'noc' });
  });

  test('a blank password keeps the saved one, and a short one is refused', () => {
    assert.throws(() => monitor.saveSettings({ user: 'noc', authPassword: 'short' }), /at least 8/);
    monitor.saveSettings({ user: 'noc2' });
    assert.equal(monitor.getSettings().user, 'noc2');
    monitor.saveSettings({ user: 'noc' });
  });

  test('the first poll records status but has no rate to report yet', async () => {
    const router = monitor.listRouters()[0];
    responses.push(fakeRouter());
    await monitor.pollRouter(db.prepare('SELECT * FROM routers WHERE id = ?').get(router.id), 1_000_000_000_000);
    const detail = monitor.routerDetail(router.id);
    assert.equal(detail.status, 'up');
    assert.equal(detail.cpu, 12);
    assert.equal(detail.portsTotal, 2);
    assert.equal(detail.portsUp, 1);
    assert.equal(detail.interfaces[0].name, 'eth1');
    assert.equal(detail.interfaces[0].inBps, null);
  });

  test('the second poll reports bandwidth and stores a sample', async () => {
    const router = db.prepare('SELECT * FROM routers').get();
    const next = fakeRouter();
    next.interfaces[0].inOctets = 1000n + 3_750_000n;
    next.interfaces[0].outOctets = 2000n + 375_000n;
    responses.push(next);
    await monitor.pollRouter(router, 1_000_000_030_000);
    const eth1 = monitor.routerDetail(router.id).interfaces[0];
    assert.equal(eth1.inBps, 1_000_000);
    assert.equal(eth1.outBps, 100_000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM interface_samples').get().n, 2);
  });

  test('a router rebooting does not produce a false spike', async () => {
    const router = db.prepare('SELECT * FROM routers').get();
    const next = fakeRouter();
    next.interfaces[0].inOctets = 10n;
    next.interfaces[0].outOctets = 10n;
    responses.push(next);
    await monitor.pollRouter(router, 1_000_000_060_000);
    assert.equal(monitor.routerDetail(router.id).interfaces[0].inBps, null);
  });

  test('one failed poll is not an outage, and two are', async () => {
    let router = db.prepare('SELECT * FROM routers').get();
    responses.push(new Error('Request timed out'));
    await monitor.pollRouter(router);
    assert.equal(monitor.routerDetail(router.id).status, 'up');
    router = db.prepare('SELECT * FROM routers').get();
    responses.push(new Error('Request timed out'));
    await monitor.pollRouter(router);
    const detail = monitor.routerDetail(router.id);
    assert.equal(detail.status, 'down');
    assert.equal(detail.lastError, 'Request timed out');
    router = db.prepare('SELECT * FROM routers').get();
    responses.push(fakeRouter());
    await monitor.pollRouter(router);
    assert.equal(monitor.routerDetail(router.id).status, 'up');
    assert.equal(monitor.routerDetail(router.id).lastError, '');
  });

  test('history survives an interface being renumbered', async () => {
    const router = db.prepare('SELECT * FROM routers').get();
    const before = monitor.routerDetail(router.id).interfaces.find((i) => i.name === 'eth1').id;
    const next = fakeRouter();
    next.interfaces[0].index = 99;
    responses.push(next);
    await monitor.pollRouter(router);
    assert.equal(monitor.routerDetail(router.id).interfaces.find((i) => i.name === 'eth1').id, before);
  });

  test('old data is averaged, then dropped', () => {
    const router = db.prepare('SELECT * FROM routers').get();
    const iface = db.prepare(`SELECT id FROM router_interfaces WHERE name = 'eth1'`).get();
    const now = 2_000_000_000_000;
    const seconds = now / 1000;
    const base = seconds - (seconds % 300) - 300;
    db.prepare('DELETE FROM interface_samples').run();
    const add = db.prepare('INSERT INTO interface_samples (interface_id, ts, in_bps, out_bps) VALUES (?, ?, ?, ?)');
    add.run(iface.id, base, 100, 10);
    add.run(iface.id, base + 30, 300, 30);
    add.run(iface.id, seconds - 3 * 86400, 1, 1);
    db.prepare('INSERT INTO router_samples (router_id, ts, cpu, memory) VALUES (?, ?, 50, 50)').run(router.id, base);
    db.prepare('INSERT INTO interface_rollups (interface_id, ts, in_bps, out_bps, in_max, out_max) VALUES (?, ?, 1, 1, 1, 1)').run(iface.id, seconds - 40 * 86400);

    monitor.compact(now);

    const roll = db.prepare('SELECT * FROM interface_rollups WHERE ts = ?').get(base);
    assert.equal(roll.in_bps, 200);
    assert.equal(roll.in_max, 300);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM interface_samples').get().n, 2, 'raw data past two days is gone');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM interface_rollups').get().n, 1, 'rollups past 35 days are gone');
  });

  test('history comes back thinned and in order', () => {
    const router = db.prepare('SELECT * FROM routers').get();
    const iface = db.prepare(`SELECT id FROM router_interfaces WHERE name = 'eth1'`).get();
    db.prepare('DELETE FROM interface_samples').run();
    const add = db.prepare('INSERT INTO interface_samples (interface_id, ts, in_bps, out_bps) VALUES (?, ?, ?, ?)');
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2880; i += 1) add.run(iface.id, now - i * 30, i, i);
    const { rows, step } = monitor.interfaceHistory(router.id, iface.id, '24h');
    assert.equal(step, 240);
    assert.ok(rows.length <= 362, String(rows.length));
    assert.ok(rows.every((r, i) => i === 0 || r.ts > rows[i - 1].ts));
  });

  test('deleting a router removes its history', () => {
    const router = db.prepare('SELECT * FROM routers').get();
    monitor.deleteRouter(router.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_interfaces').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM interface_samples').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_samples').get().n, 0);
  });
});

describe('routers API', () => {
  let dir;
  let db;
  let server;
  let base;
  let adminCookie;
  let customerCookie;

  const call = async (method, url, body, cookie = adminCookie) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-mon-'));
    db = openDatabase(path.join(dir, 't.db'));
    const cfg = { production: false, appSecret: SECRET, publicUrl: '', trustProxy: 0, secureCookies: false, cloudflareApiBase: 'http://127.0.0.1:9', adminEmail: 'a@b.example', adminPassword: 'initial-admin-password', sessionHours: 12, snmpReader: async () => fakeRouter() };
    await seed(db, cfg, () => {});
    const app = createApp(db, cfg);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await call('POST', '/api/auth/login', { email: 'a@b.example', password: 'initial-admin-password' }, '');
    adminCookie = login.cookie;
    await call('POST', '/api/auth/change-password', { currentPassword: 'initial-admin-password', newPassword: 'a-better-admin-password' });
    const made = await call('POST', '/api/admin/users', { name: 'C', email: 'c@c.example' });
    const customer = await call('POST', '/api/auth/login', { email: 'c@c.example', password: made.data.temporaryPassword }, '');
    customerCookie = customer.cookie;
    await call('POST', '/api/auth/change-password', { currentPassword: made.data.temporaryPassword, newPassword: 'a-customer-password' }, customerCookie);
  });

  after(() => {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('customers cannot see or change routers or SNMP settings', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/admin/routers'],
      ['GET', '/api/admin/routers/settings'],
      ['PUT', '/api/admin/routers/settings', { user: 'x', authPassword: 'password1' }],
      ['POST', '/api/admin/routers', { name: 'X', host: '192.0.2.9' }],
      ['GET', '/api/admin/routers/1'],
    ]) {
      assert.equal((await call(method, url, body, customerCookie)).status, 403, url);
    }
    assert.equal((await call('GET', '/api/admin/routers', undefined, '')).status, 401);
  });

  test('the SNMP password never comes back from the API or lands in the audit log', async () => {
    const saved = await call('PUT', '/api/admin/routers/settings', { user: 'noc', authPassword: PASSWORD });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.data).includes(PASSWORD));
    assert.ok(!JSON.stringify((await call('GET', '/api/admin/routers/settings')).data).includes(PASSWORD));
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(PASSWORD));
  });

  test('a router can be added, polled, edited and deleted', async () => {
    const created = await call('POST', '/api/admin/routers', { name: 'NYC', host: '192.0.2.17', role: 'edge' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.router.status, 'up', 'polled straight away');
    const id = created.data.router.id;
    assert.equal((await call('POST', '/api/admin/routers', { name: 'nyc', host: '192.0.2.18' })).status, 409);
    assert.equal((await call('POST', `/api/admin/routers/${id}/poll`)).status, 200);
    const edited = await call('PATCH', `/api/admin/routers/${id}`, { host: '192.0.2.99' });
    assert.equal(edited.data.router.host, '192.0.2.99');
    assert.equal(edited.data.router.name, 'NYC');
    assert.equal((await call('GET', `/api/admin/routers/${id}/history?range=7d`)).status, 200);
    const ifaceId = edited.data.router.interfaces[0].id;
    assert.equal((await call('GET', `/api/admin/routers/${id}/interfaces/${ifaceId}/history`)).status, 200);
    assert.equal((await call('GET', `/api/admin/routers/${id}/interfaces/99999/history`)).status, 404);
    assert.equal((await call('DELETE', `/api/admin/routers/${id}`)).status, 200);
    assert.equal((await call('GET', `/api/admin/routers/${id}`)).status, 404);
  });

  test('deleting a datacenter leaves its router in place', async () => {
    const dc = await call('POST', '/api/admin/datacenters', { name: 'Temp' });
    const made = await call('POST', '/api/admin/routers', { name: 'T', host: '192.0.2.5', datacenterId: dc.data.datacenter.id });
    assert.equal(made.data.router.datacenter.name, 'Temp');
    assert.equal((await call('DELETE', `/api/admin/datacenters/${dc.data.datacenter.id}`)).status, 200);
    assert.equal((await call('GET', `/api/admin/routers/${made.data.router.id}`)).data.router.datacenter, null);
  });
});
