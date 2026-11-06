// The network map. Sites and upstreams are boxes an admin places, joined by links coloured from live readings.
// Everything shown in colour is also shown in words, here and in the tables under the map.
import { ApiFailure, badge, confirmDialog, del, emptyState, formDialog, get, go, h, icon, pageHead, panel, patch, plural, post, put, table, toast } from './lib.js';
import { formatBits } from './views-routers.js';

const LIVE_MS = 3000; // Routers refresh their counters every 3 seconds, so sooner shows nothing new.
const WIDTH = 1000;
const HEIGHT = 620;
const NODE_W = 168;
const NODE_H = 58;
const PARALLEL_GAP = 74;
const ARROW_STEP = 20;
const DRAG_THRESHOLD = 4;
const CHAR_WIDTH = 6.7;
const SVG = 'http://www.w3.org/2000/svg';
const STATUS = { up: ['Up', 'good'], down: ['Down', 'bad'], unknown: ['Unknown', ''] };

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

const clamp = (value, max) => Math.min(max, Math.max(0, value));
const linkName = (link) => link.label || link.interface;
const traffic = (state) => (state?.inBps === null && state?.outBps === null) || !state ? '' : `↓ ${formatBits(state.inBps)}  ↑ ${formatBits(state.outBps)}`;

function statusBadge(state) {
  const [label, kind] = STATUS[state?.status ?? 'unknown'];
  return badge(label, kind);
}

// Curves links between the same two sites apart, so each one and its label can be read.
function linkShape(link, nodes, links) {
  const a = nodes.get(link.fromId);
  const b = nodes.get(link.toId);
  const pair = links.filter((other) => (other.fromId === link.fromId && other.toId === link.toId) || (other.fromId === link.toId && other.toId === link.fromId));
  const offset = (pair.indexOf(link) - (pair.length - 1) / 2) * PARALLEL_GAP;
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = Math.hypot(dx, dy) || 1;
  const mid = { x: (a.x + b.x) / 2 + (-dy / length) * offset, y: (a.y + b.y) / 2 + (dx / length) * offset };
  const control = { x: 2 * mid.x - (a.x + b.x) / 2, y: 2 * mid.y - (a.y + b.y) / 2 };
  return { mid, d: `M ${a.x} ${a.y} Q ${control.x} ${control.y} ${b.x} ${b.y}` };
}

function drawLink(link, nodes, links, state) {
  const { mid, d } = linkShape(link, nodes, links);
  const status = state?.status ?? 'unknown';
  const lines = [`${linkName(link)} · ${STATUS[status][0]}`, traffic(state)].filter(Boolean);
  const width = Math.max(...lines.map((line) => line.length)) * CHAR_WIDTH + 16;
  const height = lines.length * 16 + 8;
  return s(
    'g',
    {},
    s('path', { class: `map-link ${status}`, d }),
    s(
      'g',
      { class: 'map-label', transform: `translate(${mid.x} ${mid.y})` },
      s('title', {}, state?.reason ?? ''),
      s('rect', { x: -width / 2, y: -height / 2, width, height, rx: 6 }),
      ...lines.map((line, index) => {
        const label = s('text', { y: -height / 2 + 17 + index * 16, 'text-anchor': 'middle', class: index ? '' : 'name' });
        label.textContent = line;
        return label;
      }),
    ),
  );
}

function nodeDetail(node, state) {
  if (!node.routerId) return 'Upstream';
  const [label] = STATUS[state?.status ?? 'unknown'] ?? STATUS.unknown;
  return state?.cpu === null || state?.cpu === undefined ? label : `${label} · CPU ${Math.round(state.cpu)}%`;
}

async function nodeDialog(node, routers, placed) {
  const free = routers.filter((router) => !placed.has(router.id) || router.id === node?.routerId);
  return formDialog({
    title: node ? `Edit ${node.name}` : 'Add a site or upstream',
    intro: node ? undefined : 'Link it to a router to show live status. Leave the router empty for an upstream or a site you don’t poll.',
    submitLabel: node ? 'Save changes' : 'Add to map',
    fields: [
      {
        name: 'routerId',
        label: 'Router',
        type: 'select',
        value: node?.routerId ?? '',
        options: [{ value: '', label: 'None (upstream or unpolled site)' }, ...free.map((router) => ({ value: router.id, label: router.name }))],
      },
      { name: 'name', label: 'Name', value: node?.name ?? '', placeholder: 'Upstream name', hint: 'Leave blank to use the router’s name.' },
    ],
    onSubmit: (values) => (node ? patch(`/api/admin/map/nodes/${node.id}`, values) : post('/api/admin/map/nodes', values)),
  });
}

async function linkDialog(link, routerNode, nodes) {
  const { router } = await get(`/api/admin/routers/${routerNode.routerId}`);
  const others = nodes.filter((node) => node.id !== routerNode.id);
  return formDialog({
    title: link ? `Edit ${linkName(link)}` : `Add a link from ${routerNode.name}`,
    submitLabel: link ? 'Save changes' : 'Add link',
    fields: [
      { name: 'toId', label: 'Other end', type: 'select', value: link?.toId ?? '', required: true, options: [{ value: '', label: 'Choose a site' }, ...others.map((node) => ({ value: node.id, label: node.name }))] },
      {
        name: 'interface',
        label: `Interface on ${routerNode.name}`,
        type: 'select',
        value: link?.interface ?? '',
        required: true,
        options: [{ value: '', label: 'Choose an interface' }, ...router.interfaces.map((iface) => ({ value: iface.name, label: iface.alias ? `${iface.name} (${iface.alias})` : iface.name }))],
      },
      {
        name: 'bgpPeer',
        label: 'BGP session (optional)',
        type: 'select',
        value: link?.bgpPeer ?? '',
        options: [{ value: '', label: 'None: use the interface status' }, ...router.bgp.map((session) => ({ value: session.peerIp, label: `${session.label || session.description || 'Peer'} (${session.peerIp})` }))],
        hint: 'Recommended for tunnels. They can report up with nothing on the far side, so the session decides the status instead.',
      },
      { name: 'label', label: 'Name (optional)', value: link?.label ?? '', placeholder: 'Shows the interface name if blank' },
    ],
    onSubmit: (values) => {
      const body = { ...values, fromId: routerNode.id };
      return link ? patch(`/api/admin/map/links/${link.id}`, body) : post('/api/admin/map/links', body);
    },
  });
}

export async function networkMap(params, { reload }) {
  const [{ nodes: nodeList, links }, { routers }] = await Promise.all([get('/api/admin/map'), get('/api/admin/routers')]);
  const nodes = new Map(nodeList.map((node) => [node.id, node]));
  const placed = new Set(nodeList.map((node) => node.routerId).filter(Boolean));
  const routerNodes = nodeList.filter((node) => node.routerId);
  let live = { nodes: new Map(), links: new Map() };
  let dragging = false;

  const linkLayer = s('g');
  const nodeLayer = s('g');
  const canvas = s('svg', { class: 'map-svg', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'group', 'aria-label': 'Network map. The tables below list the same links and sites.' }, linkLayer, nodeLayer);
  const updated = h('span', { class: 'muted', role: 'status' }, '');
  const nodeParts = new Map();
  const linkCells = new Map();

  function drawLinks() {
    linkLayer.replaceChildren(...links.map((link) => drawLink(link, nodes, links, live.links.get(link.id))));
  }

  const save = (node) => put(`/api/admin/map/nodes/${node.id}/position`, { x: node.x, y: node.y }).catch(() => toast('That position could not be saved', 'error'));

  function place(node, group) {
    group.setAttribute('transform', `translate(${node.x} ${node.y})`);
  }

  function pointerPosition(event) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(canvas.getScreenCTM().inverse());
    return { x: clamp(point.x, WIDTH), y: clamp(point.y, HEIGHT) };
  }

  function buildNode(node) {
    const detail = s('text', { y: 16, 'text-anchor': 'middle', class: 'detail' });
    const name = s('text', { y: -4, 'text-anchor': 'middle', class: 'name' });
    name.textContent = node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name;
    const group = s(
      'g',
      { class: `map-node ${node.routerId ? 'router' : 'external'}`, tabindex: 0, role: node.routerId ? 'link' : 'img', 'aria-label': node.name },
      s('title', {}, node.routerId ? `${node.name}. Drag to move, click to open.` : `${node.name}. Drag to move.`),
      s('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: 10 }),
      name,
      detail,
    );
    place(node, group);
    nodeParts.set(node.id, { group, detail });

    let start = null;
    group.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, moved: false };
      group.setPointerCapture(event.pointerId);
    });
    group.addEventListener('pointermove', (event) => {
      if (!start) return;
      if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
      start.moved = true;
      dragging = true;
      Object.assign(node, pointerPosition(event));
      place(node, group);
      drawLinks();
    });
    group.addEventListener('pointerup', () => {
      const { moved } = start ?? {};
      start = null;
      dragging = false;
      if (moved) save(node);
      else if (node.routerId) go(`/routers/${node.routerId}`);
    });
    group.addEventListener('pointercancel', () => {
      start = null;
      dragging = false;
    });
    group.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: [-ARROW_STEP, 0], ArrowRight: [ARROW_STEP, 0], ArrowUp: [0, -ARROW_STEP], ArrowDown: [0, ARROW_STEP] }[event.key];
      if (event.key === 'Enter' && node.routerId) go(`/routers/${node.routerId}`);
      if (!step) return;
      event.preventDefault();
      node.x = clamp(node.x + step[0], WIDTH);
      node.y = clamp(node.y + step[1], HEIGHT);
      place(node, group);
      drawLinks();
      save(node);
    });
    return group;
  }

  function paint() {
    for (const node of nodeList) {
      const state = live.nodes.get(node.id);
      const { group, detail } = nodeParts.get(node.id);
      detail.textContent = nodeDetail(node, state);
      group.classList.remove('up', 'down', 'unknown');
      if (node.routerId) group.classList.add(state?.status ?? 'unknown');
    }
    for (const link of links) {
      const state = live.links.get(link.id);
      const cells = linkCells.get(link.id);
      cells.status.replaceChildren(statusBadge(state));
      cells.reason.textContent = state?.reason ?? '';
      cells.traffic.textContent = traffic(state);
    }
    if (!dragging) drawLinks();
  }

  async function refresh() {
    try {
      const data = await get('/api/admin/map/live');
      live = { nodes: new Map(data.nodes.map((row) => [row.id, row])), links: new Map(data.links.map((row) => [row.id, row])) };
      updated.textContent = `Updated ${new Date(data.at).toLocaleTimeString()}`;
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      // Old readings must not stay green.
      live = { nodes: new Map(), links: new Map() };
      updated.textContent = 'Live data is not available right now';
    }
    paint();
  }

  const addNode = async () => {
    if (await nodeDialog(null, routers, placed)) reload();
  };
  const addLink = async () => {
    if (!routerNodes.length) {
      toast('Add a router to the map first.', 'warn');
      return;
    }
    if (nodeList.length < 2) {
      toast('Add the site at the other end first.', 'warn');
      return;
    }
    const chosen = await formDialog({
      title: 'Add a link',
      intro: 'Links are measured on a router, so start from the router end.',
      submitLabel: 'Next',
      fields: [{ name: 'fromId', label: 'Router end', type: 'select', value: routerNodes[0].id, required: true, options: routerNodes.map((node) => ({ value: node.id, label: node.name })) }],
      onSubmit: (values) => values,
    });
    if (chosen && (await linkDialog(null, nodes.get(Number(chosen.fromId)), nodeList))) reload();
  };
  const editLink = async (link) => {
    if (await linkDialog(link, nodes.get(link.fromId), nodeList)) reload();
  };
  const removeLink = async (link) => {
    const done = await confirmDialog({ title: `Delete ${linkName(link)}?`, body: 'This only changes the map, not the router.', confirmLabel: 'Delete link', onConfirm: () => del(`/api/admin/map/links/${link.id}`) });
    if (done) reload();
  };
  const editNode = async (node) => {
    if (await nodeDialog(node, routers, placed)) reload();
  };
  const removeNode = async (node) => {
    const count = links.filter((link) => link.fromId === node.id || link.toId === node.id).length;
    const done = await confirmDialog({
      title: `Delete ${node.name}?`,
      body: count ? `This also deletes ${plural(count, 'link')}. It only changes the map, not the router.` : 'This only changes the map, not the router.',
      confirmLabel: 'Delete from map',
      onConfirm: () => del(`/api/admin/map/nodes/${node.id}`),
    });
    if (done) reload();
  };

  const rowActions = (edit, remove, name) =>
    h(
      'td',
      { class: 'right nowrap' },
      h('button', { class: 'btn sm', type: 'button', 'aria-label': `Edit ${name}`, onClick: edit }, 'Edit'),
      ' ',
      h('button', { class: 'btn sm danger', type: 'button', 'aria-label': `Delete ${name}`, onClick: remove }, 'Delete'),
    );

  const linkRows = links.map((link) => {
    const cells = { status: h('td', null), reason: h('td', { class: 'muted nowrap' }), traffic: h('td', { class: 'nowrap' }) };
    linkCells.set(link.id, cells);
    return h(
      'tr',
      null,
      h('td', { class: 'nowrap' }, linkName(link)),
      h('td', { class: 'nowrap' }, `${nodes.get(link.fromId).name} to ${nodes.get(link.toId).name}`),
      h('td', { class: 'mono' }, link.interface),
      cells.status,
      cells.reason,
      cells.traffic,
      rowActions(() => editLink(link), () => removeLink(link), linkName(link)),
    );
  });

  nodeLayer.append(...nodeList.map(buildNode));
  const view = h(
    'div',
    null,
    pageHead('Network map', 'Live status of your sites, tunnels and upstreams. This page updates by itself.', [
      h('button', { class: 'btn', type: 'button', onClick: addLink }, icon('plus', 14), 'Add link'),
      h('button', { class: 'btn primary', type: 'button', onClick: addNode }, icon('plus', 14), 'Add site or upstream'),
    ]),
    nodeList.length
      ? [
          h(
            'section',
            { class: 'panel' },
            h('div', { class: 'map-wrap' }, canvas),
            h(
              'div',
              { class: 'map-key' },
              h('span', { class: 'map-swatch up' }),
              'Up',
              h('span', { class: 'map-swatch down' }),
              'Down',
              h('span', { class: 'map-swatch unknown' }),
              'Unknown',
              h('span', { class: 'muted' }, '↓ in and ↑ out, measured at the router end. Drag a box to move it.'),
              updated,
            ),
          ),
          panel(
            'Links',
            links.length
              ? table([{ label: 'Link' }, { label: 'Between' }, { label: 'Interface' }, { label: 'Status' }, { label: 'Based on' }, { label: 'Traffic' }, { label: '' }], linkRows)
              : emptyState('No links yet', 'Add a link to join two sites.'),
          ),
          panel(
            'Sites and upstreams',
            table(
              [{ label: 'Name' }, { label: 'Type' }, { label: 'Links' }, { label: '' }],
              nodeList.map((node) =>
                h(
                  'tr',
                  null,
                  h('td', null, node.routerId ? h('a', { href: `#/routers/${node.routerId}` }, node.name) : node.name),
                  h('td', null, node.routerId ? 'Router' : 'Upstream'),
                  h('td', null, links.filter((link) => link.fromId === node.id || link.toId === node.id).length),
                  rowActions(() => editNode(node), () => removeNode(node), node.name),
                ),
              ),
            ),
          ),
        ]
      : panel(null, emptyState('Nothing on the map yet', 'Add your routers first, then your upstreams, then join them with links.')),
  );

  paint();
  if (nodeList.length) refresh();
  const timer = setInterval(() => {
    if (!document.contains(view)) {
      clearInterval(timer);
      return;
    }
    if (!document.hidden && nodeList.length) refresh();
  }, LIVE_MS);
  return view;
}
