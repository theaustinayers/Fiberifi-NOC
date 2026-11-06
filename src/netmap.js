// The network map: sites and upstreams joined by links, drawn by an admin and coloured from live readings.
// Each link is measured at its router end. WireGuard and other tunnels can report up with nothing on the far
// side, so a link tied to a BGP session takes its status from that session, and the interface only gives traffic.
import { ApiError, invalid, requiredText, text } from './validate.js';

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 620;
const SPOTS = [130, 373, 626, 870].flatMap((x) => [90, 310, 530].map((y) => ({ x, y })));
const SPOT_CLEARANCE = 100;

export function linkState(link, detail, reading) {
  const none = { inBps: null, outBps: null };
  if (!detail) return { status: 'unknown', reason: 'No router on this end', basis: 'none', ...none };
  if (!reading) return { status: 'unknown', reason: `${detail.name} is not answering`, basis: 'none', ...none };

  const known = detail.interfaces.find((iface) => iface.name === link.interface);
  const iface = known && reading.interfaces.find((row) => row.id === known.id);
  const traffic = { inBps: iface?.in_bps ?? null, outBps: iface?.out_bps ?? null };

  if (link.bgpPeer) {
    const session = detail.bgp.find((row) => row.peerIp === link.bgpPeer);
    if (!session) return { status: 'unknown', reason: 'BGP session not found', basis: 'bgp', ...traffic };
    const up = session.state === 'established';
    return { status: up ? 'up' : 'down', reason: `BGP ${session.state}`, basis: 'bgp', ...traffic };
  }
  if (!iface) return { status: 'unknown', reason: 'Interface not found', basis: 'interface', ...traffic };
  if (iface.oper === 'up') return { status: 'up', reason: 'Interface up', basis: 'interface', ...traffic };
  if (iface.oper === 'down' || iface.oper === 'lowerLayerDown') return { status: 'down', reason: 'Interface down', basis: 'interface', ...traffic };
  return { status: 'unknown', reason: `Interface reports ${iface.oper}`, basis: 'interface', ...traffic };
}

export function createNetworkMap(db, monitor) {
  const toNode = (row) => ({ id: row.id, name: row.name, routerId: row.router_id, x: row.x, y: row.y });
  const toLink = (row) => ({ id: row.id, fromId: row.from_node_id, toId: row.to_node_id, label: row.label, interface: row.interface, bgpPeer: row.bgp_peer });

  function requireNode(id) {
    const row = db.prepare('SELECT * FROM map_nodes WHERE id = ?').get(Number(id));
    if (!row) throw new ApiError(404, 'not_found', 'That site does not exist');
    return row;
  }

  function requireLink(id) {
    const row = db.prepare('SELECT * FROM map_links WHERE id = ?').get(Number(id));
    if (!row) throw new ApiError(404, 'not_found', 'That link does not exist');
    return row;
  }

  function listNodes() {
    return db.prepare('SELECT * FROM map_nodes ORDER BY name').all().map(toNode);
  }

  function listLinks() {
    return db.prepare('SELECT * FROM map_links ORDER BY id').all().map(toLink);
  }

  function freeSpot() {
    const nodes = listNodes();
    const clear = (spot) => nodes.every((node) => Math.hypot(node.x - spot.x, node.y - spot.y) >= SPOT_CLEARANCE);
    return SPOTS.find(clear) ?? { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  }

  function nodeFields(input, currentId = null) {
    const routerId = input.routerId === '' || input.routerId === null || input.routerId === undefined ? null : Number(input.routerId);
    if (routerId === null) return { name: requiredText(input.name, { max: 60, field: 'name', label: 'Name' }), routerId };

    const router = monitor.requireRouter(routerId);
    const taken = db.prepare('SELECT id FROM map_nodes WHERE router_id = ?').get(routerId);
    if (taken && taken.id !== currentId) throw invalid(`${router.name} is already on the map`, 'routerId');
    return { name: text(input.name, { max: 60, field: 'name', label: 'Name' }) || router.name, routerId };
  }

  function createNode(input) {
    const { name, routerId } = nodeFields(input);
    const { x, y } = freeSpot();
    const { lastInsertRowid } = db.prepare('INSERT INTO map_nodes (name, router_id, x, y) VALUES (?, ?, ?, ?)').run(name, routerId, x, y);
    return toNode(requireNode(lastInsertRowid));
  }

  function updateNode(id, input) {
    const node = requireNode(id);
    const { name, routerId } = nodeFields(input, node.id);
    if (routerId !== node.router_id && db.prepare('SELECT 1 FROM map_links WHERE from_node_id = ?').get(node.id)) {
      throw invalid('Delete the links measured on this router before changing it', 'routerId');
    }
    db.prepare('UPDATE map_nodes SET name = ?, router_id = ? WHERE id = ?').run(name, routerId, node.id);
    return toNode(requireNode(node.id));
  }

  function moveNode(id, input) {
    const node = requireNode(id);
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw invalid('Choose a position on the map');
    db.prepare('UPDATE map_nodes SET x = ?, y = ? WHERE id = ?').run(Math.min(MAP_WIDTH, Math.max(0, x)), Math.min(MAP_HEIGHT, Math.max(0, y)), node.id);
  }

  function deleteNode(id) {
    const node = requireNode(id);
    db.prepare('DELETE FROM map_nodes WHERE id = ?').run(node.id);
    return toNode(node);
  }

  function linkFields(input) {
    const from = requireNode(input.fromId);
    if (!from.router_id) throw invalid('A link is measured on a router, so choose one for this end', 'fromId');
    const to = requireNode(input.toId);
    if (to.id === from.id) throw invalid('Choose a different site for the other end', 'toId');

    const detail = monitor.routerDetail(from.router_id);
    const iface = requiredText(input.interface, { max: 40, field: 'interface', label: 'Interface' });
    if (!detail.interfaces.some((row) => row.name === iface)) throw invalid(`${detail.name} has no interface called ${iface}`, 'interface');
    const bgpPeer = text(input.bgpPeer, { max: 64, field: 'bgpPeer', label: 'BGP session' });
    if (bgpPeer && !detail.bgp.some((row) => row.peerIp === bgpPeer)) throw invalid(`${detail.name} has no BGP session with ${bgpPeer}`, 'bgpPeer');
    return { fromId: from.id, toId: to.id, interface: iface, bgpPeer, label: text(input.label, { max: 60, field: 'label', label: 'Name' }) };
  }

  function createLink(input) {
    const link = linkFields(input);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO map_links (from_node_id, to_node_id, label, interface, bgp_peer) VALUES (?, ?, ?, ?, ?)')
      .run(link.fromId, link.toId, link.label, link.interface, link.bgpPeer);
    return toLink(requireLink(lastInsertRowid));
  }

  function updateLink(id, input) {
    const row = requireLink(id);
    const link = linkFields(input);
    db.prepare('UPDATE map_links SET from_node_id = ?, to_node_id = ?, label = ?, interface = ?, bgp_peer = ? WHERE id = ?').run(
      link.fromId,
      link.toId,
      link.label,
      link.interface,
      link.bgpPeer,
      row.id,
    );
    return toLink(requireLink(row.id));
  }

  function deleteLink(id) {
    const row = requireLink(id);
    db.prepare('DELETE FROM map_links WHERE id = ?').run(row.id);
    return toLink(row);
  }

  async function readRouter(id) {
    try {
      return await monitor.liveSample(id);
    } catch (error) {
      if (error instanceof ApiError) return null; // Shown as unknown. A failed read proves nothing about the link.
      throw error;
    }
  }

  // Everything on the map as it is right now. The routers are read together, through the same shared
  // reading the router pages use, so watching the map adds no extra load per viewer.
  async function live() {
    const nodes = listNodes();
    const routerIds = [...new Set(nodes.map((node) => node.routerId).filter(Boolean))];
    const readings = new Map(await Promise.all(routerIds.map(async (id) => [id, await readRouter(id)])));
    const details = new Map(routerIds.map((id) => [id, monitor.routerDetail(id)]));
    const routerOf = new Map(nodes.map((node) => [node.id, node.routerId]));

    return {
      at: Date.now(),
      nodes: nodes.map((node) => {
        const detail = details.get(node.routerId);
        if (!detail) return { id: node.id, status: 'none', cpu: null };
        const reading = readings.get(node.routerId);
        const status = reading ? 'up' : detail.status === 'down' ? 'down' : 'unknown';
        return { id: node.id, status, cpu: reading?.cpu ?? null };
      }),
      links: listLinks().map((link) => {
        const routerId = routerOf.get(link.fromId);
        return { id: link.id, ...linkState(link, details.get(routerId), readings.get(routerId)) };
      }),
    };
  }

  return { listNodes, listLinks, createNode, updateNode, moveNode, deleteNode, createLink, updateLink, deleteLink, live };
}
