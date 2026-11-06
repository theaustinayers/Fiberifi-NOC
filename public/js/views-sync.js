import { ApiFailure, badge, buildForm, emptyState, formDialog, get, h, notice, pageHead, panel, plural, post, put, table, toast } from './lib.js';

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
    const removals = chosen.filter((change) => change.op === 'remove');
    const done = await formDialog({
      title: `Apply ${plural(chosen.length, 'change')} to the router?`,
      intro: removals.length
        ? `This removes ${plural(removals.length, 'gateway')} straight away. Anyone using ${removals.length === 1 ? 'it' : 'them'} loses connectivity. The change is saved to the router.`
        : 'The change takes effect straight away and is saved to the router.',
      submitLabel: 'Apply to router',
      danger: removals.length > 0,
      fields: [
        h('pre', { class: 'commands' }, chosen.map((change) => change.command).join('\n')),
        { name: 'password', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password' },
      ],
      onSubmit: (values) => post('/api/admin/routers/sync/apply', { ids: chosen.map((change) => change.id), password: values.password }),
    });
    if (done) {
      toast(`Applied ${plural(chosen.length, 'change')}`);
      reload();
    }
  };

  const changes = plan.changes.length
    ? h(
        'div',
        null,
        table(
          [{ label: '' }, { label: 'Change' }, { label: 'Address' }, { label: 'Subnet' }, { label: 'For' }, { label: 'Command' }],
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
              h('td', null, change.owner ?? ''),
              h('td', { class: 'mono break muted' }, change.command),
            );
          }),
        ),
        h('div', { class: 'panel-body right' }, h('button', { class: 'btn primary', type: 'button', onClick: applyChosen }, 'Review and apply')),
      )
    : emptyState('Everything matches', `The panel and ${plan.interface} agree.`);

  const list = (title, rows, render, text) =>
    rows.length ? panel(title, h('div', null, h('p', { class: 'panel-body muted' }, text), table(render.columns, rows.map(render.row)))) : '';

  return h(
    'div',
    null,
    head,
    panel(`Waiting to apply to ${plan.interface}`, changes),
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
