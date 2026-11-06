import { lineChart } from './chart.js';
import { badge, buildForm, confirmDialog, del, emptyState, formDialog, get, go, h, icon, notice, pageHead, panel, patch, post, put, table, toast, when } from './lib.js';

const REFRESH_MS = 15000;
const RANGES = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];

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
            [{ label: 'Router' }, { label: 'Status' }, { label: 'Datacenter' }, { label: 'Uptime' }, { label: 'CPU' }, { label: 'Memory' }, { label: 'Ports up' }],
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
      h('button', { class: 'btn primary', type: 'button', onClick: add }, icon('plus', 14), 'Add router'),
    ]),
    banner,
    h('section', { class: 'panel' }, holder),
  );
  whileShown(view, load);
  return view;
}

function chartPanel(title, loadChart, action) {
  const state = { range: '1h' };
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
    RANGES.map(([value, label]) => h('option', { value }, label)),
  );

  render();
  return { element: panel(title, body, h('div', { class: 'actions' }, action, picker)), render };
}

export async function routerDetail({ id }, { reload }) {
  const [{ router }, datacenters] = await Promise.all([get(`/api/admin/routers/${id}`), datacenterOptions()]);
  let selected = router.interfaces.find((iface) => iface.oper === 'up') ?? router.interfaces[0];

  const health = chartPanel('CPU and memory', async (range) => {
    const { rows } = await get(`/api/admin/routers/${id}/history?range=${range}`);
    return lineChart({
      rows,
      max: 100,
      label: `CPU and memory use for ${router.name}`,
      format: (value) => `${Math.round(value)}%`,
      series: [
        { key: 'cpu', label: 'CPU', className: 's1' },
        { key: 'memory', label: 'Memory', className: 's2' },
      ],
    });
  });

  const traffic = chartPanel('Bandwidth', async (range) => {
    if (!selected) return h('div', { class: 'empty' }, 'No interfaces yet.');
    const { rows } = await get(`/api/admin/routers/${id}/interfaces/${selected.id}/history?range=${range}`);
    return h(
      'div',
      null,
      h('div', { class: 'chart-title' }, h('b', { class: 'mono' }, selected.name), selected.alias ? ` ${selected.alias}` : ''),
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

  function renderPorts(list) {
    portRows.replaceChildren(
      list.length
        ? table(
            [{ label: 'Interface' }, { label: 'Status' }, { label: 'Speed' }, { label: 'In' }, { label: 'Out' }, { label: 'Errors' }, { label: 'Drops' }],
            list.map((iface) =>
              h(
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
                        renderPorts(list);
                        traffic.render();
                      },
                    },
                    iface.name,
                  ),
                  iface.alias ? h('div', { class: 'muted' }, iface.alias) : '',
                ),
                h('td', null, portBadge(iface)),
                h('td', { class: 'nowrap' }, formatSpeed(iface.speedMbps)),
                h('td', { class: 'nowrap' }, formatBits(iface.inBps)),
                h('td', { class: 'nowrap' }, formatBits(iface.outBps)),
                h('td', null, iface.errors.toLocaleString()),
                h('td', null, iface.discards.toLocaleString()),
              ),
            ),
          )
        : emptyState('No interfaces yet', 'They appear after the first successful poll.'),
    );
  }
  renderPorts(router.interfaces);

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
    renderHead(fresh);
    selected = fresh.interfaces.find((iface) => iface.id === selected?.id) ?? selected;
    renderPorts(fresh.interfaces);
    health.render();
    traffic.render();
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
    panel('Interfaces', portRows),
    health.element,
  );
  whileShown(view, refresh);
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
