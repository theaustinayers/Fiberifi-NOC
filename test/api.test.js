import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase, SCHEMA, seed } from '../src/db.js';
import { startMockCloudflare } from './mock-cloudflare.js';

const CF_TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const ADMIN = { email: 'admin@fiberifi.com', password: 'initial-admin-password' };
const ADMIN_NEW_PASSWORD = 'a-much-better-admin-password';

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async call(method, url, body, headers = {}) {
    const response = await fetch(`${this.base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }

  get = (url) => this.call('GET', url);
  post = (url, body = {}, headers) => this.call('POST', url, body, headers);
  put = (url, body = {}) => this.call('PUT', url, body);
  patch = (url, body = {}) => this.call('PATCH', url, body);
  delete = (url) => this.call('DELETE', url);
}

describe('NOC API', () => {
  let dir;
  let db;
  let server;
  let base;
  let cf;
  let admin;
  let acme;
  let globex;
  let acmeId;
  let globexId;
  let aggregate;
  let datacenterId;

  const config = (cfBase) => ({
    production: false,
    appSecret: 'test-secret-test-secret-test-secret',
    publicUrl: '',
    trustProxy: 0,
    secureCookies: false,
    cloudflareApiBase: cfBase,
    adminEmail: ADMIN.email,
    adminPassword: ADMIN.password,
    sessionHours: 12,
  });

  async function newCustomer(company, email) {
    const { data } = await admin.post('/api/admin/users', { name: `${company} NOC`, company, email, role: 'customer' });
    const client = new Client(base);
    await client.post('/api/auth/login', { email, password: data.temporaryPassword });
    const password = `${company}-long-enough-password`;
    await client.post('/api/auth/change-password', { currentPassword: data.temporaryPassword, newPassword: password });
    return { client, id: data.user.id };
  }

  async function allocate(parentId, length, customerId) {
    datacenterId ??= (await admin.post('/api/admin/datacenters', { name: 'Pittsburgh 1', code: 'PIT1' })).data.datacenter.id;
    const { status, data } = await admin.post(`/api/admin/prefixes/${parentId}/allocate`, { length, customerId, datacenterId });
    assert.equal(status, 201, JSON.stringify(data));
    return data.prefix;
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-test-'));
    cf = await startMockCloudflare({
      token: CF_TOKEN,
      zones: [
        { id: 'z89', name: '89.112.149.in-addr.arpa', status: 'active' },
        { id: 'z6', name: '0.4.3.9.7.0.6.2.ip6.arpa', status: 'active' },
        { id: 'zweb', name: 'fiberifi.com', status: 'active' },
      ],
    });
    db = openDatabase(path.join(dir, 'test.db'));
    const cfg = config(cf.url);
    await seed(db, cfg, () => {});
    const app = createApp(db, cfg);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    admin = new Client(base);
    await admin.post('/api/auth/login', ADMIN);
  });

  after(() => {
    server.close();
    cf.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('anonymous requests are refused', async () => {
    const anon = new Client(base);
    assert.equal((await anon.get('/api/admin/prefixes')).status, 401);
    assert.equal((await anon.get('/api/subnets')).status, 401);
  });

  test('a first login must change the password before anything else', async () => {
    const blocked = await admin.get('/api/admin/prefixes');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'password_change_required');
    const short = await admin.post('/api/auth/change-password', { currentPassword: ADMIN.password, newPassword: 'short' });
    assert.equal(short.status, 400);
    const done = await admin.post('/api/auth/change-password', { currentPassword: ADMIN.password, newPassword: ADMIN_NEW_PASSWORD });
    assert.equal(done.status, 200);
    assert.equal((await admin.get('/api/admin/prefixes')).status, 200);
  });

  test('the four default ranges are seeded', async () => {
    const { data } = await admin.get('/api/admin/prefixes');
    assert.deepEqual(
      data.prefixes.map((p) => p.cidr).sort(),
      ['149.112.89.0/24', '2001:504:13a::/48', '206.168.244.0/22', '2607:9340::/32'],
    );
    assert.ok(data.prefixes.every((p) => p.status === 'container'));
    aggregate = data.prefixes.find((p) => p.cidr === '149.112.89.0/24');
  });

  test('a deleted default range stays deleted after a restart', async () => {
    const { data } = await admin.get('/api/admin/prefixes');
    const target = data.prefixes.find((p) => p.cidr === '2001:504:13a::/48');
    assert.equal((await admin.delete(`/api/admin/prefixes/${target.id}`)).status, 200);
    await seed(db, config(cf.url), () => {});
    const after = await admin.get('/api/admin/prefixes');
    assert.ok(!after.data.prefixes.some((p) => p.cidr === '2001:504:13a::/48'));
    assert.equal((await admin.post('/api/admin/prefixes', { cidr: '2001:504:13A::/48' })).status, 201);
  });

  test('customers cannot reach admin routes', async () => {
    ({ client: acme, id: acmeId } = await newCustomer('Acme', 'noc@acme.example'));
    ({ client: globex, id: globexId } = await newCustomer('Globex', 'noc@globex.example'));
    for (const url of ['/api/admin/prefixes', '/api/admin/users', '/api/admin/settings', '/api/admin/audit']) {
      assert.equal((await acme.get(url)).status, 403, url);
    }
    assert.equal((await acme.post('/api/admin/prefixes', { cidr: '10.0.0.0/8' })).status, 403);
  });

  test('duplicates and bad prefixes are refused', async () => {
    assert.equal((await admin.post('/api/admin/prefixes', { cidr: '149.112.89.0/24' })).status, 409);
    const bad = await admin.post('/api/admin/prefixes', { cidr: '149.112.89.1/24' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /Did you mean/);
  });

  test('allocation assigns the next free block and customers see only their own', async () => {
    const a = await allocate(aggregate.id, 29, acmeId);
    const g = await allocate(aggregate.id, 29, globexId);
    assert.equal(a.cidr, '149.112.89.0/29');
    assert.equal(g.cidr, '149.112.89.8/29');

    const mine = await acme.get('/api/subnets');
    assert.deepEqual(mine.data.subnets.map((s) => s.cidr), ['149.112.89.0/29']);
    assert.equal(mine.data.subnets[0].gateway, '149.112.89.1');
    assert.equal(mine.data.subnets[0].broadcast, '149.112.89.7');

    assert.equal((await acme.get(`/api/subnets/${g.id}`)).status, 404);
    assert.equal((await acme.get(`/api/subnets/${g.id}/addresses`)).status, 404);
    assert.equal((await acme.put(`/api/subnets/${g.id}/addresses/149.112.89.10`, { hostname: 'x' })).status, 404);
    assert.equal((await acme.put(`/api/subnets/${g.id}/rdns/149.112.89.10`, { hostname: 'a.example.com' })).status, 404);
  });

  test('overlapping assignments are refused', async () => {
    const res = await admin.post(`/api/admin/prefixes/${aggregate.id}/assign`, { customerId: acmeId });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'assignment_overlap');
  });

  test('address rows grey out network, gateway and broadcast', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const { data } = await acme.get(`/api/subnets/${list.subnets[0].id}/addresses`);
    assert.equal(data.rows.length, 8);
    assert.deepEqual(
      data.rows.filter((r) => r.locked).map((r) => [r.ip, r.role]),
      [
        ['149.112.89.0', 'network'],
        ['149.112.89.1', 'gateway'],
        ['149.112.89.7', 'broadcast'],
      ],
    );
  });

  test('locked addresses are enforced by the server, not only the UI', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    for (const ip of ['149.112.89.0', '149.112.89.1', '149.112.89.7']) {
      const save = await acme.put(`/api/subnets/${id}/addresses/${ip}`, { hostname: 'nope' });
      assert.equal(save.status, 403, ip);
      assert.equal(save.data.error.code, 'locked');
      assert.equal((await acme.put(`/api/subnets/${id}/rdns/${ip}`, { hostname: 'a.example.com' })).status, 403, ip);
    }
    assert.equal((await admin.put(`/api/subnets/${id}/addresses/149.112.89.1`, { hostname: 'gw' })).status, 200);
    assert.equal((await admin.put(`/api/subnets/${id}/addresses/149.112.89.7`, { hostname: 'bc' })).status, 403);
    await admin.delete(`/api/subnets/${id}/addresses/149.112.89.1`);
  });

  test('a customer can keep address records in their own space only', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    const saved = await acme.put(`/api/subnets/${id}/addresses/149.112.89.2`, {
      hostname: 'web1',
      mac: '00-1A-2B-3C-4D-5E',
      description: 'Web server',
    });
    assert.equal(saved.status, 200);
    const { data } = await acme.get(`/api/subnets/${id}/addresses`);
    const row = data.rows.find((r) => r.ip === '149.112.89.2');
    assert.equal(row.record.mac, '00:1a:2b:3c:4d:5e');
    const outside = await acme.put(`/api/subnets/${id}/addresses/149.112.89.20`, { hostname: 'x' });
    assert.equal(outside.status, 400);
  });

  test('rDNS reports clearly when Cloudflare is not set up', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const res = await acme.put(`/api/subnets/${list.subnets[0].id}/rdns/149.112.89.2`, { hostname: 'mail.acme.example' });
    assert.equal(res.status, 503);
    assert.equal(res.data.error.code, 'rdns_not_configured');
  });

  test('the Cloudflare token is write-only and encrypted at rest', async () => {
    const saved = await admin.put('/api/admin/settings', { token: CF_TOKEN, ttl: 3600 });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.data).includes(CF_TOKEN));
    assert.equal(saved.data.cloudflare.tokenHint, '…wxyz');
    const read = await admin.get('/api/admin/settings');
    assert.ok(!JSON.stringify(read.data).includes(CF_TOKEN));
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'cf_token'`).get().value;
    assert.ok(!stored.includes(CF_TOKEN));
    const audit = db.prepare('SELECT detail FROM audit_log').all();
    assert.ok(!JSON.stringify(audit).includes(CF_TOKEN));
    assert.equal((await acme.get('/api/admin/settings')).status, 403);
  });

  test('zone coverage shows found and missing reverse zones', async () => {
    const { data } = await admin.post('/api/admin/settings/test-cloudflare');
    assert.deepEqual(data.zones.map((z) => z.id), ['z89', 'z6']);
    const v4 = data.prefixes.find((p) => p.cidr === '149.112.89.0/24');
    assert.equal(v4.zones[0].found, '89.112.149.in-addr.arpa');
    const missing = data.prefixes.find((p) => p.cidr === '206.168.244.0/22');
    assert.equal(missing.zones.length, 4);
    assert.ok(missing.zones.every((z) => z.found === null));
  });

  test('a customer sets, updates and deletes a PTR through Cloudflare', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    const created = await acme.put(`/api/subnets/${id}/rdns/149.112.89.2`, { hostname: 'Mail.Acme.Example.' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(cf.state.records.length, 1);
    assert.deepEqual(
      { name: cf.state.records[0].name, content: cf.state.records[0].content, type: cf.state.records[0].type, ttl: cf.state.records[0].ttl },
      { name: '2.89.112.149.in-addr.arpa', content: 'mail.acme.example', type: 'PTR', ttl: 3600 },
    );

    await acme.put(`/api/subnets/${id}/rdns/149.112.89.2`, { hostname: 'smtp.acme.example' });
    assert.equal(cf.state.records.length, 1, 'updates in place');
    assert.equal(cf.state.records[0].content, 'smtp.acme.example');
    const patch = cf.state.requests.find((r) => r.method === 'PATCH');
    assert.equal(patch.body.name, '2.89.112.149.in-addr.arpa', 'PATCH carries the full record');

    const { data } = await acme.get(`/api/subnets/${id}/addresses`);
    assert.equal(data.rows.find((r) => r.ip === '149.112.89.2').rdns.hostname, 'smtp.acme.example');

    assert.equal((await acme.delete(`/api/subnets/${id}/rdns/149.112.89.2`)).status, 200);
    assert.equal(cf.state.records.length, 0);
  });

  test('customers cannot write a PTR outside their subnet or with a bad hostname', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    const count = cf.state.records.length;
    assert.equal((await acme.put(`/api/subnets/${id}/rdns/149.112.89.10`, { hostname: 'evil.example.com' })).status, 400);
    assert.equal((await acme.put(`/api/subnets/${id}/rdns/8.8.8.8`, { hostname: 'evil.example.com' })).status, 400);
    for (const hostname of ['', 'nodots', 'bad_label.example.com', '-x.example.com', 'a b.example.com', 'x.in-addr.arpa', '1.2.3.4']) {
      assert.equal((await acme.put(`/api/subnets/${id}/rdns/149.112.89.3`, { hostname })).status, 400, hostname);
    }
    assert.equal(cf.state.records.length, count);
  });

  test('a missing reverse zone gives a clear error', async () => {
    const { data: tree } = await admin.get('/api/admin/prefixes');
    const parent = tree.prefixes.find((p) => p.cidr === '206.168.244.0/22');
    const subnet = await allocate(parent.id, 30, acmeId);
    const res = await acme.put(`/api/subnets/${subnet.id}/rdns/206.168.244.2`, { hostname: 'a.acme.example' });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'no_zone');
  });

  test('IPv6 subnets are sparse and PTRs land in the right zone', async () => {
    const { data: tree } = await admin.get('/api/admin/prefixes');
    const parent = tree.prefixes.find((p) => p.cidr === '2607:9340::/32');
    const subnet = await allocate(parent.id, 48, acmeId);
    assert.equal(subnet.cidr, '2607:9340::/48');
    assert.equal(subnet.broadcast, null);

    const empty = await acme.get(`/api/subnets/${subnet.id}/addresses`);
    assert.equal(empty.data.dense, false);
    assert.deepEqual(empty.data.rows.map((r) => [r.ip, r.role]), [
      ['2607:9340::', 'network'],
      ['2607:9340::1', 'gateway'],
    ]);

    const res = await acme.put(`/api/subnets/${subnet.id}/rdns/${encodeURIComponent('2607:9340::25')}`, { hostname: 'mail.acme.example' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const record = cf.state.records.at(-1);
    assert.equal(record.zone_id, 'z6');
    assert.ok(record.name.endsWith('0.4.3.9.7.0.6.2.ip6.arpa'));
    const full = await acme.get(`/api/subnets/${subnet.id}/addresses`);
    assert.ok(full.data.rows.some((r) => r.ip === '2607:9340::25' && r.rdns));
  });

  test('sync imports PTRs that already exist in Cloudflare', async () => {
    cf.state.records.push({
      id: 'preexisting',
      zone_id: 'z89',
      type: 'PTR',
      name: '200.89.112.149.in-addr.arpa',
      content: 'legacy.fiberifi.com.',
      ttl: 300,
    });
    const { data } = await admin.post('/api/admin/rdns/sync');
    assert.ok(data.records >= 2);
    const row = db.prepare(`SELECT * FROM rdns_records WHERE ip = '149.112.89.200'`).get();
    assert.equal(row.hostname, 'legacy.fiberifi.com');
  });

  test('resizing cannot strand child prefixes or records', async () => {
    const res = await admin.patch(`/api/admin/prefixes/${aggregate.id}`, { cidr: '149.112.89.128/25' });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'resize_blocked');
  });

  test('assigned prefixes cannot be deleted', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    assert.equal((await admin.delete(`/api/admin/prefixes/${id}`)).status, 409);
    assert.equal((await admin.delete(`/api/admin/prefixes/${aggregate.id}?cascade=true`)).status, 409);
  });

  test('a customer with subnets cannot be deleted', async () => {
    assert.equal((await admin.delete(`/api/admin/users/${acmeId}`)).status, 409);
  });

  test('unassigning revokes access and clears the customer records and PTRs', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const subnet = list.subnets.find((s) => s.cidr === '149.112.89.0/29');
    await acme.put(`/api/subnets/${subnet.id}/rdns/149.112.89.3`, { hostname: 'gone.acme.example' });
    assert.ok(cf.state.records.some((r) => r.content === 'gone.acme.example'));

    const res = await admin.post(`/api/admin/prefixes/${subnet.id}/unassign`, {});
    assert.equal(res.status, 200);
    assert.equal(res.data.recordsRemoved, 1);
    assert.equal(res.data.ptrRemoved, 1);
    assert.ok(!cf.state.records.some((r) => r.content === 'gone.acme.example'));
    assert.equal((await acme.get(`/api/subnets/${subnet.id}`)).status, 404);

    const next = await admin.post(`/api/admin/prefixes/${subnet.id}/assign`, { customerId: globexId });
    assert.equal(next.status, 200);
    const { data } = await globex.get(`/api/subnets/${subnet.id}/addresses`);
    assert.ok(data.rows.every((r) => !r.record && !r.rdns), 'the next customer sees nothing of the last');
  });

  test('a Cloudflare outage does not stop a revocation and the leftovers are reported', async () => {
    const { data: list } = await globex.get('/api/subnets');
    const subnet = list.subnets.find((s) => s.cidr === '149.112.89.0/29');
    await globex.put(`/api/subnets/${subnet.id}/rdns/149.112.89.4`, { hostname: 'stuck.globex.example' });
    cf.state.failDeletes = true;
    const res = await admin.post(`/api/admin/prefixes/${subnet.id}/unassign`, {});
    cf.state.failDeletes = false;
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.ptrFailed, ['149.112.89.4']);
    assert.equal((await globex.get(`/api/subnets/${subnet.id}`)).status, 404);
    assert.equal(res.data.prefix.rdnsCount, 1);
  });

  test('a Cloudflare failure hides its detail from customers', async () => {
    const { data: tree } = await admin.get('/api/admin/prefixes');
    const parent = tree.prefixes.find((p) => p.cidr === '2607:9340::/32');
    const subnet = await allocate(parent.id, 48, globexId);
    const stored = db.prepare(`SELECT value FROM settings WHERE key = 'cf_token'`).get().value;
    await admin.put('/api/admin/settings', { token: 'wrong-token-abcdefghijklmnop' });
    const res = await globex.put(`/api/subnets/${subnet.id}/rdns/${encodeURIComponent('2607:9340:1::5')}`, { hostname: 'a.globex.example' });
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'cf_token'`).run(stored);
    assert.equal(res.status, 502);
    assert.ok(!res.data.error.message.includes('Invalid access token'));
  });

  test('split creates children and turns the parent into a container', async () => {
    const created = await admin.post('/api/admin/prefixes', { cidr: '206.168.247.0/24' });
    const res = await admin.post(`/api/admin/prefixes/${created.data.prefix.id}/split`, { length: 26 });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.prefix.children.length, 4);
    assert.equal(res.data.prefix.status, 'container');
    const again = await admin.post(`/api/admin/prefixes/${created.data.prefix.id}/split`, { length: 27 });
    assert.equal(again.status, 200, 'a second split nests inside the first');
    assert.equal(again.data.prefix.children.length, 4, 'direct children are unchanged');
  });

  test('deleting with children needs an explicit cascade', async () => {
    const { data: tree } = await admin.get('/api/admin/prefixes');
    const target = tree.prefixes.find((p) => p.cidr === '206.168.247.0/24');
    const refused = await admin.delete(`/api/admin/prefixes/${target.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error.code, 'has_children');
    assert.equal((await admin.delete(`/api/admin/prefixes/${target.id}?cascade=true`)).status, 200);
  });

  test('the gateway can be overridden and must be valid', async () => {
    const { data: tree } = await admin.get('/api/admin/prefixes');
    const parent = tree.prefixes.find((p) => p.cidr === '206.168.244.0/22');
    const subnet = await allocate(parent.id, 28);
    const url = `/api/admin/prefixes/${subnet.id}/assign`;
    assert.equal((await admin.post(url, { customerId: globexId, gateway: '8.8.8.8' })).status, 400);
    assert.equal((await admin.post(url, { customerId: globexId, gateway: subnet.firstAddress })).status, 400);
    const last = subnet.lastAddress.replace(/\d+$/, (n) => String(Number(n) - 1));
    const ok = await admin.post(url, { customerId: globexId, gateway: last });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.prefix.gateway, last);
    const row = (await globex.get(`/api/subnets/${subnet.id}/addresses`)).data.rows.find((r) => r.ip === last);
    assert.equal(row.role, 'gateway');
    assert.equal(row.locked, true);
  });

  test('search finds an address, its prefix and its customer', async () => {
    const { data } = await admin.get('/api/admin/search?q=149.112.89.200');
    assert.ok(data.prefixes.some((p) => p.cidr === '149.112.89.0/24'));
    assert.ok(data.rdns.some((r) => r.hostname === 'legacy.fiberifi.com'));
    const byName = await admin.get('/api/admin/search?q=globex');
    assert.equal(byName.data.customers.length, 1);
    const wildcard = await admin.get(`/api/admin/search?q=${encodeURIComponent('%')}`);
    assert.equal(wildcard.data.prefixes.length, 0, 'LIKE wildcards are literal');
  });

  test('CSV exports neutralise spreadsheet formulas', async () => {
    const { data: list } = await globex.get('/api/subnets');
    const subnet = list.subnets[0];
    const ip = subnet.family === 4 ? subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 2)) : '2607:9340:1::9';
    const saved = await globex.put(`/api/subnets/${subnet.id}/addresses/${encodeURIComponent(ip)}`, { description: '=HYPERLINK("http://x")' });
    assert.equal(saved.status, 200);
    const csv = await globex.get(`/api/subnets/${subnet.id}/export.csv`);
    assert.match(csv.data, /"'=HYPERLINK/);
  });

  test('cross-site writes are refused', async () => {
    const res = await admin.post('/api/admin/prefixes', { cidr: '10.1.0.0/16' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'bad_origin');
  });

  test('disabling an account ends its sessions at once', async () => {
    const temp = await newCustomer('Initech', 'noc@initech.example');
    assert.equal((await temp.client.get('/api/subnets')).status, 200);
    await admin.patch(`/api/admin/users/${temp.id}`, { disabled: true });
    assert.equal((await temp.client.get('/api/subnets')).status, 401);
  });

  describe('team members', () => {
    let owner;
    let ownerId;
    let subnet;
    let editor;
    let viewer;
    let viewerId;

    async function addMember(by, email, access) {
      const { status, data } = await by.post('/api/team', { name: email.split('@')[0], email, access });
      assert.equal(status, 201, JSON.stringify(data));
      const client = new Client(base);
      await client.post('/api/auth/login', { email, password: data.temporaryPassword });
      await client.post('/api/auth/change-password', { currentPassword: data.temporaryPassword, newPassword: `${email}-long-password` });
      return { client, id: data.member.id };
    }

    before(async () => {
      ({ client: owner, id: ownerId } = await newCustomer('Umbrella', 'owner@umbrella.example'));
      const { data: tree } = await admin.get('/api/admin/prefixes');
      subnet = await allocate(tree.prefixes.find((p) => p.cidr === '149.112.89.0/24').id, 28, ownerId);
    });

    test('the owner adds members, who share the account subnets', async () => {
      ({ client: editor } = await addMember(owner, 'editor@umbrella.example', 'admin'));
      ({ client: viewer, id: viewerId } = await addMember(owner, 'viewer@umbrella.example', 'read_only'));
      for (const client of [editor, viewer]) {
        const { data } = await client.get('/api/subnets');
        assert.deepEqual(data.subnets.map((s) => s.cidr), [subnet.cidr]);
        assert.equal((await client.get(`/api/subnets/${subnet.id}/addresses`)).status, 200);
      }
      const me = await viewer.get('/api/auth/me');
      assert.equal(me.data.user.canEdit, false);
      assert.equal(me.data.user.accountName, 'Umbrella');
    });

    test('members cannot see other customers', async () => {
      const { data } = await globex.get('/api/subnets');
      assert.equal((await viewer.get(`/api/subnets/${data.subnets[0].id}`)).status, 404);
      assert.equal((await editor.get(`/api/subnets/${data.subnets[0].id}`)).status, 404);
    });

    test('an admin member can edit, and a read-only member cannot', async () => {
      const ip = subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 2));
      const url = `/api/subnets/${subnet.id}/addresses/${ip}`;
      assert.equal((await editor.put(url, { hostname: 'web1' })).status, 200);

      const save = await viewer.put(url, { hostname: 'nope' });
      assert.equal(save.status, 403);
      assert.equal(save.data.error.code, 'read_only');
      assert.equal((await viewer.delete(url)).status, 403);
      assert.equal((await viewer.put(`/api/subnets/${subnet.id}/rdns/${ip}`, { hostname: 'x.umbrella.example' })).status, 403);
      assert.equal((await viewer.delete(`/api/subnets/${subnet.id}/rdns/${ip}`)).status, 403);

      assert.equal((await viewer.get(`/api/subnets/${subnet.id}/export.csv`)).status, 200);
    });

    test('a read-only member cannot manage the team', async () => {
      assert.equal((await viewer.get('/api/team')).status, 403);
      assert.equal((await viewer.post('/api/team', { name: 'X', email: 'x@u.example' })).status, 403);
    });

    test('a member cannot touch the owner or another account', async () => {
      assert.equal((await editor.patch(`/api/team/${ownerId}`, { disabled: true })).status, 404);
      assert.equal((await editor.delete(`/api/team/${ownerId}`)).status, 404);
      assert.equal((await editor.post(`/api/team/${ownerId}/reset-password`)).status, 404);
      assert.equal((await acme.patch(`/api/team/${viewerId}`, { access: 'admin' })).status, 404);
      assert.equal((await acme.delete(`/api/team/${viewerId}`)).status, 404);
    });

    test('a member cannot change their own access or remove themselves', async () => {
      const me = (await editor.get('/api/auth/me')).data.user;
      assert.equal((await editor.patch(`/api/team/${me.id}`, { access: 'read_only' })).status, 409);
      assert.equal((await editor.patch(`/api/team/${me.id}`, { disabled: true })).status, 409);
      assert.equal((await editor.delete(`/api/team/${me.id}`)).status, 409);
    });

    test('promoting a member takes effect immediately', async () => {
      assert.equal((await owner.patch(`/api/team/${viewerId}`, { access: 'admin' })).status, 200);
      assert.equal((await viewer.get('/api/team')).status, 200);
      assert.equal((await owner.patch(`/api/team/${viewerId}`, { access: 'read_only' })).status, 200);
      assert.equal((await viewer.get('/api/team')).status, 403);
    });

    test('members do not count as customers', async () => {
      const { data } = await admin.get('/api/admin/users');
      assert.ok(!data.users.some((u) => u.email === 'viewer@umbrella.example'));
      assert.equal(data.users.find((u) => u.id === ownerId).members, 2);
      const assign = await admin.post(`/api/admin/prefixes/${subnet.id}/assign`, { customerId: viewerId });
      assert.equal(assign.status, 400);
    });

    test('a Fiberifi admin can see and add members', async () => {
      const { data } = await admin.get(`/api/admin/users/${ownerId}`);
      assert.equal(data.members.length, 2);
      const added = await admin.post(`/api/admin/users/${ownerId}/members`, { name: 'Third', email: 'third@umbrella.example', access: 'read_only' });
      assert.equal(added.status, 201);
      assert.equal((await admin.post(`/api/admin/users/${viewerId}/members`, { name: 'X', email: 'y@u.example' })).status, 404);
      await admin.delete(`/api/admin/users/${added.data.member.id}`);
    });

    test('disabling a member ends their session', async () => {
      const temp = await addMember(owner, 'temp@umbrella.example', 'read_only');
      assert.equal((await owner.patch(`/api/team/${temp.id}`, { disabled: true })).status, 200);
      assert.equal((await temp.client.get('/api/subnets')).status, 401);
      assert.equal((await owner.delete(`/api/team/${temp.id}`)).status, 200);
    });

    test('disabling the customer cuts off the whole team', async () => {
      await admin.patch(`/api/admin/users/${ownerId}`, { disabled: true });
      assert.equal((await viewer.get('/api/subnets')).status, 401);
      const login = await new Client(base).post('/api/auth/login', { email: 'viewer@umbrella.example', password: 'viewer@umbrella.example-long-password' });
      assert.equal(login.status, 401);
      await admin.patch(`/api/admin/users/${ownerId}`, { disabled: false });
    });

    test('deleting a customer deletes their team', async () => {
      await admin.post(`/api/admin/prefixes/${subnet.id}/unassign`, {});
      assert.equal((await admin.delete(`/api/admin/users/${ownerId}`)).status, 200);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%umbrella.example'`).get().n, 0);
    });
  });

  describe('datacenters', () => {
    test('customers cannot reach them', async () => {
      assert.equal((await acme.get('/api/admin/datacenters')).status, 403);
    });

    test('names are required and unique', async () => {
      assert.equal((await admin.post('/api/admin/datacenters', { name: '' })).status, 400);
      assert.equal((await admin.post('/api/admin/datacenters', { name: 'pittsburgh 1' })).status, 409);
    });

    test('allocation requires a datacenter and VLAN is optional', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const parent = tree.prefixes.find((p) => p.cidr === '206.168.244.0/22');
      const missing = await admin.post(`/api/admin/prefixes/${parent.id}/allocate`, { length: 30 });
      assert.equal(missing.status, 400);
      assert.equal(missing.data.error.field, 'datacenterId');
      const bad = await admin.post(`/api/admin/prefixes/${parent.id}/allocate`, { length: 30, datacenterId: 99999 });
      assert.equal(bad.status, 400);
      const ok = await admin.post(`/api/admin/prefixes/${parent.id}/allocate`, { length: 30, datacenterId });
      assert.equal(ok.status, 201);
      assert.equal(ok.data.prefix.datacenter.name, 'Pittsburgh 1');
      assert.equal(ok.data.prefix.vlan, null);
      await admin.delete(`/api/admin/prefixes/${ok.data.prefix.id}`);
    });

    test('customers see the datacenter of their subnet', async () => {
      const { data } = await acme.get('/api/subnets');
      assert.equal(data.subnets[0].datacenter.name, 'Pittsburgh 1');
    });

    test('a datacenter in use cannot be deleted', async () => {
      const res = await admin.delete(`/api/admin/datacenters/${datacenterId}`);
      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, 'in_use');
      const detail = await admin.get(`/api/admin/datacenters/${datacenterId}`);
      assert.ok(detail.data.prefixes.length > 0);
    });

    test('an unused datacenter can be edited and deleted', async () => {
      const { data } = await admin.post('/api/admin/datacenters', { name: 'Ashburn', code: 'IAD' });
      const edited = await admin.patch(`/api/admin/datacenters/${data.datacenter.id}`, { address: '21715 Filigree Ct' });
      assert.equal(edited.data.datacenter.code, 'IAD');
      assert.equal(edited.data.datacenter.address, '21715 Filigree Ct');
      assert.equal((await admin.delete(`/api/admin/datacenters/${data.datacenter.id}`)).status, 200);
    });

    test('search and export use the datacenter name', async () => {
      const found = await admin.get('/api/admin/search?q=Pittsburgh');
      assert.ok(found.data.prefixes.length > 0);
      const csv = await admin.get('/api/admin/prefixes/export.csv');
      assert.match(csv.data, /datacenter/);
      assert.match(csv.data, /Pittsburgh 1/);
    });
  });

  describe('drill-down and nesting', () => {
    let block;
    const explore = (cidr, length) => admin.get(`/api/admin/explore?cidr=${encodeURIComponent(cidr)}${length ? `&length=${length}` : ''}`);

    test('a /22 opens into /24s, and blocks need not exist as prefixes', async () => {
      const { data } = await explore('206.168.244.0/22');
      assert.equal(data.kind, 'blocks');
      assert.equal(data.length, 24);
      assert.deepEqual(data.rows.map((r) => r.cidr), ['206.168.244.0/24', '206.168.245.0/24', '206.168.246.0/24', '206.168.247.0/24']);
      assert.equal(data.rows[1].state, 'free');
      assert.equal(data.rows[1].prefixId, null);
    });

    test('every level down to /32 can be opened', async () => {
      assert.equal((await explore('149.112.89.0/24')).data.length, 28);
      const addresses = await explore('149.112.89.0/28', 32);
      assert.equal(addresses.data.kind, 'addresses');
      assert.equal(addresses.data.rows.length, 16);
      assert.equal((await explore('149.112.89.2/31', 32)).data.rows.length, 2);
      assert.equal((await explore('149.112.89.2/32')).status, 400);
    });

    test('blocks show live assignments, at the block and above it', async () => {
      const { data } = await explore('149.112.89.0/24', 29);
      const exact = data.rows.find((r) => r.cidr === '149.112.89.8/29');
      assert.equal(exact.state, 'assigned');
      assert.equal(exact.customer.id, globexId);
      const inner = (await explore('149.112.89.8/29', 30)).data.rows[0];
      assert.equal(inner.state, 'assigned', 'a block inside an assigned subnet shows the owner too');
      assert.equal(inner.customer.id, globexId);
      assert.equal(inner.prefixId, null);
      assert.equal((await explore('206.168.244.0/22')).data.rows[0].state, 'partial');
      const upper = (await explore('206.168.244.0/22')).data.rows[0];
      assert.ok(upper.customersInside.length > 0);
    });

    test('address rows lock the gateway and broadcast and name the owner', async () => {
      const { data } = await explore('149.112.89.8/29', 32);
      const by = Object.fromEntries(data.rows.map((r) => [r.ip, r]));
      assert.equal(by['149.112.89.9'].role, 'gateway');
      assert.equal(by['149.112.89.9'].locked, false, 'admins can edit the gateway');
      assert.equal(by['149.112.89.15'].role, 'broadcast');
      assert.equal(by['149.112.89.15'].locked, true);
      assert.equal(by['149.112.89.10'].locked, false);
      assert.equal(by['149.112.89.10'].customer.id, globexId);
      assert.ok(by['149.112.89.10'].prefixId);
    });

    test('sizes are limited to 256 rows and to the range you own', async () => {
      assert.equal((await explore('206.168.244.0/22', 31)).status, 400);
      assert.equal((await explore('10.0.0.0/24')).status, 404);
      assert.equal((await acme.get('/api/admin/explore?cidr=149.112.89.0/24')).status, 403);
    });

    test('IPv6 opens by the nibble', async () => {
      const { data } = await explore('2607:9340::/32');
      assert.equal(data.length, 36);
      assert.equal(data.rows.length, 16);
    });

    test('any free block can be carved out and assigned in one step', async () => {
      const { data: found } = await explore('206.168.245.0/24', 28);
      block = found.rows[2];
      const noDc = await admin.post('/api/admin/prefixes/carve', { cidr: block.cidr });
      assert.equal(noDc.status, 400);
      const res = await admin.post('/api/admin/prefixes/carve', { cidr: block.cidr, customerId: acmeId, datacenterId });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(res.data.prefix.customer.id, acmeId);
      assert.equal((await admin.post('/api/admin/prefixes/carve', { cidr: '10.0.0.0/24', datacenterId })).status, 400);
    });

    test('admins can nest prefixes inside an assigned subnet without touching the customer', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const assigned = tree.prefixes.find((p) => p.cidr === block.cidr);
      const label = await admin.post('/api/admin/prefixes/carve', { cidr: assigned.cidr.replace(/\/28$/, '/30'), datacenterId, description: 'rack label' });
      assert.equal(label.status, 201, JSON.stringify(label.data));
      assert.equal(label.data.prefix.status, 'container');
      assert.equal((await admin.patch(`/api/admin/prefixes/${label.data.prefix.id}`, { status: 'active' })).status, 400);

      const split = await admin.post(`/api/admin/prefixes/${assigned.id}/split`, { length: 29 });
      assert.equal(split.status, 200, JSON.stringify(split.data));
      assert.equal(split.data.prefix.customer.id, acmeId, 'still assigned');
      assert.ok(split.data.prefix.gateway, 'keeps its gateway');
      assert.ok(split.data.prefix.children.every((c) => c.status === 'container'));

      // The nested /30 starts at the subnet, so nothing inside it may have become reserved.
      const third = assigned.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 3));
      assert.equal((await acme.put(`/api/subnets/${assigned.id}/addresses/${third}`, { hostname: 'still-usable' })).status, 200);
    });

    test('an address still cannot belong to two customers', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const label = tree.prefixes.find((p) => p.description === 'rack label');
      const res = await admin.post(`/api/admin/prefixes/${label.id}/assign`, { customerId: globexId });
      assert.equal(res.status, 409);
      assert.equal(res.data.error.code, 'assignment_overlap');
      const carve = await admin.post('/api/admin/prefixes/carve', { cidr: label.cidr.replace(/\/30$/, '/31'), customerId: globexId, datacenterId });
      assert.equal(carve.status, 409);
    });
  });

  describe('internal space', () => {
    let block;

    test('a block can be kept for Fiberifi straight from the drill-down', async () => {
      const res = await admin.post('/api/admin/prefixes/carve', { cidr: '206.168.246.0/24', customerId: 'internal', datacenterId, description: 'Core' });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      block = res.data.prefix;
      assert.equal(block.internal, true);
      assert.equal(block.customer, null);
      assert.equal(block.status, 'active');
      const { data } = await admin.get('/api/admin/explore?cidr=206.168.244.0/22');
      const row = data.rows.find((r) => r.cidr === '206.168.246.0/24');
      assert.equal(row.state, 'internal');
      assert.equal((await admin.get('/api/admin/explore?cidr=206.168.246.0/24&length=28')).data.rows[0].state, 'internal');
    });

    test('allocation and assignment accept it too', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const parent = tree.prefixes.find((p) => p.cidr === '149.112.89.0/24');
      const res = await admin.post(`/api/admin/prefixes/${parent.id}/allocate`, { length: 30, customerId: 'internal', datacenterId });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(res.data.prefix.internal, true);
      const free = await allocate(parent.id, 30);
      const marked = await admin.post(`/api/admin/prefixes/${free.id}/assign`, { customerId: 'internal' });
      assert.equal(marked.status, 200, JSON.stringify(marked.data));
      assert.equal(marked.data.prefix.internal, true);
    });

    test('a customer cannot be assigned over it, or see it', async () => {
      const direct = await admin.post(`/api/admin/prefixes/${block.id}/assign`, { customerId: acmeId });
      assert.equal(direct.status, 409);
      const around = await admin.post('/api/admin/prefixes/carve', { cidr: '206.168.246.0/23', customerId: acmeId, datacenterId });
      assert.equal(around.status, 409, 'a block that swallows internal space is refused');
      assert.equal(around.data.error.code, 'assignment_overlap');
      assert.equal((await acme.get(`/api/subnets/${block.id}`)).status, 404);
      assert.equal((await acme.put('/api/subnets/' + block.id + '/addresses/206.168.246.5', { hostname: 'x' })).status, 404);
    });

    test('customer space cannot be marked internal', async () => {
      const { data } = await acme.get('/api/subnets');
      const taken = await admin.post(`/api/admin/prefixes/${data.subnets[0].id}/assign`, { customerId: 'internal' });
      assert.equal(taken.status, 409);
      const single = data.subnets[0].family === 4 ? 32 : 128;
      const inside = await admin.post('/api/admin/prefixes/carve', { cidr: `${data.subnets[0].lastAddress}/${single}`, customerId: 'internal', datacenterId });
      assert.equal(inside.status, 409);
    });

    test('a customer can sit inside internal space, and the smallest assignment wins', async () => {
      const carved = await admin.post('/api/admin/prefixes/carve', { cidr: '206.168.246.16/28', customerId: acmeId, datacenterId });
      assert.equal(carved.status, 201, JSON.stringify(carved.data));
      const { data } = await admin.get('/api/admin/explore?cidr=206.168.246.0/24&length=28');
      assert.equal(data.rows[0].state, 'internal');
      assert.equal(data.rows[1].state, 'assigned');
      assert.equal(data.rows[1].customer.id, acmeId);
      const id = carved.data.prefix.id;
      assert.equal((await acme.put(`/api/subnets/${id}/addresses/206.168.246.18`, { hostname: 'mine' })).status, 200);
      assert.equal((await acme.put(`/api/subnets/${id}/addresses/206.168.246.40`, { hostname: 'ours' })).status, 400);
      assert.equal((await acme.put(`/api/subnets/${block.id}/addresses/206.168.246.40`, { hostname: 'ours' })).status, 404);
      await admin.post(`/api/admin/prefixes/${id}/unassign`, {});
      await admin.delete(`/api/admin/prefixes/${id}`);
    });

    test('a whole range can be used at its own size without subdividing it', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const range = tree.prefixes.find((p) => p.cidr === '2001:504:13a::/48');
      await admin.patch(`/api/admin/prefixes/${range.id}`, { description: 'Fiberifi allocation' });
      const hint = await admin.get(`/api/admin/prefixes/${range.id}/next-available?length=48`);
      assert.equal(hint.data.next.whole, true);
      assert.equal((await admin.post(`/api/admin/prefixes/${range.id}/allocate`, { length: 48 })).status, 400);
      const res = await admin.post(`/api/admin/prefixes/${range.id}/allocate`, { length: 48, customerId: 'internal', datacenterId, vlan: 200 });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(res.data.prefix.cidr, '2001:504:13a::/48');
      assert.equal(res.data.prefix.internal, true);
      assert.equal(res.data.prefix.datacenter.id, datacenterId);
      assert.equal(res.data.prefix.vlan, 200);
      assert.equal(res.data.prefix.description, 'Fiberifi allocation', 'a blank description keeps the old one');
      assert.equal(res.data.prefix.status, 'container');
      assert.equal(res.data.prefix.gateway, '2001:504:13a::1');

      const child = await admin.post(`/api/admin/prefixes/${range.id}/allocate`, { length: 64, customerId: acmeId, datacenterId });
      assert.equal(child.status, 201, 'customers can still be assigned inside it');
      await admin.post(`/api/admin/prefixes/${child.data.prefix.id}/unassign`, {});
      await admin.delete(`/api/admin/prefixes/${child.data.prefix.id}`);
    });

    test('a range with customers already inside can be marked internal', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const range = tree.prefixes.find((p) => p.cidr === '149.112.89.0/24');
      assert.ok(range.childCount > 0);
      const res = await admin.post(`/api/admin/prefixes/${range.id}/allocate`, { length: 24, customerId: 'internal', datacenterId });
      assert.equal(res.status, 201, JSON.stringify(res.data));
      const { data: subnets } = await acme.get('/api/subnets');
      assert.ok(subnets.subnets.length > 0, 'nobody loses a subnet');
      await admin.post(`/api/admin/prefixes/${range.id}/unassign`, {});
    });

    test('real subnets with gateways can live inside it', async () => {
      const child = await admin.post('/api/admin/prefixes/carve', { cidr: '206.168.246.0/30', datacenterId });
      assert.equal(child.status, 201, JSON.stringify(child.data));
      assert.equal(child.data.prefix.status, 'active');
      assert.equal(child.data.prefix.gateway, '206.168.246.1');
    });

    test('gateway and broadcast stay locked in internal space', async () => {
      assert.equal((await admin.put(`/api/subnets/${block.id}/addresses/206.168.246.255`, { hostname: 'x' })).status, 403);
      assert.equal((await admin.put(`/api/subnets/${block.id}/rdns/206.168.246.255`, { hostname: 'x.fiberifi.example' })).status, 403);
    });

    test('releasing keeps its records and allows assignment again', async () => {
      assert.equal((await admin.put(`/api/subnets/${block.id}/addresses/206.168.246.9`, { hostname: 'router1' })).status, 200);
      const res = await admin.post(`/api/admin/prefixes/${block.id}/unassign`, {});
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.prefix.internal, false);
      assert.equal(res.data.recordsRemoved, 0);
      assert.equal(res.data.prefix.recordCount, 1);
      assert.equal((await admin.post(`/api/admin/prefixes/${block.id}/assign`, { customerId: acmeId })).status, 200);
      const back = await admin.post(`/api/admin/prefixes/${block.id}/unassign`, {});
      assert.equal(back.status, 200);
    });

    test('customers cannot mark anything internal', async () => {
      assert.equal((await acme.post('/api/admin/prefixes/carve', { cidr: '206.168.247.0/24', customerId: 'internal' })).status, 403);
    });
  });

  describe('every prefix has a gateway and broadcast', () => {
    const rows = async (cidr, length) => {
      const { data } = await admin.get(`/api/admin/explore?cidr=${encodeURIComponent(cidr)}&length=${length}`);
      return Object.fromEntries(data.rows.map((r) => [r.ip, r]));
    };

    test('a /22 has its gateway on .1 and broadcast on the last address', async () => {
      const { data } = await admin.get('/api/admin/prefixes');
      const range = data.prefixes.find((p) => p.cidr === '206.168.244.0/22');
      assert.equal(range.status, 'container');
      assert.equal(range.gateway, '206.168.244.1');
      assert.equal(range.broadcast, '206.168.247.255');
      assert.equal(range.network, '206.168.244.0');
      assert.equal(range.usable, '1,021');

      const end = await rows('206.168.247.240/28', 32);
      assert.equal(end['206.168.247.255'].role, 'broadcast');
      assert.equal(end['206.168.247.255'].locked, true);
      assert.equal(end['206.168.247.254'].role, null);
    });

    test('the gateway stays editable and can be moved, and broadcast cannot', async () => {
      const { data } = await admin.get('/api/admin/prefixes');
      const range = data.prefixes.find((p) => p.cidr === '2607:9340::/32');
      assert.equal(range.gateway, '2607:9340::1');
      assert.equal(range.broadcast, null, 'IPv6 has no broadcast');

      const target = data.prefixes.find((p) => p.cidr === '206.168.244.0/22');
      const url = `/api/subnets/${target.id}/addresses`;
      assert.equal((await admin.put(`${url}/206.168.247.255`, { hostname: 'x' })).status, 403);
      const moved = await admin.patch(`/api/admin/prefixes/${target.id}`, { gateway: '206.168.247.254' });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      assert.equal(moved.data.prefix.gateway, '206.168.247.254');
      assert.equal((await rows('206.168.247.240/28', 32))['206.168.247.254'].role, 'gateway');
      assert.equal((await admin.patch(`/api/admin/prefixes/${target.id}`, { gateway: '206.168.247.255' })).status, 400);
      await admin.patch(`/api/admin/prefixes/${target.id}`, { gateway: '' });
    });

    test('nobody can publish a PTR on the /22 gateway or broadcast', async () => {
      const { data } = await admin.get('/api/admin/prefixes');
      const target = data.prefixes.find((p) => p.cidr === '149.112.89.0/24');
      assert.equal((await admin.put(`/api/subnets/${target.id}/rdns/149.112.89.255`, { hostname: 'a.fiberifi.example' })).status, 403);
    });

    test('the smallest prefix decides, so a /31 keeps its usable address', async () => {
      const edge = await admin.post('/api/admin/prefixes/carve', { cidr: '206.168.247.254/31', datacenterId, customerId: acmeId });
      assert.equal(edge.status, 201, JSON.stringify(edge.data));
      const id = edge.data.prefix.id;
      assert.equal((await acme.put(`/api/subnets/${id}/addresses/206.168.247.255`, { hostname: 'cpe' })).status, 200, 'the /22 broadcast does not take it');
      assert.equal((await acme.put(`/api/subnets/${id}/addresses/206.168.247.254`, { hostname: 'x' })).status, 403, 'the /31 gateway stays locked');
      await admin.post(`/api/admin/prefixes/${id}/unassign`, {});
      await admin.delete(`/api/admin/prefixes/${id}`);
    });

    test('a label inside a customer subnet reserves nothing and shows no gateway', async () => {
      const { data: mine } = await acme.get('/api/subnets');
      const subnet = mine.subnets.find((s) => s.family === 4 && s.length <= 28);
      const third = subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 5));
      const label = await admin.post('/api/admin/prefixes/carve', { cidr: `${subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 4))}/30`, datacenterId });
      assert.equal(label.status, 201, JSON.stringify(label.data));
      assert.equal(label.data.prefix.gateway, null);
      assert.equal(label.data.prefix.broadcast, null);
      assert.equal((await acme.put(`/api/subnets/${subnet.id}/addresses/${third}`, { hostname: 'usable' })).status, 200);
      await admin.delete(`/api/admin/prefixes/${label.data.prefix.id}`);
    });

    test('customers still see the gateway locked', async () => {
      const { data } = await acme.get('/api/subnets');
      const subnet = data.subnets.find((s) => s.family === 4);
      assert.equal((await acme.put(`/api/subnets/${subnet.id}/addresses/${subnet.gateway}`, { hostname: 'x' })).status, 403);
      const list = await acme.get(`/api/subnets/${subnet.id}/addresses`);
      assert.equal(list.data.rows.find((r) => r.ip === subnet.gateway).locked, true);
    });
  });

  describe('prefix ownership', () => {
    let mine;
    let theirs;

    before(async () => {
      const a = (await acme.get('/api/subnets')).data.subnets;
      mine = a.find((s) => s.family === 4);
      theirs = (await globex.get('/api/subnets')).data.subnets.find((s) => s.family === 4);
      assert.ok(mine && theirs);
    });

    test('customers cannot call a single admin prefix or settings route', async () => {
      const id = mine.id;
      const attempts = [
        ['post', '/api/admin/prefixes', { cidr: '10.9.0.0/16' }],
        ['patch', `/api/admin/prefixes/${id}`, { description: 'mine now' }],
        ['patch', `/api/admin/prefixes/${theirs.id}`, { description: 'hijack' }],
        ['delete', `/api/admin/prefixes/${id}`],
        ['post', `/api/admin/prefixes/${id}/assign`, { customerId: acmeId }],
        ['post', `/api/admin/prefixes/${theirs.id}/assign`, { customerId: acmeId }],
        ['post', `/api/admin/prefixes/${theirs.id}/unassign`, {}],
        ['post', `/api/admin/prefixes/${id}/allocate`, { length: 30 }],
        ['post', `/api/admin/prefixes/${id}/split`, { length: 30 }],
        ['put', '/api/admin/settings', { ttl: 60 }],
        ['post', '/api/admin/rdns/sync', {}],
        ['post', '/api/admin/datacenters', { name: 'X' }],
      ];
      for (const [method, url, body] of attempts) {
        const res = await acme[method](url, body);
        assert.equal(res.status, 403, `${method} ${url}`);
      }
    });

    test('there is no customer route that changes a prefix itself', async () => {
      for (const method of ['put', 'patch', 'post', 'delete']) {
        const res = await acme[method](`/api/subnets/${mine.id}`, {});
        assert.equal(res.status, 404, method);
      }
      const before = (await admin.get(`/api/admin/prefixes/${mine.id}`)).data.prefix;
      assert.equal(before.customer.id, acmeId);
    });

    test('another customer subnet is invisible by id and by address', async () => {
      const ip = theirs.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 3));
      const writes = [
        ['put', `/api/subnets/${theirs.id}/addresses/${ip}`, { hostname: 'x' }],
        ['delete', `/api/subnets/${theirs.id}/addresses/${ip}`],
        ['put', `/api/subnets/${theirs.id}/rdns/${ip}`, { hostname: 'x.evil.example' }],
        ['delete', `/api/subnets/${theirs.id}/rdns/${ip}`],
      ];
      for (const [method, url, body] of writes) assert.equal((await acme[method](url, body)).status, 404, url);
      // Their address through my subnet id.
      assert.equal((await acme.put(`/api/subnets/${mine.id}/addresses/${ip}`, { hostname: 'x' })).status, 400);
      assert.equal((await acme.put(`/api/subnets/${mine.id}/rdns/${ip}`, { hostname: 'x.evil.example' })).status, 400);
    });

    test('alternate spellings of an address do not get past the range check', async () => {
      const ip = theirs.firstAddress.replace(/\d+$/, (n) => String(Number(n) + 3));
      const tricks = [`::ffff:${ip}`, `${ip}%25eth0`, `${ip}/32`, `0${ip}`, '2607:9340:ffff::1'];
      const count = cf.state.records.length;
      for (const trick of tricks) {
        const res = await acme.put(`/api/subnets/${mine.id}/rdns/${encodeURIComponent(trick)}`, { hostname: 'x.evil.example' });
        assert.equal(res.status, 400, trick);
      }
      assert.equal(cf.state.records.length, count);
    });

    test('a subnet id that does not exist looks the same as someone else subnet', async () => {
      const missing = await acme.get('/api/subnets/999999');
      const foreign = await acme.get(`/api/subnets/${theirs.id}`);
      assert.deepEqual(missing.data, foreign.data);
    });
  });

  describe('PTRs on usable addresses only', () => {
    let subnet;

    before(async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      subnet = await allocate(tree.prefixes.find((p) => p.cidr === '149.112.89.0/24').id, 29);
    });

    const addressAt = (offset) => subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + offset));
    const url = (ip) => `/api/subnets/${subnet.id}/rdns/${ip}`;

    test('nobody can set one on the network, gateway or broadcast address, admins included', async () => {
      const count = cf.state.records.length;
      for (const offset of [0, 1, 7]) {
        const res = await admin.put(url(addressAt(offset)), { hostname: 'gw.fiberifi.example' });
        assert.equal(res.status, 403, String(offset));
        assert.equal(res.data.error.code, 'locked');
      }
      assert.equal(cf.state.records.length, count);
    });

    test('a usable address still works', async () => {
      const res = await admin.put(url(addressAt(2)), { hostname: 'ok.fiberifi.example' });
      assert.equal(res.status, 200, JSON.stringify(res.data));
    });

    test('an admin cannot move the gateway onto an address with a PTR', async () => {
      const ok = await admin.put(url(addressAt(3)), { hostname: 'host.fiberifi.example' });
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      const moved = await admin.patch(`/api/admin/prefixes/${subnet.id}`, { gateway: addressAt(3) });
      assert.equal(moved.status, 400);
      assert.equal(moved.data.error.field, 'gateway');
    });

    test('a subnet with a PTR on a reserved address cannot be assigned until it is removed', async () => {
      // A sync can bring in a PTR that was published outside the panel.
      db.prepare(
        `INSERT INTO rdns_records (family, ip_hex, ip, ptr_name, hostname, zone_id, zone_name, record_id, ttl, updated_by)
         SELECT 4, ip, ?, 'x', 'legacy-gw.example', 'z89', 'z', 'legacy', 300, 'sync' FROM (SELECT ? AS ip)`,
      ).run(addressAt(1), (await import('../src/lib/ip.js')).toHex((await import('../src/lib/ip.js')).parseIp(addressAt(1)).value));

      const blocked = await admin.post(`/api/admin/prefixes/${subnet.id}/assign`, { customerId: acmeId });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.error.code, 'ptr_on_reserved');

      const removed = await admin.delete(url(addressAt(1)));
      assert.equal(removed.status, 200, JSON.stringify(removed.data));
      assert.equal((await admin.post(`/api/admin/prefixes/${subnet.id}/assign`, { customerId: acmeId })).status, 200);
    });

    test('a customer cannot remove a PTR on a reserved address', async () => {
      assert.equal((await acme.delete(url(addressAt(1)))).status, 403);
    });

    test('/31 and /32 subnets keep their usable addresses', async () => {
      const { data: tree } = await admin.get('/api/admin/prefixes');
      const parent = tree.prefixes.find((p) => p.cidr === '149.112.89.0/24').id;
      const p2p = await allocate(parent, 31);
      assert.equal((await admin.put(`/api/subnets/${p2p.id}/rdns/${p2p.firstAddress}`, { hostname: 'a.fiberifi.example' })).status, 403);
      assert.equal((await admin.put(`/api/subnets/${p2p.id}/rdns/${p2p.lastAddress}`, { hostname: 'b.fiberifi.example' })).status, 200);
      const host = await allocate(parent, 32);
      assert.equal((await admin.put(`/api/subnets/${host.id}/rdns/${host.firstAddress}`, { hostname: 'c.fiberifi.example' })).status, 200);
    });
  });

  describe('deleting an account removes its PTRs', () => {
    let owner;
    let ownerId;
    let member;
    let memberId;
    let subnet;
    const ip = (offset) => subnet.firstAddress.replace(/\d+$/, (n) => String(Number(n) + offset));

    before(async () => {
      ({ client: owner, id: ownerId } = await newCustomer('Wayne', 'owner@wayne.example'));
      const { data: tree } = await admin.get('/api/admin/prefixes');
      subnet = await allocate(tree.prefixes.find((p) => p.cidr === '149.112.89.0/24').id, 28, ownerId);
      const added = await owner.post('/api/team', { name: 'Member', email: 'member@wayne.example', access: 'admin' });
      memberId = added.data.member.id;
      member = new Client(base);
      await member.post('/api/auth/login', { email: 'member@wayne.example', password: added.data.temporaryPassword });
      await member.post('/api/auth/change-password', { currentPassword: added.data.temporaryPassword, newPassword: 'member-long-password' });

      assert.equal((await owner.put(`/api/subnets/${subnet.id}/rdns/${ip(2)}`, { hostname: 'owner.wayne.example' })).status, 200);
      assert.equal((await member.put(`/api/subnets/${subnet.id}/rdns/${ip(3)}`, { hostname: 'member.wayne.example' })).status, 200);
      assert.equal((await admin.put(`/api/subnets/${subnet.id}/rdns/${ip(2)}`, { hostname: 'fixed.wayne.example' })).status, 200);
    });

    const live = () => cf.state.records.filter((r) => r.content.endsWith('wayne.example')).length;

    test('removing one team member keeps their PTRs on the account', async () => {
      assert.equal((await owner.delete(`/api/team/${memberId}`)).status, 200);
      assert.equal(live(), 2);
    });

    test('the confirmation knows how many will go', async () => {
      assert.equal((await admin.get(`/api/admin/users/${ownerId}`)).data.ptrCount, 2);
    });

    test('a failed Cloudflare removal keeps the account so nothing is orphaned', async () => {
      // Keep the PTRs through the unassign, the way the unticked box does.
      assert.equal((await admin.post(`/api/admin/prefixes/${subnet.id}/unassign`, { removeRdns: false })).status, 200);
      assert.equal(live(), 2);
      cf.state.failDeletes = true;
      const res = await admin.delete(`/api/admin/users/${ownerId}`);
      cf.state.failDeletes = false;
      assert.equal(res.status, 502);
      assert.equal(res.data.error.code, 'ptr_removal_failed');
      assert.equal((await admin.get(`/api/admin/users/${ownerId}`)).status, 200);
      assert.equal(live(), 2);
    });

    test('deleting the account removes every PTR it or its team created', async () => {
      const res = await admin.delete(`/api/admin/users/${ownerId}`);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.ptrRemoved, 2);
      assert.equal(live(), 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rdns_records WHERE account_id = ?').get(ownerId).n, 0);
    });

    test('PTRs belonging to other accounts are untouched', async () => {
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM rdns_records').get().n > 0);
      assert.ok(cf.state.records.some((r) => r.content === 'mail.acme.example'));
    });

    test('deleting a Fiberifi admin leaves infrastructure PTRs alone', async () => {
      const { data } = await admin.post('/api/admin/users', { name: 'Temp', email: 'temp-admin@fiberifi.example', role: 'admin' });
      const before = cf.state.records.length;
      assert.equal((await admin.delete(`/api/admin/users/${data.user.id}`)).status, 200);
      assert.equal(cf.state.records.length, before);
    });
  });

  test('the last admin cannot be removed', async () => {
    const me = (await admin.get('/api/auth/me')).data.user;
    assert.equal((await admin.delete(`/api/admin/users/${me.id}`)).status, 409);
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { disabled: true })).status, 409);
  });

  test('repeated bad logins are rate limited', async () => {
    const anon = new Client(base);
    let last;
    for (let i = 0; i < 10; i += 1) last = await anon.post('/api/auth/login', { email: 'x@y.example', password: 'wrong' });
    assert.equal(last.status, 429);
  });

  test('every change lands in the audit log', async () => {
    const { data } = await admin.get('/api/admin/audit?q=rdns');
    assert.ok(data.entries.some((e) => e.action === 'rdns.set' && e.actor === 'noc@acme.example'));
  });

  test('passwords are never stored or returned in the clear', async () => {
    const { data } = await admin.get('/api/admin/users');
    assert.ok(!JSON.stringify(data).includes('password_hash'));
    const row = db.prepare('SELECT password_hash FROM users LIMIT 1').get();
    assert.match(row.password_hash, /^scrypt\$/);
  });
});

test('a tiny allocation is not reported as empty', async () => {
  const { createIpam } = await import('../src/ipam.js');
  const db = openDatabase(':memory:');
  await seed(db, { adminEmail: 'a@b.example', adminPassword: 'x'.repeat(12), production: false }, () => {});
  const ipam = createIpam(db);
  const parent = ipam.listPrefixes().find((p) => p.cidr === '2607:9340::/32');
  const dc = Number(db.prepare(`INSERT INTO datacenters (name) VALUES ('Test')`).run().lastInsertRowid);
  ipam.allocate(parent.id, { length: 48, datacenterId: dc });
  const { pct } = ipam.getPrefix(parent.id).utilization;
  assert.ok(pct > 0 && pct < 0.01, String(pct));
  db.close();
});

test('upgrading a live database keeps everything and turns sites into datacenters', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO users (id, role, email, name, password_hash) VALUES (1, 'customer', 'c@x.example', 'C', 'h');
    INSERT INTO prefixes (family, cidr, length, start_hex, end_hex, site, customer_id, vlan) VALUES
      (4, '10.0.0.0/24', 24, 'a', 'b', 'PIT1', 1, 100),
      (4, '10.0.1.0/24', 24, 'c', 'd', 'pit1', NULL, NULL),
      (4, '10.0.2.0/24', 24, 'e', 'f', 'IAD', NULL, NULL),
      (4, '10.0.3.0/24', 24, 'g', 'h', '', NULL, NULL);
    INSERT INTO rdns_records (family, ip_hex, ip, ptr_name, hostname, zone_id, zone_name, record_id, ttl, updated_by) VALUES
      (4, '5', '10.0.0.5', 'p', 'a.example', 'z', 'z', 'r', 300, 'c@x.example'),
      (4, '6', '10.0.0.6', 'q', 'b.example', 'z', 'z', 's', 300, 'admin@fiberifi.com');
  `);

  migrate(db);
  migrate(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT internal FROM prefixes LIMIT 1').get().internal, 0);
  assert.equal(db.prepare('SELECT account_id FROM rdns_records WHERE ip = ?').get('10.0.0.5').account_id, 1);
  assert.equal(db.prepare('SELECT account_id FROM rdns_records WHERE ip = ?').get('10.0.0.6').account_id, null);
  assert.deepEqual(db.prepare('SELECT name FROM datacenters ORDER BY name').all().map((d) => d.name), ['IAD', 'PIT1']);
  const rows = db.prepare('SELECT p.cidr, p.vlan, p.customer_id, d.name FROM prefixes p LEFT JOIN datacenters d ON d.id = p.datacenter_id ORDER BY p.cidr').all();
  assert.deepEqual(rows.map((r) => r.name), ['PIT1', 'PIT1', 'IAD', null]);
  assert.equal(rows[0].customer_id, 1);
  assert.equal(rows[0].vlan, 100);
  assert.ok(!db.prepare('PRAGMA table_info(prefixes)').all().some((c) => c.name === 'site'));
  const user = db.prepare('SELECT parent_id, access FROM users').get();
  assert.equal(user.parent_id, null);
  db.close();
});
