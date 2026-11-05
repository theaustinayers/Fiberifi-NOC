import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatIp,
  freeBlocks,
  ipFromPtr,
  IpError,
  nextAvailable,
  parseCidr,
  parseIp,
  ptrName,
  rangeToCidrs,
  reverseZonesFor,
  sizeLabel,
  subnetRoles,
} from '../src/lib/ip.js';

test('the four default ranges parse and normalise', () => {
  assert.equal(parseCidr('2001:504:13A::/48').cidr, '2001:504:13a::/48');
  assert.equal(parseCidr('2607:9340::/32').cidr, '2607:9340::/32');
  assert.equal(parseCidr('149.112.89.0/24').cidr, '149.112.89.0/24');
  assert.equal(parseCidr('206.168.244.0/22').cidr, '206.168.244.0/22');
});

test('host bits are rejected with the correction', () => {
  assert.throws(() => parseCidr('206.168.245.0/22'), /Did you mean 206\.168\.244\.0\/22/);
});

test('bad input is rejected', () => {
  for (const bad of ['', '1.2.3.4', '1.2.3.4/33', '1.2.3.4/x', '1.2.3/24', '::1/129', 'fe80::1%eth0/64', '10.0.0.0/4']) {
    assert.throws(() => parseCidr(bad), IpError, bad);
  }
});

test('IPv6 text form follows RFC 5952', () => {
  const round = (s) => {
    const { family, value } = parseIp(s);
    return formatIp(family, value);
  };
  assert.equal(round('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(round('2001:db8:0:1:1:1:1:1'), '2001:db8:0:1:1:1:1:1');
  assert.equal(round('2001:0:0:1:0:0:0:1'), '2001:0:0:1::1');
  assert.equal(round('::'), '::');
  assert.equal(round('::1'), '::1');
  assert.equal(round('1::'), '1::');
  assert.equal(round('::ffff:192.0.2.1'), '::ffff:c000:201');
});

test('IPv4 roles', () => {
  const r = subnetRoles(parseCidr('149.112.89.0/29'));
  assert.equal(formatIp(4, r.network), '149.112.89.0');
  assert.equal(formatIp(4, r.gateway), '149.112.89.1');
  assert.equal(formatIp(4, r.broadcast), '149.112.89.7');
});

test('/31 and /32 have no network or broadcast address', () => {
  const p2p = subnetRoles(parseCidr('149.112.89.0/31'));
  assert.equal(p2p.network, null);
  assert.equal(p2p.broadcast, null);
  assert.equal(formatIp(4, p2p.gateway), '149.112.89.0');
  assert.deepEqual(subnetRoles(parseCidr('149.112.89.5/32')), { network: null, gateway: null, broadcast: null });
});

test('IPv6 has no broadcast', () => {
  const r = subnetRoles(parseCidr('2607:9340:1::/48'));
  assert.equal(r.broadcast, null);
  assert.equal(formatIp(6, r.gateway), '2607:9340:1::1');
});

test('an admin gateway override wins', () => {
  const p = parseCidr('149.112.89.0/24');
  const r = subnetRoles({ ...p, gateway: parseIp('149.112.89.254').value });
  assert.equal(formatIp(4, r.gateway), '149.112.89.254');
});

test('PTR names', () => {
  assert.equal(ptrName(4, parseIp('149.112.89.10').value), '10.89.112.149.in-addr.arpa');
  assert.equal(
    ptrName(6, parseIp('2607:9340::1').value),
    '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.3.9.7.0.6.2.ip6.arpa',
  );
});

test('PTR names round-trip and partial names are refused', () => {
  for (const s of ['149.112.89.10', '2607:9340::1', '2001:504:13a:ffff::abcd']) {
    const ip = parseIp(s);
    assert.equal(ipFromPtr(ptrName(ip.family, ip.value)).value, ip.value);
  }
  assert.equal(ipFromPtr('89.112.149.in-addr.arpa'), null);
  assert.equal(ipFromPtr('0.4.3.9.7.0.6.2.ip6.arpa'), null);
  assert.equal(ipFromPtr('example.com'), null);
});

test('reverse zones match the delegation boundaries of the default ranges', () => {
  assert.deepEqual(reverseZonesFor(parseCidr('149.112.89.0/24')), ['89.112.149.in-addr.arpa']);
  assert.deepEqual(reverseZonesFor(parseCidr('206.168.244.0/22')), [
    '244.168.206.in-addr.arpa',
    '245.168.206.in-addr.arpa',
    '246.168.206.in-addr.arpa',
    '247.168.206.in-addr.arpa',
  ]);
  assert.deepEqual(reverseZonesFor(parseCidr('2607:9340::/32')), ['0.4.3.9.7.0.6.2.ip6.arpa']);
  assert.deepEqual(reverseZonesFor(parseCidr('2001:504:13a::/48')), ['a.3.1.0.4.0.5.0.1.0.0.2.ip6.arpa']);
});

test('next available skips used space and respects alignment', () => {
  const parent = parseCidr('149.112.89.0/24');
  const used = [parseCidr('149.112.89.0/29'), parseCidr('149.112.89.16/28')];
  assert.equal(nextAvailable(parent, used, 29).cidr, '149.112.89.8/29');
  assert.equal(nextAvailable(parent, used, 28).cidr, '149.112.89.32/28');
  assert.equal(nextAvailable(parent, used, 25).cidr, '149.112.89.128/25');
  assert.equal(nextAvailable(parent, [parseCidr('149.112.89.0/25'), parseCidr('149.112.89.128/25')], 30), null);
});

test('next available works in IPv6', () => {
  const parent = parseCidr('2607:9340::/32');
  assert.equal(nextAvailable(parent, [parseCidr('2607:9340::/48')], 48).cidr, '2607:9340:1::/48');
});

test('free blocks tile the unused space exactly', () => {
  const parent = parseCidr('149.112.89.0/24');
  const blocks = freeBlocks(parent, [parseCidr('149.112.89.8/29')]).map((b) => b.cidr);
  assert.deepEqual(blocks, [
    '149.112.89.0/29',
    '149.112.89.16/28',
    '149.112.89.32/27',
    '149.112.89.64/26',
    '149.112.89.128/25',
  ]);
});

test('range decomposition handles a full IPv6 span', () => {
  const p = parseCidr('2607:9340::/32');
  assert.deepEqual(rangeToCidrs(6, p.network, p.last).map((b) => b.cidr), ['2607:9340::/32']);
});

test('size labels', () => {
  assert.equal(sizeLabel(4, 22), '1,024');
  assert.equal(sizeLabel(6, 48), '65,536 × /64');
  assert.equal(sizeLabel(6, 64), '1 × /64');
  assert.equal(sizeLabel(6, 126), '4');
});
