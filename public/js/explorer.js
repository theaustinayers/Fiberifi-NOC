// The drill-down on the Prefixes page: open a range into smaller blocks, all the way to single addresses.
// Blocks do not have to exist as prefixes. They are worked out on the server from what is assigned right now.
import { editAddress, removePtrButton, rowClass, statusCell } from './addresses.js';
import { badge, formDialog, get, go, h, icon, meter, plural, post, toast } from './lib.js';

const REFRESH_MS = 15000;
const ROLE_LABEL = { network: 'Network', gateway: 'Gateway', broadcast: 'Broadcast' };
const STATE = {
  assigned: ['Assigned', 'brand'],
  partial: ['Partly assigned', 'warn'],
  internal: ['Internal', 'good'],
  inuse: ['In use', ''],
  free: ['Free', ''],
};

function indent(depth) {
  return h('span', { class: 'indent', style: { width: `${depth * 20}px` } });
}

function customerLink(customer) {
  return h('a', { href: `#/accounts/${customer.id}` }, customer.company || customer.name);
}

const INTERNAL = 'Fiberifi';

function ownerCell(block) {
  if (block.customer) return customerLink(block.customer);
  if (block.state === 'internal') return INTERNAL;
  const owners = block.customersInside.map(customerLink);
  if (block.internalInside) owners.push(INTERNAL);
  return owners.map((owner, i) => [i ? ', ' : '', owner]);
}

export function explorerTable(aggregates, { datacenterOptions, ownerOptions }) {
  const open = new Map(); // cidr -> chosen block length, or null for the default
  const shown = new Map(); // cidr -> the blocks last shown inside it
  const body = h('tbody', null);
  const updated = h('span', { class: 'muted' }, '');
  let token = 0;

  // Closing a block closes everything opened beneath it.
  function close(cidr) {
    open.delete(cidr);
    for (const child of shown.get(cidr) ?? []) close(child);
    shown.delete(cidr);
  }

  function toggle(cidr) {
    if (open.has(cidr)) close(cidr);
    else open.set(cidr, null);
    render();
  }

  function chevron(cidr, label) {
    const expanded = open.has(cidr);
    return h(
      'button',
      {
        class: `chev ${expanded ? 'open' : ''}`,
        type: 'button',
        'aria-expanded': String(expanded),
        'aria-label': `${expanded ? 'Close' : 'Open'} ${label}`,
        onClick: () => toggle(cidr),
      },
      icon('chevron', 14),
    );
  }

  async function useBlock(block) {
    const datacenters = await datacenterOptions('Choose a datacenter');
    if (datacenters.length === 1) {
      toast('Add a datacenter first.', 'warn');
      go('/datacenters');
      return;
    }
    const canAssign = ['free', 'inuse', 'internal'].includes(block.state);
    const fields = [
      canAssign && { name: 'customerId', label: 'Customer', type: 'select', value: '', options: await ownerOptions() },
      { name: 'description', label: 'Description' },
      [
        { name: 'datacenterId', label: 'Datacenter', type: 'select', value: block.datacenterId ?? '', options: datacenters, required: true },
        { name: 'vlan', label: 'VLAN (optional)', type: 'number', min: 1, max: 4094 },
      ],
    ].filter(Boolean);
    const intro = canAssign ? 'Turns this block into a prefix. Choose Internal for space Fiberifi uses itself.' : 'Keeps this as a label only. It stays with the customer it is assigned to.';
    const created = await formDialog({
      title: `Use ${block.cidr}`,
      intro,
      submitLabel: 'Create prefix',
      fields,
      onSubmit: async (values) => (await post('/api/admin/prefixes/carve', { ...values, cidr: block.cidr })).prefix,
    });
    if (created) {
      toast(`Created ${created.cidr}`);
      render();
    }
  }

  function aggregateRow(p) {
    return h(
      'tr',
      null,
      h('td', { class: 'nowrap' }, chevron(p.cidr, p.cidr), h('a', { class: 'mono', href: `#/prefixes/${p.id}` }, p.cidr)),
      h('td', null, p.internal ? badge('Internal', 'good') : p.customer ? badge('Assigned', 'brand') : badge('Range')),
      h('td', null, p.customer ? customerLink(p.customer) : p.internal ? INTERNAL : ''),
      h('td', null, meter(p.utilization)),
      h('td', { class: 'break' }, p.description),
      h('td', { class: 'nowrap' }, p.datacenter ? h('a', { href: `#/datacenters/${p.datacenter.id}` }, p.datacenter.name) : ''),
      h('td', null, p.vlan ?? ''),
      h('td', null, ''),
    );
  }

  function sizeRow(view, depth) {
    return h(
      'tr',
      { class: 'explore-head' },
      h(
        'td',
        { colSpan: 8 },
        indent(depth),
        h(
          'label',
          null,
          'Show as ',
          h(
            'select',
            {
              class: 'mono',
              'aria-label': `Block size inside ${view.cidr}`,
              onChange: (event) => {
                for (const child of shown.get(view.cidr) ?? []) close(child);
                open.set(view.cidr, Number(event.target.value));
                render();
              },
            },
            view.options.map((length) => h('option', { value: length, selected: length === view.length }, `/${length}`)),
          ),
        ),
        h('span', { class: 'muted' }, ` ${plural(view.rows.length, view.kind === 'addresses' ? 'address' : 'block', view.kind === 'addresses' ? 'addresses' : 'blocks')}`),
      ),
    );
  }

  function blockRow(block, depth) {
    const [label, kind] = STATE[block.state];
    const name = block.prefixId ? h('a', { class: 'mono', href: `#/prefixes/${block.prefixId}` }, block.cidr) : h('span', { class: 'mono' }, block.cidr);
    const usage = [block.records && plural(block.records, 'record'), block.ptrs && plural(block.ptrs, 'PTR')].filter(Boolean).join(' · ');
    return h(
      'tr',
      { class: block.state === 'free' ? 'free' : '' },
      h('td', { class: 'nowrap' }, indent(depth), chevron(block.cidr, block.cidr), name),
      h('td', null, badge(label, kind)),
      h('td', null, ownerCell(block)),
      h('td', { class: 'nowrap muted' }, usage),
      h('td', { class: 'break' }, block.description),
      h('td', { class: 'nowrap' }, block.datacenter ?? ''),
      h('td', null, block.vlan ?? ''),
      h('td', { class: 'right' }, block.prefixId ? '' : h('button', { class: 'btn sm', type: 'button', onClick: () => useBlock(block) }, 'Use block')),
    );
  }

  function addressRow(row, depth) {
    if (row.locked) {
      return h(
        'tr',
        { class: 'locked', title: 'This address cannot be edited.' },
        h('td', { class: 'mono nowrap' }, indent(depth + 1), row.ip),
        h('td', null, h('span', { class: 'lock' }, icon('lock', 14), ROLE_LABEL[row.role])),
        h('td', { colSpan: 5, class: 'mono' }, row.rdns?.hostname ?? ''),
        h('td', { class: 'right' }, row.rdns ? removePtrButton(row.prefixId, row, render) : ''),
      );
    }
    return h(
      'tr',
      { class: rowClass(row) },
      h(
        'td',
        { class: 'nowrap' },
        indent(depth + 1),
        h('button', { class: 'cell-link mono', type: 'button', onClick: () => editAddress(row.prefixId, row, render) }, row.ip),
      ),
      h('td', null, statusCell(row)),
      h('td', null, row.customer ? customerLink(row.customer) : row.internal ? INTERNAL : ''),
      h('td', { class: 'mono' }, row.record?.hostname ?? ''),
      h('td', { class: 'break' }, row.record?.description ?? ''),
      h('td', { class: 'mono', colSpan: 3 }, row.rdns?.hostname ?? ''),
    );
  }

  async function rowsFor(cidr, depth) {
    const length = open.get(cidr);
    const view = await get(`/api/admin/explore?cidr=${encodeURIComponent(cidr)}${length ? `&length=${length}` : ''}`);
    const rows = [sizeRow(view, depth)];
    shown.set(cidr, view.kind === 'blocks' ? view.rows.map((block) => block.cidr) : []);
    if (view.kind === 'addresses') {
      rows.push(...view.rows.map((row) => addressRow(row, depth)));
      return rows;
    }
    for (const block of view.rows) {
      rows.push(blockRow(block, depth));
      if (open.has(block.cidr)) rows.push(...(await rowsFor(block.cidr, depth + 1)));
    }
    return rows;
  }

  async function render() {
    const mine = (token += 1);
    const rows = [];
    for (const p of await aggregates()) {
      rows.push(aggregateRow(p));
      if (open.has(p.cidr)) rows.push(...(await rowsFor(p.cidr, 1)));
    }
    if (mine !== token) return;
    body.replaceChildren(...rows);
    updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const view = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          ['Prefix', 'Status', 'Customer', 'Used', 'Description', 'Datacenter', 'VLAN', ''].map((label) => h('th', { scope: 'col' }, label)),
        ),
      ),
      body,
    ),
  );

  // Picks up assignments made by other admins and changes made by customers.
  const timer = setInterval(() => {
    if (!document.contains(view)) {
      clearInterval(timer);
      return;
    }
    const busy = document.querySelector('dialog[open]') || document.activeElement?.tagName === 'SELECT';
    if (!busy && !document.hidden) render();
  }, REFRESH_MS);

  render();
  return { view, updated, render };
}
