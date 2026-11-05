import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase, seed } from '../src/db.js';
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
    const { status, data } = await admin.post(`/api/admin/prefixes/${parentId}/allocate`, { length, customerId });
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

  test('assigned prefixes cannot be deleted or split', async () => {
    const { data: list } = await acme.get('/api/subnets');
    const id = list.subnets[0].id;
    assert.equal((await admin.delete(`/api/admin/prefixes/${id}`)).status, 409);
    assert.equal((await admin.delete(`/api/admin/prefixes/${aggregate.id}?cascade=true`)).status, 409);
    assert.equal((await admin.post(`/api/admin/prefixes/${id}/split`, { length: 30 })).status, 409);
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
    assert.equal((await admin.post(`/api/admin/prefixes/${created.data.prefix.id}/split`, { length: 27 })).status, 409);
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
  ipam.allocate(parent.id, { length: 48 });
  const { pct } = ipam.getPrefix(parent.id).utilization;
  assert.ok(pct > 0 && pct < 0.01, String(pct));
  db.close();
});
