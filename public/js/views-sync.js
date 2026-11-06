import { ApiFailure, badge, buildForm, emptyState, formDialog, get, h, notice, pageHead, panel, plural, post, put, table, toast } from './lib.js';

function applyDialog(changes, { cancelLabel } = {}) {
  const removals = changes.filter((change) => change.op === 'remove');
  return formDialog({
    title: `Apply ${plural(changes.length, 'change')} to the router?`,
    intro: removals.length
      ? `This removes ${plural(removals.length, 'gateway')} straight away. Anyone using ${removals.length === 1 ? 'it' : 'them'} loses connectivity. The change is saved to the router.`
      : 'The change takes effect straight away and is saved to the router.',
    submitLabel: 'Apply to router',
    cancelLabel,
    danger: removals.length > 0,
    fields: [
      h('pre', { class: 'commands' }, changes.map((change) => change.command).join('\n')),
      { name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password' },
    ],
    onSubmit: (values) => post('/api/admin/routers/sync/apply', { ids: changes.map((change) => change.id), password: values.password }),
  });
}

const MAX_BATCH = 20; // Matches the limit in src/sync.js.

function ipv4Number(ip) {
  return ip.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}

// Router changes are IPv4 only, so an IPv6 parent can't hold one.
function isInside(cidr, parent) {
  if (parent.includes(':')) return false;
  const [ip, length] = cidr.split('/');
  const [parentIp, parentLength] = parent.split('/');
  if (Number(length) < Number(parentLength)) return false;
  const size = 2 ** (32 - Number(parentLength));
  return Math.floor(ipv4Number(ip) / size) === Math.floor(ipv4Number(parentIp) / size);
}

// Offers the router change for a prefix straight after it was edited, without leaving the page.
// If the router can't be reached the prefix change still stands, and it waits on the Router changes page.
// With nested, removals for subnets that went with it are offered too.
export async function offerRouterApply(cidr, { nested = false } = {}) {
  try {
    const { settings } = await get('/api/admin/routers/sync/settings');
    if (!settings.fingerprint) return;
    const { changes } = await get('/api/admin/routers/sync/plan');
    const mine = changes.filter((change) => change.cidr === cidr || (nested && change.op === 'remove' && isInside(change.cidr, cidr)));
    if (!mine.length) return;
    if (mine.length > MAX_BATCH) {
      toast(`${plural(mine.length, 'change')} waiting in Router changes`, 'warn', 9000);
      return;
    }
    const done = await applyDialog(mine, { cancelLabel: 'Not now' });
    if (done) toast(`Applied ${plural(mine.length, 'change')} to the router`);
    else toast('Saved in Router changes for later', 'warn');
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    toast(`The router could not be checked: ${error.message}`, 'warn', 9000);
  }
}

export async function routerSync(params, { reload }) {
  const [{ settings }, { datacenters }] = await Promise.all([get('/api/admin/routers/sync/settings'), get('/api/admin/datacenters')]);

  const form = buildForm({
    submitLabel: 'Save connection',
    fields: [
      [
        { name: 'url', label: 'Router API address', value: settings.url, required: true, mono: true, placeholder: 'https://192.0.2.1' },
        { name: 'interface', label: 'Interface', value: settings.interface, required: true, mono: true, hint: 'Subnet gateways go on this interface.' },
      ],
      [
        {
          name: 'key',
          label: 'API key',
          type: 'password',
          autocomplete: 'new-password',
          placeholder: settings.configured ? `Saved (ends ${settings.keyHint}). Leave blank to keep it.` : 'Create a dedicated key for the panel',
          hint: 'A VyOS key has full control of the router. It is encrypted here and never shown again.',
        },
        {
          name: 'datacenterId',
          label: 'Datacenter',
          type: 'select',
          value: settings.datacenterId ?? '',
          required: true,
          options: [{ value: '', label: 'Choose a datacenter' }, ...datacenters.map((d) => ({ value: d.id, label: d.name }))],
          hint: 'Only subnets in this datacenter are compared.',
        },
      ],
    ],
    onSubmit: async (values) => {
      await put('/api/admin/routers/sync/settings', values);
      toast('Connection saved');
      reload();
    },
  });

  const test = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await post('/api/admin/routers/sync/test');
      toast(`Connected. ${plural(result.addresses.length, 'address', 'addresses')} on the interface.`);
      reload();
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      toast(error.message, 'error', 9000);
      button.disabled = false;
    }
  };

  const connection = panel(
    'Connection',
    h('div', { class: 'panel-body' }, form),
    h(
      'div',
      { class: 'actions' },
      settings.fingerprint ? badge('Connected', 'good') : badge(settings.configured ? 'Not tested' : 'Not set up', 'warn'),
      settings.configured && h('button', { class: 'btn sm', type: 'button', onClick: test }, 'Test connection'),
    ),
  );

  const head = pageHead('Router changes', 'Compares the panel with the router. Nothing changes until you apply it.');
  if (!settings.fingerprint) {
    return h('div', null, head, notice('Save the connection and test it. Testing only reads from the router.', 'info'), connection);
  }

  let plan;
  try {
    plan = await get('/api/admin/routers/sync/plan');
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    return h('div', null, head, notice(`Could not read the router: ${error.message}`), connection);
  }

  const boxes = new Map();
  const applyChosen = async () => {
    const chosen = plan.changes.filter((change) => boxes.get(change.id).checked);
    if (!chosen.length) {
      toast('Choose at least one change.', 'warn');
      return;
    }
    const done = await applyDialog(chosen);
    if (done) {
      toast(`Applied ${plural(chosen.length, 'change')}`);
      reload();
    }
  };

  const remove = async (change) => {
    try {
      await post('/api/admin/routers/sync/dismiss', { id: change.id });
      toast(`Deleted ${change.address} from the queue`);
      reload();
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      toast(error.message, 'error');
      reload();
    }
  };
  const restore = async (change) => {
    await post('/api/admin/routers/sync/restore', { id: change.id });
    reload();
  };

  const changes = plan.changes.length
    ? h(
        'div',
        null,
        table(
          [{ label: '' }, { label: 'Change' }, { label: 'Address' }, { label: 'Subnet' }, { label: 'For' }, { label: 'Command' }, { label: '' }],
          plan.changes.map((change) => {
            const box = h('input', { type: 'checkbox', checked: change.op === 'add', 'aria-label': `Include ${change.address}` });
            boxes.set(change.id, box);
            return h(
              'tr',
              null,
              h('td', null, box),
              h('td', null, change.op === 'add' ? badge('Add', 'good') : badge('Remove', 'bad')),
              h('td', { class: 'mono nowrap' }, change.address),
              h('td', { class: 'mono nowrap' }, change.cidr ?? ''),
              h('td', null, change.owner ?? '', change.note ? h('div', { class: 'muted' }, change.note) : ''),
              h('td', { class: 'mono break muted' }, change.command),
              h('td', { class: 'right' }, h('button', { class: 'btn sm danger', type: 'button', 'aria-label': `Delete ${change.address} from the queue`, onClick: () => remove(change) }, 'Delete')),
            );
          }),
        ),
        h('div', { class: 'panel-body right' }, h('button', { class: 'btn primary', type: 'button', onClick: applyChosen }, 'Review and apply')),
      )
    : plan.dismissed.length
      ? emptyState('Nothing waiting', 'Every remaining difference was deleted from the queue. They are listed below.')
      : emptyState('Everything matches', `The panel and ${plan.interface} agree.`);

  const list = (title, rows, render, text) =>
    rows.length ? panel(title, h('div', null, h('p', { class: 'panel-body muted' }, text), table(render.columns, rows.map(render.row)))) : '';

  return h(
    'div',
    null,
    head,
    panel(`Waiting to apply to ${plan.interface}`, changes),
    list(
      'Deleted from the queue',
      plan.dismissed,
      {
        columns: [{ label: 'Change' }, { label: 'Address' }, { label: 'Subnet' }, { label: '' }],
        row: (c) =>
          h(
            'tr',
            null,
            h('td', null, c.op === 'add' ? 'Add' : 'Remove'),
            h('td', { class: 'mono nowrap' }, c.address),
            h('td', { class: 'mono nowrap' }, c.cidr ?? ''),
            h('td', { class: 'right' }, h('button', { class: 'btn sm', type: 'button', onClick: () => restore(c) }, 'Restore')),
          ),
      },
      'These won\u2019t be sent to the router. The router is unchanged, so the panel and the router still differ.',
    ),
    list(
      'Can’t be added',
      plan.conflicts,
      {
        columns: [{ label: 'Wanted' }, { label: 'Subnet' }, { label: 'Already on the router' }],
        row: (c) => h('tr', null, h('td', { class: 'mono nowrap' }, c.address), h('td', { class: 'mono nowrap' }, c.cidr), h('td', { class: 'mono nowrap' }, c.existing)),
      },
      'This IP is already on the interface with a different size. Fix it by hand on the router, or change the subnet’s gateway.',
    ),
    list(
      'On the router, not in the panel',
      plan.unknown.map((address) => ({ address })),
      { columns: [{ label: 'Address' }], row: (u) => h('tr', null, h('td', { class: 'mono nowrap' }, u.address)) },
      'The panel will never remove these. Add the matching subnet here to start tracking one.',
    ),
    list(
      'Subnets with no datacenter',
      plan.noDatacenter.map((cidr) => ({ cidr })),
      { columns: [{ label: 'Subnet' }], row: (u) => h('tr', null, h('td', { class: 'mono nowrap' }, u.cidr)) },
      'These are skipped until they have a datacenter. Edit the prefix to set one.',
    ),
    connection,
  );
}
