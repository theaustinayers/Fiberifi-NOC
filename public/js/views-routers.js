import { lineChart } from './chart.js';
import { badge, buildForm, confirmDialog, del, emptyState, formDialog, get, go, h, icon, notice, pageHead, panel, patch, post, put, table, toast, when } from './lib.js';

const REFRESH_MS = 15000;
const RANGES = [['5m', '5 minutes'], ['15m', '15 minutes'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
const LIVE_RANGES = [['live', 'Realtime'], ...RANGES];
const LIVE_MS = 1000;
const LIVE_POINTS = 300;

export function formatBits(bps) {
  if (bps === null || bps === undefined) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let value = bps;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(mbps) {
  if (!mbps) return '—';
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function statusBadge(router) {
  if (router.status === 'up') return badge('Up', 'good');
  if (router.status === 'down') return badge('Down', 'bad');
  return badge('Waiting');
}

function portBadge(iface) {
  if (iface.admin !== 'up') return badge('Disabled');
  return iface.oper === 'up' ? badge('Up', 'good') : badge('Down', 'bad');
}

function bgpBadge(session) {
  if (session.state === 'established') return badge('Established', 'good');
  const name = session.state.charAt(0).toUpperCase() + session.state.slice(1);
  return badge(session.admin === 'stop' ? 'Shut down' : name, session.admin === 'stop' ? '' : 'bad');
}

const EVENT = {
  up: ['Reconnected', 'good'],
  down: ['Disconnected', 'bad'],
  flap: ['Dropped and recovered', 'warn'],
};

function percentMeter(value) {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, '—');
  return h(
    'div',
    { class: 'meter' },
    h('div', { class: 'meter-track' }, h('span', { class: `meter-fill ${value >= 90 ? 'full' : ''}`, style: { width: `${Math.max(value, 1)}%` } })),
    h('span', { class: 'value' }, `${Math.round(value)}%`),
  );
}

function routerFields(router, datacenters) {
  return [
    [
      { name: 'name', label: 'Name', value: router.name, required: true, placeholder: 'PIT' },
      {
        name: 'role',
        label: 'Role',
        type: 'select',
        value: router.role ?? 'edge',
        options: [
          { value: 'edge', label: 'Edge' },
          { value: 'core', label: 'Core' },
        ],
      },
    ],
    {
      name: 'host',
      label: 'SNMP address',
      value: router.host,
      required: true,
      mono: true,
      hint: 'The address the NOC server polls. For a router behind a tunnel, use its tunnel IP.',
    },
    { name: 'datacenterId', label: 'Datacenter', type: 'select', value: router.datacenter?.id ?? '', options: datacenters },
    { name: 'notes', label: 'Notes (optional)', type: 'textarea', value: router.notes },
  ];
}

// A name set in the panel wins over the description on the router.
const sessionName = (session) => session.label || session.description;

async function datacenterOptions() {
  const { datacenters } = await get('/api/admin/datacenters');
  return [{ value: '', label: 'None' }, ...datacenters.map((d) => ({ value: d.id, label: d.code ? `${d.name} (${d.code})` : d.name }))];
}

// Repeats fn while its element is on the page, so a closed page stops polling by itself.
function whileShown(el, fn) {
  const timer = setInterval(() => {
    if (!document.contains(el)) clearInterval(timer);
    else if (!document.hidden && !document.querySelector('dialog[open]')) fn();
  }, REFRESH_MS);
}

export async function routers() {
  const holder = h('div', null);
  const banner = h('div', null);

  async function load() {
    const { routers: list, snmp } = await get('/api/admin/routers');
    banner.replaceChildren(snmp.configured ? '' : notice(['Routers can’t be polled yet. ', h('a', { href: '#/settings' }, 'Add the SNMP username and password')]));
    holder.replaceChildren(
      list.length
        ? table(
            [{ label: 'Router' }, { label: 'Status' }, { label: 'Datacenter' }, { label: 'Uptime' }, { label: 'CPU' }, { label: 'Memory' }, { label: 'Ports up' }, { label: 'BGP up' }],
            list.map((r) =>
              h(
                'tr',
                null,
                h('td', null, h('a', { href: `#/routers/${r.id}` }, r.name), h('div', { class: 'muted' }, r.role === 'core' ? 'Core' : 'Edge')),
                h('td', null, statusBadge(r)),
                h('td', { class: 'nowrap' }, r.datacenter?.name ?? ''),
                h('td', { class: 'nowrap' }, formatUptime(r.uptimeSeconds)),
                h('td', null, percentMeter(r.cpu)),
                h('td', null, percentMeter(r.memory)),
                h('td', { class: 'nowrap' }, r.portsTotal ? `${r.portsUp} of ${r.portsTotal}` : '—'),
                h('td', { class: 'nowrap' }, r.bgpTotal ? `${r.bgpUp} of ${r.bgpTotal}` : '—'),
              ),
            ),
          )
        : emptyState('No routers yet', 'Add a router to see its status and bandwidth.'),
    );
  }
  await load();

  const add = async () => {
    const created = await formDialog({
      title: 'Add a router',
      submitLabel: 'Add router',
      fields: routerFields({}, await datacenterOptions()),
      onSubmit: async (values) => (await post('/api/admin/routers', values)).router,
    });
    if (created) go(`/routers/${created.id}`);
  };

  const view = h(
    'div',
    null,
    pageHead('Routers', 'Live status from SNMP. This page updates by itself.', [
      h('a', { class: 'btn', href: '#/routers/sync' }, 'Router changes'),
      h('button', { class: 'btn primary', type: 'button', onClick: add }, icon('plus', 14), 'Add router'),
    ]),
    banner,
    h('section', { class: 'panel' }, holder),
  );
  whileShown(view, load);
  return view;
}

function chartPanel(title, loadChart) {
  const state = { range: 'live' };
  const body = h('div', { class: 'panel-body' });

  async function render() {
    body.replaceChildren(await loadChart(state.range));
  }

  const picker = h(
    'select',
    {
      'aria-label': `Time range for ${title}`,
      onChange: (event) => {
        state.range = event.target.value;
        render();
      },
    },
    LIVE_RANGES.map(([value, label]) => h('option', { value, selected: value === state.range }, label)),
  );

  render();
  return { element: panel(title, body, picker), render, range: () => state.range };
}

export async function routerDetail({ id }, { reload }) {
  const [{ router }, datacenters] = await Promise.all([get(`/api/admin/routers/${id}`), datacenterOptions()]);
  // Opens on the busiest interface, which is usually the one worth looking at.
  const traffic0 = (iface) => (iface.inBps ?? 0) + (iface.outBps ?? 0);
  let selected = [...router.interfaces].sort((a, b) => traffic0(b) - traffic0(a))[0];
  let ports = router.interfaces;
  let current = router;
  let liveAt = 0;
  let liveRows = [];
  let liveFor = null;
  let healthRows = null;

  const isLive = () => Date.now() - liveAt < 5000;
  const liveLabel = () => h('span', { class: 'badge good' }, 'Live');
  // Rebuilding under the pointer would close the tooltip and swallow clicks, so a hovered graph waits.
  const redraw = (chart) => {
    if (chart.range() === 'live' && !chart.element.querySelector('.chart:hover')) chart.render();
  };

  // Both Realtime graphs start from recent history, so they have a line straight away.
  async function healthSeries() {
    healthRows ??= (await get(`/api/admin/routers/${id}/history?range=5m`)).rows;
    return healthRows;
  }

  async function liveSeries() {
    if (liveFor !== selected.id) {
      liveRows = (await get(`/api/admin/routers/${id}/interfaces/${selected.id}/history?range=5m`)).rows;
      liveFor = selected.id;
    }
    return liveRows;
  }

  const health = chartPanel('CPU and memory', async (range) => {
    const rows = range === 'live' ? await healthSeries() : (await get(`/api/admin/routers/${id}/history?range=${range}`)).rows;
    return h(
      'div',
      null,
      range === 'live' ? h('div', { class: 'chart-title' }, liveLabel()) : '',
      lineChart({
        rows,
        max: 100,
        label: `CPU and memory use for ${router.name}`,
        format: (value) => `${Math.round(value)}%`,
        series: [
          { key: 'cpu', label: 'CPU', className: 's1' },
          { key: 'memory', label: 'Memory', className: 's2' },
        ],
      }),
    );
  });

  const traffic = chartPanel('Bandwidth', async (range) => {
    if (!selected) return h('div', { class: 'empty' }, 'No interfaces yet.');
    const rows = range === 'live' ? await liveSeries() : (await get(`/api/admin/routers/${id}/interfaces/${selected.id}/history?range=${range}`)).rows;
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'chart-title' },
        h('b', { class: 'mono' }, selected.name),
        selected.alias ? ` ${selected.alias}` : '',
        range === 'live' ? h('span', { class: 'live-pill' }, liveLabel()) : '',
      ),
      lineChart({
        rows,
        label: `Bandwidth on ${selected.name}`,
        format: formatBits,
        series: [
          { key: 'in_bps', label: 'In', className: 's1' },
          { key: 'out_bps', label: 'Out', className: 's2' },
        ],
      }),
    );
  });

  const portRows = h('div', null);
  const portCells = new Map();

  // Updates cells where they are, because a table rebuilt every second would lose clicks.
  function updatePorts() {
    for (const iface of ports) {
      const cells = portCells.get(iface.id);
      if (!cells) continue;
      cells.status.replaceChildren(portBadge(iface));
      cells.in.textContent = formatBits(iface.inBps);
      cells.out.textContent = formatBits(iface.outBps);
    }
  }

  function renderPorts(list) {
    portCells.clear();
    portRows.replaceChildren(
      list.length
        ? table(
            [{ label: 'Interface' }, { label: 'Status' }, { label: 'Speed' }, { label: 'In' }, { label: 'Out' }, { label: 'Errors since boot' }, { label: 'Drops since boot' }],
            list.map((iface) => {
              const cells = { status: h('td', null, portBadge(iface)), in: h('td', { class: 'nowrap' }, formatBits(iface.inBps)), out: h('td', { class: 'nowrap' }, formatBits(iface.outBps)) };
              portCells.set(iface.id, cells);
              return h(
                'tr',
                { class: iface.id === selected?.id ? 'selected' : '' },
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'cell-link mono',
                      type: 'button',
                      onClick: () => {
                        selected = iface;
                        renderPorts(ports);
                        traffic.render();
                      },
                    },
                    iface.name,
                  ),
                  iface.alias ? h('div', { class: 'muted' }, iface.alias) : '',
                ),
                cells.status,
                h('td', { class: 'nowrap' }, formatSpeed(iface.speedMbps)),
                cells.in,
                cells.out,
                h('td', null, iface.errors.toLocaleString()),
                h('td', null, iface.discards.toLocaleString()),
              );
            }),
          )
        : emptyState('No interfaces yet', 'They appear after the first successful poll.'),
    );
  }
  renderPorts(ports);

  let sessions = router.bgp;
  let selectedSession = null;
  const bgpRows = h('div', null);
  const bgpLog = h('div', null);

  async function renderLog() {
    const session = sessions.find((s) => s.id === selectedSession);
    if (!session) {
      bgpLog.replaceChildren();
      return;
    }
    const { events } = await get(`/api/admin/routers/${id}/bgp/${session.id}/events`);
    const rename = async () => {
      const done = await formDialog({
        title: `Name ${session.peerIp}`,
        submitLabel: 'Save name',
        fields: [
          {
            name: 'label',
            label: 'Name',
            value: session.label,
            placeholder: session.description || 'Upstream A (IPsec)',
            hint: session.description ? 'Leave blank to use the description from the router.' : undefined,
          },
        ],
        onSubmit: (values) => patch(`/api/admin/routers/${id}/bgp/${session.id}`, values),
      });
      if (done) reload();
    };
    const fact = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
    bgpLog.replaceChildren(
      h(
        'div',
        { class: 'bgp-detail' },
        h(
          'div',
          { class: 'panel-head' },
          h('h2', null, sessionName(session) || session.peerIp),
          h('button', { class: 'btn sm', type: 'button', onClick: rename }, sessionName(session) ? 'Rename' : 'Add a name'),
        ),
        h(
          'dl',
          { class: 'facts' },
          fact('Peer', session.peerIp),
          fact('Local address', session.localIp || '—'),
          fact('Remote AS', session.remoteAs || '—'),
          fact('Messages in', session.inMessages.toLocaleString()),
          fact('Messages out', session.outMessages.toLocaleString()),
          fact('Last error', session.lastError || 'None'),
        ),
        h('h3', { class: 'section-title bgp-log-title' }, 'Disconnects and reconnects'),
        events.length
          ? table(
              [{ label: 'When' }, { label: 'What happened' }, { label: 'State' }, { label: 'Reason' }],
              events.map((event) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'nowrap' }, new Date(event.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })),
                  h('td', { class: 'nowrap' }, badge(EVENT[event.type][0], EVENT[event.type][1])),
                  h('td', { class: 'mono nowrap' }, `${event.fromState} → ${event.toState}`),
                  h('td', { class: 'break' }, event.detail),
                ),
              ),
            )
          : emptyState('No changes recorded', 'This logs from when monitoring started. Anything earlier shows in the total above.'),
      ),
    );
  }

  function renderSessions() {
    bgpRows.replaceChildren(
      sessions.length
        ? table(
            [{ label: 'Peer' }, { label: 'Remote AS' }, { label: 'Status' }, { label: 'For' }, { label: 'Updates in' }, { label: 'Updates out' }, { label: 'Times established' }],
            sessions.map((session) =>
              h(
                'tr',
                { class: session.id === selectedSession ? 'selected' : '' },
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'cell-link',
                      type: 'button',
                      onClick: () => {
                        selectedSession = session.id === selectedSession ? null : session.id;
                        renderSessions();
                        renderLog();
                      },
                    },
                    sessionName(session) || h('span', { class: 'mono' }, session.peerIp),
                  ),
                  sessionName(session) ? h('div', { class: 'muted mono' }, session.peerIp) : '',
                ),
                h('td', { class: 'nowrap' }, session.remoteAs ? `AS${session.remoteAs}` : '—'),
                h('td', null, bgpBadge(session)),
                h('td', { class: 'nowrap' }, formatUptime(session.stateSeconds)),
                h('td', null, session.inUpdates.toLocaleString()),
                h('td', null, session.outUpdates.toLocaleString()),
                h('td', null, session.transitions.toLocaleString()),
              ),
            ),
          )
        : emptyState('No BGP data from this router', 'BGP over SNMP has to be turned on for the router first.'),
    );
  }
  renderSessions();

  const facts = h('dl', { class: 'facts' });
  const title = h('div', { class: 'page-title' });
  const problem = h('div', null);

  function renderHead(r) {
    title.replaceChildren(h('h1', null, r.name), statusBadge(r));
    const fact = (label, value, mono) => (value === null || value === undefined || value === '' ? '' : h('div', null, h('dt', null, label), h('dd', { class: mono ? 'mono' : '' }, value)));
    facts.replaceChildren(
      ...[
        fact('Address', r.host, true),
        fact('Datacenter', r.datacenter?.name),
        fact('Role', r.role === 'core' ? 'Core' : 'Edge'),
        fact('Uptime', r.uptimeSeconds === null ? null : formatUptime(r.uptimeSeconds)),
        fact('CPU', r.cpu === null ? null : `${Math.round(r.cpu)}%`),
        fact('Memory', r.memory === null ? null : `${Math.round(r.memory)}%`),
        fact('Load', r.load1),
        fact('Last polled', r.polledAt ? when(new Date(r.polledAt).toISOString()) : null),
      ].filter(Boolean),
    );
    problem.replaceChildren(r.lastError ? notice(`The last poll failed: ${r.lastError}`) : '');
  }
  renderHead(router);

  const edit = async () => {
    const done = await formDialog({
      title: `Edit ${router.name}`,
      submitLabel: 'Save changes',
      fields: routerFields(router, datacenters),
      onSubmit: (values) => patch(`/api/admin/routers/${id}`, values),
    });
    if (done) {
      toast('Saved');
      reload();
    }
  };
  const remove = async () => {
    const done = await confirmDialog({
      title: `Delete ${router.name}?`,
      body: 'Its bandwidth and CPU history are deleted too. This cannot be undone.',
      confirmLabel: 'Delete router',
      onConfirm: () => del(`/api/admin/routers/${id}`),
    });
    if (done) {
      toast(`Deleted ${router.name}`);
      go('/routers');
    }
  };
  const refresh = async () => {
    const { router: fresh } = await get(`/api/admin/routers/${id}`);
    // While live readings are arriving they are fresher than the 30-second poll, so they are left alone.
    current = isLive() ? { ...fresh, cpu: current.cpu, memory: current.memory } : fresh;
    renderHead(current);
    if (!isLive()) {
      ports = fresh.interfaces;
      selected = ports.find((iface) => iface.id === selected?.id) ?? selected;
      renderPorts(ports);
    }
    if (health.range() !== 'live') health.render();
    if (traffic.range() !== 'live') traffic.render();
  };
  const pollNow = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await post(`/api/admin/routers/${id}/poll`);
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  };

  const view = h(
    'div',
    null,
    h('div', { class: 'crumbs' }, h('a', { href: '#/routers' }, 'Routers')),
    h(
      'div',
      { class: 'page-head' },
      h('div', null, title),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: pollNow }, 'Poll now'),
        h('button', { class: 'btn', type: 'button', onClick: edit }, 'Edit'),
        h('button', { class: 'btn danger', type: 'button', onClick: remove }, 'Delete'),
      ),
    ),
    problem,
    h('section', { class: 'panel' }, facts),
    traffic.element,
    panel('Interfaces', portRows, liveLabel()),
    health.element,
    panel('BGP sessions', h('div', null, bgpRows, bgpLog), liveLabel()),
  );
  whileShown(view, refresh);

  let reading = false;
  const live = setInterval(async () => {
    if (!document.contains(view)) {
      clearInterval(live);
      return;
    }
    if (reading || document.hidden || document.querySelector('dialog[open]')) return;
    reading = true;
    let sample;
    try {
      sample = await get(`/api/admin/routers/${id}/live`);
    } catch {
      return; // A missed reading leaves a gap, and the next one carries on.
    } finally {
      reading = false;
    }
    liveAt = Date.now();

    const readings = new Map(sample.interfaces.map((row) => [row.id, row]));
    ports = ports.map((iface) => {
      const row = readings.get(iface.id);
      if (!row) return iface;
      return { ...iface, oper: row.oper, inBps: row.in_bps ?? iface.inBps, outBps: row.out_bps ?? iface.outBps };
    });
    selected = ports.find((iface) => iface.id === selected?.id) ?? selected;
    updatePorts();
    current = { ...current, cpu: sample.cpu ?? current.cpu, memory: sample.memory ?? current.memory };
    renderHead(current);

    if (sample.bgp) {
      sessions = sample.bgp;
      if (!bgpRows.matches(':hover')) renderSessions();
      if (!bgpLog.matches(':hover')) renderLog();
    }

    if (healthRows && sample.ts > (healthRows.at(-1)?.ts ?? 0)) {
      healthRows = [...healthRows, { ts: sample.ts, cpu: sample.cpu, memory: sample.memory }].slice(-LIVE_POINTS);
      redraw(health);
    }
    const row = readings.get(selected?.id);
    if (row && row.in_bps !== null && liveFor === selected.id && sample.ts > (liveRows.at(-1)?.ts ?? 0)) {
      liveRows = [...liveRows, { ts: sample.ts, in_bps: row.in_bps, out_bps: row.out_bps }].slice(-LIVE_POINTS);
      redraw(traffic);
    }
  }, LIVE_MS);

  return view;
}

export async function snmpPanel() {
  const { snmp } = await get('/api/admin/routers/settings');
  const form = buildForm({
    submitLabel: 'Save SNMP settings',
    fields: [
      { name: 'user', label: 'SNMPv3 username', value: snmp.user || 'noc', required: true, mono: true },
      [
        {
          name: 'authPassword',
          label: 'Auth password',
          type: 'password',
          autocomplete: 'new-password',
          placeholder: snmp.configured ? 'Saved. Leave blank to keep it.' : '',
          hint: 'Encrypted here and never shown again.',
        },
        {
          name: 'privPassword',
          label: 'Privacy password',
          type: 'password',
          autocomplete: 'new-password',
          placeholder: 'Leave blank to use the same password',
        },
      ],
    ],
    onSubmit: async (values, formEl) => {
      await put('/api/admin/routers/settings', values);
      formEl.querySelectorAll('[type=password]').forEach((input) => {
        input.value = '';
      });
      toast('SNMP settings saved');
    },
  });
  return panel('Router monitoring (SNMP)', h('div', { class: 'panel-body' }, form), snmp.configured ? badge('Connected', 'good') : badge('Not set up', 'warn'));
}
