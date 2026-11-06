import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { createMonitor } from '../src/monitor.js';
import { createNetworkMap, linkState } from '../src/netmap.js';

const SECRET = 'test-secret-test-secret-test-secret';

const session = (state) => ({ peerIp: '192.0.2.2', localIp: '192.0.2.1', remoteAs: 64500, state, admin: 'start', inUpdates: 1, outUpdates: 1, inMessages: 1, outMessages: 1, transitions: 1, stateSeconds: 60, lastError: '' });

describe('link status', () => {
  const detail = { name: 'CORE', interfaces: [{ id: 1, name: 'wg1' }], bgp: [{ peerIp: '192.0.2.2', state: 'established' }] };
  const reading = (oper) => ({ interfaces: [{ id: 1, oper, in_bps: 1000, out_bps: 2000 }] });
  const link = (overrides = {}) => ({ interface: 'wg1', bgpPeer: '', ...overrides });

  test('a tunnel that says up is still down when its BGP session is', () => {
    const down = { ...detail, bgp: [{ peerIp: '192.0.2.2', state: 'idle' }] };
    const state = linkState(link({ bgpPeer: '192.0.2.2' }), down, reading('up'));
    assert.equal(state.status, 'down');
    assert.equal(state.reason, 'BGP idle');
    assert.equal(state.basis, 'bgp');
    assert.equal(state.inBps, 1000, 'traffic still comes from the interface');
  });

  test('an established session is up', () => {
    assert.equal(linkState(link({ bgpPeer: '192.0.2.2' }), detail, reading('up')).status, 'up');
  });

  test('a session that has gone from the router is unknown, not up', () => {
    assert.equal(linkState(link({ bgpPeer: '192.0.2.99' }), detail, reading('up')).status, 'unknown');
  });

  test('without BGP the interface decides', () => {
    assert.equal(linkState(link(), detail, reading('up')).status, 'up');
    assert.equal(linkState(link(), detail, reading('down')).status, 'down');
    assert.equal(linkState(link(), detail, reading('lowerLayerDown')).status, 'down');
  });

  test('an interface that cannot say is unknown, never green', () => {
    const state = linkState(link(), detail, reading('unknown'));
    assert.equal(state.status, 'unknown');
    assert.equal(state.reason, 'Interface reports unknown');
  });

  test('a router that cannot be read proves nothing about its links', () => {
    const state = linkState(link({ bgpPeer: '192.0.2.2' }), detail, null);
    assert.equal(state.status, 'unknown');
    assert.equal(state.reason, 'CORE is not answering');
    assert.equal(state.inBps, null);
  });

  test('a link with no router, or a missing interface, is unknown', () => {
    assert.equal(linkState(link(), undefined, null).status, 'unknown');
    assert.equal(linkState(link({ interface: 'wg9' }), detail, reading('up')).status, 'unknown');
  });
});

describe('network map', () => {
  let db;
  let monitor;
  let map;
  let core;
  let edge;
  let liveFails;
  let peerState;

  const fake = () => ({
    sysName: 'vyos',
    sysDescr: 'VyOS',
    uptimeSeconds: 100,
    cpu: 10,
    memory: 40,
    load1: 0.1,
    interfaces: [{ index: 1, name: 'wg1', alias: '', speedMbps: 0, admin: 'up', oper: 'up', inOctets: 1000n, outOctets: 2000n, inErrors: 0, outErrors: 0, inDiscards: 0, outDiscards: 0 }],
    bgp: [session('established')],
  });

  before(async () => {
    db = openDatabase(':memory:');
    monitor = createMonitor(db, {
      appSecret: SECRET,
      snmpReader: async () => fake(),
      snmpLiveReader: async () => {
        if (liveFails) throw new Error('timeout');
        return { cpuTicks: null, memory: 40, interfaces: [{ index: 1, oper: 'up', inOctets: 9000n, outOctets: 9000n }], bgp: [session(peerState)] };
      },
    });
    monitor.saveSettings({ user: 'noc', authPassword: 'correct-horse-battery' });
    core = monitor.createRouter({ name: 'CORE', host: '192.0.2.1', role: 'core' });
    edge = monitor.createRouter({ name: 'EDGE', host: '192.0.2.5', role: 'edge' });
    await monitor.pollRouter(core);
    await monitor.pollRouter(edge);
    map = createNetworkMap(db, monitor);
  });
  after(() => db.close());
  beforeEach(() => {
    liveFails = false;
    peerState = 'established';
    db.exec('DELETE FROM map_nodes');
  });

  const twoSites = () => [map.createNode({ routerId: core.id }), map.createNode({ name: 'Upstream' })];

  test('a router node takes the router name, and an upstream needs one', () => {
    const [router, upstream] = twoSites();
    assert.equal(router.name, 'CORE');
    assert.equal(upstream.routerId, null);
    assert.throws(() => map.createNode({ name: '' }), /Name is required/);
  });

  test('a router can only be on the map once', () => {
    map.createNode({ routerId: core.id });
    assert.throws(() => map.createNode({ routerId: core.id }), /already on the map/);
  });

  test('new sites land apart from each other', () => {
    const [a, b] = twoSites();
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 100);
  });

  test('a position stays on the map', () => {
    const [node] = twoSites();
    map.moveNode(node.id, { x: 99999, y: -5 });
    const moved = map.listNodes().find((n) => n.id === node.id);
    assert.deepEqual([moved.x, moved.y], [1000, 0]);
    assert.throws(() => map.moveNode(node.id, { x: 'a', y: 1 }), /position/);
  });

  test('a link must be measured on a router, on an interface and session it has', () => {
    const [router, upstream] = twoSites();
    assert.throws(() => map.createLink({ fromId: upstream.id, toId: router.id, interface: 'wg1' }), /measured on a router/);
    assert.throws(() => map.createLink({ fromId: router.id, toId: router.id, interface: 'wg1' }), /different site/);
    assert.throws(() => map.createLink({ fromId: router.id, toId: upstream.id, interface: 'eth9' }), /no interface/);
    assert.throws(() => map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1', bgpPeer: '203.0.113.1' }), /no BGP session/);
    assert.equal(map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1', bgpPeer: '192.0.2.2' }).interface, 'wg1');
  });

  test('two links can join the same pair of sites', () => {
    const [router, upstream] = twoSites();
    map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1' });
    map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1', label: 'Backup' });
    assert.equal(map.listLinks().length, 2);
  });

  test('deleting a site removes its links', () => {
    const [router, upstream] = twoSites();
    map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1' });
    map.deleteNode(upstream.id);
    assert.equal(map.listLinks().length, 0);
  });

  test('a router with measured links cannot be swapped out from under them', () => {
    const [router, upstream] = twoSites();
    map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1' });
    assert.throws(() => map.updateNode(router.id, { name: 'X', routerId: edge.id }), /Delete the links/);
    assert.equal(map.updateNode(router.id, { name: 'Renamed', routerId: core.id }).name, 'Renamed');
  });

  test('the live view follows the BGP session', async () => {
    const [router, upstream] = twoSites();
    const link = map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1', bgpPeer: '192.0.2.2' });
    const first = await map.live();
    assert.equal(first.links.find((l) => l.id === link.id).status, 'up');
    assert.equal(first.nodes.find((n) => n.id === router.id).status, 'up');
    assert.equal(first.nodes.find((n) => n.id === upstream.id).status, 'none');
  });

  test('a router that stops answering turns its links unknown, not green', async () => {
    const [router, upstream] = twoSites();
    const link = map.createLink({ fromId: router.id, toId: upstream.id, interface: 'wg1', bgpPeer: '192.0.2.2' });
    await new Promise((resolve) => { setTimeout(resolve, 950); }); // Past the shared reading.
    liveFails = true;
    const view = await map.live();
    assert.equal(view.links.find((l) => l.id === link.id).status, 'unknown');
    assert.equal(view.nodes.find((n) => n.id === router.id).status, 'unknown');
  });

  test('removing a router leaves its links on the map as unknown', async () => {
    const extra = monitor.createRouter({ name: 'TEMP', host: '192.0.2.9', role: 'edge' });
    await monitor.pollRouter(extra);
    const node = map.createNode({ routerId: extra.id });
    const other = map.createNode({ name: 'Upstream' });
    const link = map.createLink({ fromId: node.id, toId: other.id, interface: 'wg1' });
    monitor.deleteRouter(extra.id);
    const view = await map.live();
    assert.equal(view.links.find((l) => l.id === link.id).reason, 'No router on this end');
  });
});
