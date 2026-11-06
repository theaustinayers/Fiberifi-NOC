import { addressTable } from './addresses.js';
import { explorerTable } from './explorer.js';
import { snmpPanel } from './views-routers.js';
import { accessBadge, memberFields } from './team.js';
import {
  badge,
  buildForm,
  confirmDialog,
  debounce,
  del,
  emptyState,
  formDialog,
  get,
  go,
  h,
  icon,
  meter,
  notice,
  pageHead,
  pager,
  panel,
  patch,
  plural,
  post,
  put,
  secretDialog,
  session,
  table,
  toast,
  when,
} from './lib.js';

const STATUS_KIND = { container: '', active: 'good', reserved: 'warn', deprecated: 'bad' };
const STATUS_LABEL = { container: 'Container', active: 'Active', reserved: 'Reserved', deprecated: 'Deprecated' };
const statusOptions = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }));

function statusBadge(prefix) {
  if (prefix.internal) return badge('Internal', 'good');
  if (prefix.customer) return badge('Assigned', 'brand');
  return badge(STATUS_LABEL[prefix.status], STATUS_KIND[prefix.status]);
}

function customerName(customer) {
  return customer.company || customer.name;
}

function ownerName(prefix) {
  if (prefix.internal) return 'Fiberifi';
  return prefix.customer ? h('a', { href: `#/accounts/${prefix.customer.id}` }, customerName(prefix.customer)) : '';
}

function prefixLink(prefix) {
  return h('a', { class: 'mono', href: `#/prefixes/${prefix.id}` }, prefix.cidr);
}

// Customers, plus Fiberifi itself for space it keeps.
async function ownerOptions(emptyLabel = 'Not assigned') {
  const customers = await customerOptions();
  const none = emptyLabel ? [{ value: '', label: emptyLabel }] : [];
  return [...none, { value: 'internal', label: 'Internal (Fiberifi)' }, ...customers];
}

async function customerOptions(emptyLabel) {
  const { users } = await get('/api/admin/users');
  const options = users
    .filter((u) => u.role === 'customer' && !u.disabled)
    .map((u) => ({ value: u.id, label: u.company ? `${u.company} (${u.name})` : u.name }));
  return emptyLabel ? [{ value: '', label: emptyLabel }, ...options] : options;
}

// ---- overview ----

export async function overview() {
  const data = await get('/api/admin/overview');
  const s = data.stats;
  const tile = (value, label) => h('div', { class: 'stat' }, h('b', null, value.toLocaleString()), h('span', null, label));

  return h(
    'div',
    null,
    pageHead('Overview', 'Address space and recent changes across the network.'),
    !data.rdnsEnabled &&
      notice([
        'Reverse DNS is off, so customers cannot publish PTR records. ',
        h('a', { href: '#/settings' }, 'Add a Cloudflare API token'),
      ]),
    h(
      'div',
      { class: 'stats' },
      tile(s.prefixes, 'Prefixes'),
      tile(s.assigned, 'Assigned subnets'),
      tile(s.customers, 'Customers'),
      tile(s.addresses, 'Address records'),
      tile(s.ptrRecords, 'PTR records'),
    ),
    h(
      'div',
      { class: 'grid-2' },
      panel(
        'Allocations',
        data.aggregates.length
          ? table(
              [{ label: 'Prefix' }, { label: 'Subnets' }, { label: 'Allocated' }],
              data.aggregates.map((p) => h('tr', null, h('td', null, prefixLink(p)), h('td', null, p.childCount), h('td', null, meter(p.utilization)))),
            )
          : emptyState('No prefixes', 'Add your first range on the Prefixes page.'),
        h('a', { href: '#/prefixes' }, 'All prefixes'),
      ),
      panel(
        'Recent activity',
        data.recent.length
          ? h(
              'ul',
              { class: 'activity' },
              data.recent.map((e) =>
                h(
                  'li',
                  null,
                  h('div', null, h('span', { class: 'mono' }, e.action), e.target ? ` ${e.target}` : '', h('div', { class: 'muted' }, e.actor)),
                  h('time', { dateTime: e.ts }, when(e.ts)),
                ),
              ),
            )
          : emptyState('Nothing yet', 'Changes appear here as they happen.'),
        h('a', { href: '#/audit' }, 'Audit log'),
      ),
    ),
  );
}

// ---- prefix list ----

async function datacenterOptions(emptyLabel) {
  const { datacenters } = await get('/api/admin/datacenters');
  const options = datacenters.map((d) => ({ value: d.id, label: d.code ? `${d.name} (${d.code})` : d.name }));
  return [{ value: '', label: emptyLabel }, ...options];
}

function prefixFields(prefix, datacenters) {
  return [
    {
      name: 'cidr',
      label: 'Prefix',
      value: prefix.cidr,
      required: true,
      mono: true,
      placeholder: '192.0.2.0/24 or 2001:db8::/32',
    },
    { name: 'description', label: 'Description', value: prefix.description },
    [
      { name: 'status', label: 'Status', type: 'select', value: prefix.status ?? 'active', options: statusOptions },
      { name: 'datacenterId', label: 'Datacenter', type: 'select', value: prefix.datacenter?.id ?? '', options: datacenters },
      { name: 'vlan', label: 'VLAN (optional)', type: 'number', value: prefix.vlan, min: 1, max: 4094 },
    ],
  ];
}

async function addPrefix() {
  const created = await formDialog({
    title: 'Add a prefix',
    intro: 'It is placed in the tree automatically, under whichever prefix contains it.',
    submitLabel: 'Add prefix',
    fields: prefixFields({ status: 'container' }, await datacenterOptions('None')),
    onSubmit: async (values) => (await post('/api/admin/prefixes', values)).prefix,
  });
  if (created) {
    toast(`Added ${created.cidr}`);
    go(`/prefixes/${created.id}`);
  }
}

export async function prefixes() {
  const state = { q: '', family: '' };
  const holder = h('div', null);
  const load = async () => (await get('/api/admin/prefixes')).prefixes;
  // Fetched on every refresh, so the top level and the filter see prefixes created after the page opened.
  const aggregates = async () => (await load()).filter((p) => p.parentId === null && (!state.family || String(p.family) === state.family));
  const explorer = explorerTable(aggregates, { datacenterOptions, ownerOptions });

  async function render() {
    const q = state.q.toLowerCase();
    if (!q) {
      holder.replaceChildren(explorer.view);
      explorer.render();
      return;
    }
    const all = await load();
    if (q !== state.q.toLowerCase()) return;
    const rows = all.filter((p) => {
      if (state.family && String(p.family) !== state.family) return false;
      return [p.cidr, p.description, p.datacenter?.name, p.customer?.name, p.customer?.company].some((v) => v?.toLowerCase().includes(q));
    });
    holder.replaceChildren(
      rows.length
        ? table(
            [{ label: 'Prefix' }, { label: 'Status' }, { label: 'Customer' }, { label: 'Utilization' }, { label: 'Description' }, { label: 'Datacenter' }, { label: 'VLAN' }],
            rows.map((p) =>
              h(
                'tr',
                null,
                h('td', { class: 'nowrap' }, prefixLink(p)),
                h('td', null, statusBadge(p)),
                h('td', null, ownerName(p)),
                h('td', null, meter(p.utilization)),
                h('td', { class: 'break' }, p.description),
                h('td', null, p.datacenter ? h('a', { href: `#/datacenters/${p.datacenter.id}` }, p.datacenter.name) : ''),
                h('td', null, p.vlan ?? ''),
              ),
            ),
          )
        : emptyState('No matching prefixes', 'Try a different search, or add a prefix.'),
    );
  }
  holder.replaceChildren(explorer.view);

  return h(
    'div',
    null,
    pageHead(
      'Prefixes',
      'Open a range to drill down to single addresses. This view updates by itself.',
      [
        h('a', { class: 'btn', href: '/api/admin/prefixes/export.csv' }, icon('download', 14), 'Export CSV'),
        h('button', { class: 'btn primary', type: 'button', onClick: addPrefix }, icon('plus', 14), 'Add prefix'),
      ],
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'toolbar' },
        h(
          'div',
          { class: 'grow searchbox' },
          icon('search', 14),
          h('input', {
            type: 'search',
            placeholder: 'Filter by prefix, customer or description',
            'aria-label': 'Filter prefixes',
            onInput: debounce((event) => {
              state.q = event.target.value.trim();
              render();
            }),
          }),
        ),
        h(
          'select',
          {
            'aria-label': 'Address family',
            onChange: (event) => {
              state.family = event.target.value;
              render();
            },
          },
          h('option', { value: '' }, 'IPv4 and IPv6'),
          h('option', { value: '4' }, 'IPv4'),
          h('option', { value: '6' }, 'IPv6'),
        ),
        explorer.updated,
      ),
      holder,
    ),
  );
}

// ---- prefix detail ----

async function allocateDialog(prefix, reload, presetCidr = '') {
  const maxLength = prefix.family === 4 ? 32 : 128;
  const suggested = Math.min(prefix.length + (prefix.family === 4 ? 5 : 16), maxLength);
  const datacenters = await datacenterOptions('Choose a datacenter');
  if (datacenters.length === 1) {
    toast('Add a datacenter first.', 'warn');
    go('/datacenters');
    return;
  }
  const created = await formDialog({
    title: `Allocate from ${prefix.cidr}`,
    intro: prefix.customer
      ? `Adds a label inside ${customerName(prefix.customer)}'s subnet. It stays theirs and their addresses are not affected.`
      : `Enter the exact subnet you want, or leave it blank to take the next free block of the length below. Use /${prefix.length} for the whole prefix.`,
    submitLabel: 'Allocate subnet',
    fields: [
      {
        name: 'cidr',
        label: 'Subnet (optional)',
        value: presetCidr,
        mono: true,
        placeholder: prefix.family === 4 ? '206.168.244.240/29' : '2607:9340:1::/48',
      },
      [
        { name: 'length', label: 'Prefix length', type: 'number', value: suggested, min: prefix.length, max: maxLength, required: true },
        !prefix.customer && { name: 'customerId', label: 'Customer', type: 'select', value: '', options: await ownerOptions() },
      ].filter(Boolean),
      { name: 'description', label: 'Description' },
      [
        { name: 'datacenterId', label: 'Datacenter', type: 'select', value: prefix.datacenter?.id ?? '', options: datacenters, required: true },
        { name: 'vlan', label: 'VLAN (optional)', type: 'number', min: 1, max: 4094 },
      ],
    ],
    onInput: async ({ cidr, length }, setNote) => {
      const typed = cidr.trim();
      const lengthField = document.querySelector('dialog [name=length]');
      if (lengthField) lengthField.disabled = Boolean(typed);
      const query = typed ? `cidr=${encodeURIComponent(typed)}` : `length=${encodeURIComponent(length)}`;
      try {
        const { next } = await get(`/api/admin/prefixes/${prefix.id}/next-available?${query}`);
        if (next?.whole) setNote(`Uses all of ${next.cidr}. Prefixes already inside it stay as they are.`);
        else if (next?.overlaps) setNote(`Creates ${next.cidr}. It overlaps ${next.overlaps}, so it can only be a label, not assigned to another customer.`);
        else if (next?.exact) setNote(`Creates ${next.cidr} (${next.size} addresses).`);
        else setNote(next ? `Next free: ${next.cidr} (${next.size} addresses)` : `No free /${length} left in this prefix.`);
      } catch (error) {
        setNote(error.message);
      }
    },
    onSubmit: async (values) => (await post(`/api/admin/prefixes/${prefix.id}/allocate`, values)).prefix,
  });
  if (created) {
    toast(`Allocated ${created.cidr}`);
    reload();
  }
}

async function assignDialog(prefix, reload) {
  const options = await ownerOptions(null);
  const done = await formDialog({
    title: `Assign ${prefix.cidr}`,
    intro: 'A customer can see this subnet, keep address records in it and set its reverse DNS. Internal keeps it for Fiberifi.',
    submitLabel: 'Assign subnet',
    fields: [
      { name: 'customerId', label: 'Assign to', type: 'select', options, required: true },
      {
        name: 'gateway',
        label: 'Gateway',
        mono: true,
        value: prefix.gatewayOverride ?? '',
        placeholder: 'First usable address',
        hint: 'Leave blank to use the first usable address.',
      },
    ],
    onSubmit: (values) => post(`/api/admin/prefixes/${prefix.id}/assign`, values),
  });
  if (done) {
    toast(`Assigned ${prefix.cidr}`);
    reload();
  }
}

function reportPtr(result) {
  if (result.ptrFailed?.length) {
    toast(`${plural(result.ptrFailed.length, 'PTR record')} could not be removed from Cloudflare: ${result.ptrFailed.slice(0, 5).join(', ')}`, 'warn', 12000);
  }
}

async function releaseDialog(prefix, reload) {
  const done = await confirmDialog({
    title: `Release ${prefix.cidr}?`,
    body: 'It stops being marked as internal. Address records and PTRs stay as they are.',
    confirmLabel: 'Release',
    danger: false,
    onConfirm: () => post(`/api/admin/prefixes/${prefix.id}/unassign`),
  });
  if (done) {
    toast(`Released ${prefix.cidr}`);
    reload();
  }
}

async function unassignDialog(prefix, reload) {
  const done = await confirmDialog({
    title: `Unassign ${prefix.cidr}?`,
    body: `${customerName(prefix.customer)} loses access straight away. Their ${plural(prefix.recordCount, 'address record')} in this subnet will be deleted so the next customer cannot see them.`,
    confirmLabel: 'Unassign subnet',
    fields: prefix.rdnsCount
      ? [{ name: 'removeRdns', type: 'checkbox', value: true, label: `Also remove ${plural(prefix.rdnsCount, 'PTR record')} from Cloudflare` }]
      : [],
    onConfirm: (values) => post(`/api/admin/prefixes/${prefix.id}/unassign`, { removeRdns: values.removeRdns !== false }),
  });
  if (done) {
    toast(`Unassigned ${prefix.cidr}`);
    reportPtr(done);
    reload();
  }
}

async function splitDialog(prefix, reload) {
  const maxLength = prefix.family === 4 ? 32 : 128;
  const done = await formDialog({
    title: `Split ${prefix.cidr}`,
    intro: prefix.customer ? 'Creates equal child prefixes as labels. The subnet stays assigned as it is.' : 'Creates equal child prefixes and turns this prefix into a container. Existing prefixes stay where they are.',
    submitLabel: 'Split prefix',
    fields: [{ name: 'length', label: 'New prefix length', type: 'number', value: Math.min(prefix.length + 1, maxLength), min: prefix.length + 1, max: maxLength, required: true }],
    onInput: ({ length }, setNote) => {
      const n = Number(length) - prefix.length;
      setNote(n > 0 && n <= 8 ? `Creates ${2 ** n} prefixes of /${length}.` : 'A split can create up to 256 prefixes.');
    },
    onSubmit: (values) => post(`/api/admin/prefixes/${prefix.id}/split`, { length: Number(values.length) }),
  });
  if (done) {
    toast(`Split ${prefix.cidr}`);
    reload();
  }
}

async function editDialog(prefix, reload) {
  const done = await formDialog({
    title: `Edit ${prefix.cidr}`,
    submitLabel: 'Save changes',
    fields: [
      ...prefixFields(prefix, await datacenterOptions('None')),
      {
        name: 'gateway',
        label: 'Gateway',
        mono: true,
        value: prefix.gatewayOverride ?? '',
        placeholder: prefix.gateway ?? 'First usable address',
        hint: 'Leave blank to use the first usable address.',
      },
    ],
    onSubmit: (values) => patch(`/api/admin/prefixes/${prefix.id}`, values),
  });
  if (done) {
    toast('Saved');
    reload();
  }
}

async function deleteDialog(prefix) {
  const cascade = prefix.children.length > 0;
  const lines = [];
  if (cascade) lines.push(`This also deletes ${plural(prefix.children.length, 'child prefix', 'child prefixes')} and everything under them.`);
  if (!prefix.parentId && (prefix.recordCount || prefix.rdnsCount)) {
    lines.push(`${plural(prefix.recordCount, 'address record')} and ${plural(prefix.rdnsCount, 'PTR record')} will be removed.`);
  }
  lines.push('This cannot be undone.');
  const done = await confirmDialog({
    title: `Delete ${prefix.cidr}?`,
    body: lines.join(' '),
    confirmLabel: 'Delete prefix',
    onConfirm: () => del(`/api/admin/prefixes/${prefix.id}${cascade ? '?cascade=true' : ''}`),
  });
  if (done) {
    toast(`Deleted ${prefix.cidr}`);
    reportPtr(done);
    go('/prefixes');
  }
}

function allocationMap(prefix) {
  if (!prefix.children.length) return null;
  return h(
    'div',
    { class: 'alloc' },
    h(
      'div',
      { class: 'alloc-track', role: 'img', 'aria-label': `${prefix.utilization.pct}% of ${prefix.cidr} is allocated. The table below lists each subnet.` },
      prefix.children.map((c) =>
        h('a', {
          href: `#/prefixes/${c.id}`,
          class: `alloc-seg ${c.customer ? 'assigned' : ''}`,
          title: `${c.cidr}${c.customer ? ` · ${customerName(c.customer)}` : ''}`,
          tabIndex: -1,
          style: { left: `${c.startOffsetPct}%`, width: `${c.widthPct}%` },
        }),
      ),
    ),
    h(
      'div',
      { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--brand-light)' } }), 'Assigned'),
      h('span', null, h('i', { style: { background: 'var(--brand)' } }), 'Internal'),
      h('span', null, h('i', { style: { background: 'var(--surface-3)' } }), 'Free'),
    ),
  );
}

function subnetsTab(prefix, reload) {
  const children = prefix.children.length
    ? table(
        [{ label: 'Subnet' }, { label: 'Status' }, { label: 'Customer' }, { label: 'Utilization' }, { label: 'Description' }],
        prefix.children.map((c) =>
          h(
            'tr',
            null,
            h('td', { class: 'nowrap' }, prefixLink(c)),
            h('td', null, statusBadge(c)),
            h('td', null, ownerName(c)),
            h('td', null, meter(c.utilization)),
            h('td', { class: 'break' }, c.description),
          ),
        ),
      )
    : emptyState('No subnets yet', 'Allocate one from the free space below.');

  const free = prefix.free.length
    ? table(
        [{ label: 'Free block' }, { label: 'Size' }, { label: '', right: true }],
        prefix.free.map((f) =>
          h(
            'tr',
            { class: 'free' },
            h('td', { class: 'mono nowrap' }, f.cidr),
            h('td', { class: 'nowrap' }, f.size),
            h(
              'td',
              { class: 'right' },
              h('button', { class: 'btn sm', type: 'button', onClick: () => allocateDialog(prefix, reload, f.cidr) }, 'Allocate'),
            ),
          ),
        ),
      )
    : emptyState('No free space', 'Every address in this prefix is allocated.');

  return h('div', null, allocationMap(prefix), children, h('h3', { class: 'section-title', style: { margin: '0', padding: '12px 14px', fontWeight: 600 } }, 'Free space'), free);
}

export async function prefixDetail({ id }, { reload }) {
  const { prefix } = await get(`/api/admin/prefixes/${id}`);
  const isSingle = prefix.length === (prefix.family === 4 ? 32 : 128);
  const fact = (label, value, mono = true) =>
    value === null || value === '' || value === undefined ? null : h('div', null, h('dt', null, label), h('dd', { class: mono ? 'mono' : '' }, value));

  const tabs = [];
  if (!isSingle) tabs.push(['Subnets', () => subnetsTab(prefix, reload)]);
  tabs.push(['Addresses', () => addressTable(prefix)]);
  const startOn = prefix.customer || (!prefix.children.length && prefix.status !== 'container') ? 'Addresses' : tabs[0][0];

  const content = h('div', null);
  const tabButtons = tabs.map(([label, view]) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': String(label === startOn),
        onClick: (event) => {
          tabButtons.forEach((b) => b.setAttribute('aria-selected', 'false'));
          event.target.setAttribute('aria-selected', 'true');
          content.replaceChildren(view());
        },
      },
      label,
    ),
  );
  content.replaceChildren(tabs.find(([label]) => label === startOn)[1]());

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'crumbs' },
      h('a', { href: '#/prefixes' }, 'Prefixes'),
      prefix.ancestors.map((a) => [h('span', null, '/'), h('a', { class: 'mono', href: `#/prefixes/${a.id}` }, a.cidr)]),
    ),
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('div', { class: 'page-title' }, h('h1', { class: 'mono' }, prefix.cidr), statusBadge(prefix)),
        h(
          'p',
          null,
          prefix.internal
            ? ['Internal use', prefix.description ? ` · ${prefix.description}` : '']
            : prefix.customer
              ? ['Assigned to ', h('a', { href: `#/accounts/${prefix.customer.id}` }, customerName(prefix.customer)), prefix.description ? ` · ${prefix.description}` : '']
              : prefix.description,
        ),
      ),
      h(
        'div',
        { class: 'actions' },
        prefix.internal && h('button', { class: 'btn', type: 'button', onClick: () => releaseDialog(prefix, reload) }, 'Release'),
        prefix.customer && h('button', { class: 'btn', type: 'button', onClick: () => unassignDialog(prefix, reload) }, 'Unassign'),
        !prefix.internal && !prefix.customer && h('button', { class: 'btn', type: 'button', onClick: () => assignDialog(prefix, reload) }, 'Assign'),
        !isSingle && h('button', { class: 'btn primary', type: 'button', onClick: () => allocateDialog(prefix, reload) }, 'Allocate subnet'),
        !isSingle && h('button', { class: 'btn', type: 'button', onClick: () => splitDialog(prefix, reload) }, 'Split'),
        h('button', { class: 'btn', type: 'button', onClick: () => editDialog(prefix, reload) }, 'Edit'),
        h('button', { class: 'btn danger', type: 'button', onClick: () => deleteDialog(prefix) }, 'Delete'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'dl',
        { class: 'facts' },
        fact('First address', prefix.firstAddress),
        fact('Last address', prefix.lastAddress),
        fact('Netmask', prefix.netmask),
        fact('Gateway', prefix.gateway),
        fact('Broadcast', prefix.broadcast),
        fact('Size', prefix.size, false),
        fact('Allocated', prefix.utilization.pct === null ? null : meter(prefix.utilization), false),
        fact('Datacenter', prefix.datacenter ? h('a', { href: `#/datacenters/${prefix.datacenter.id}` }, prefix.datacenter.name) : null, false),
        fact('VLAN', prefix.vlan, false),
        fact('Reverse zone', prefix.reverseZones.length === 1 ? prefix.reverseZones[0] : `${prefix.reverseZones[0]} + ${prefix.reverseZones.length - 1} more`),
      ),
    ),
    h('section', { class: 'panel' }, h('div', { class: 'tabs', role: 'tablist' }, tabButtons), content),
  );
}

// ---- accounts ----

function accountFields(user = {}) {
  return [
    [
      { name: 'name', label: 'Contact name', value: user.name, required: true },
      { name: 'company', label: 'Company', value: user.company },
    ],
    [
      { name: 'email', label: 'Email', type: 'email', value: user.email, required: true },
      { name: 'phone', label: 'Phone', value: user.phone },
    ],
    { name: 'notes', label: 'Internal notes', type: 'textarea', value: user.notes, hint: 'Only admins can see these.' },
  ];
}

async function addAccount() {
  const created = await formDialog({
    title: 'Add an account',
    submitLabel: 'Create account',
    fields: [
      {
        name: 'role',
        label: 'Account type',
        type: 'select',
        value: 'customer',
        options: [
          { value: 'customer', label: 'Customer' },
          { value: 'admin', label: 'Admin' },
        ],
      },
      ...accountFields(),
    ],
    onSubmit: (values) => post('/api/admin/users', values),
  });
  if (created) {
    await secretDialog({
      title: 'Account created',
      intro: `Send this temporary password to ${created.user.email} over a secure channel.`,
      secret: created.temporaryPassword,
    });
    go(`/accounts/${created.user.id}`);
  }
}

export async function accounts() {
  const { users } = await get('/api/admin/users');
  return h(
    'div',
    null,
    pageHead('Accounts', `${plural(users.filter((u) => u.role === 'customer').length, 'customer')}, ${plural(users.filter((u) => u.role === 'admin').length, 'admin')}`, [
      h('button', { class: 'btn primary', type: 'button', onClick: addAccount }, icon('plus', 14), 'Add account'),
    ]),
    h(
      'section',
      { class: 'panel' },
      table(
        [{ label: 'Name' }, { label: 'Email' }, { label: 'Type' }, { label: 'Subnets' }, { label: 'Team' }, { label: 'Last sign-in' }],
        users.map((u) =>
          h(
            'tr',
            null,
            h('td', null, h('a', { href: `#/accounts/${u.id}` }, u.company || u.name), u.company ? h('div', { class: 'muted' }, u.name) : ''),
            h('td', { class: 'break' }, u.email),
            h('td', null, u.disabled ? badge('Disabled', 'bad') : badge(u.role === 'admin' ? 'Admin' : 'Customer', u.role === 'admin' ? 'brand' : '')),
            h('td', null, u.role === 'customer' ? u.subnets : ''),
            h('td', null, u.role === 'customer' ? u.members : ''),
            h('td', { class: 'nowrap muted' }, when(u.last_login_at)),
          ),
        ),
      ),
    ),
  );
}

export async function accountDetail({ id }, { reload }) {
  const { user, subnets, members, owner, ptrCount } = await get(`/api/admin/users/${id}`);
  const isSelf = user.id === session.user.id;

  const edit = async () => {
    const fields = owner ? memberFields(user) : accountFields(user);
    if (await formDialog({ title: `Edit ${user.name}`, submitLabel: 'Save changes', fields, onSubmit: (values) => patch(`/api/admin/users/${id}`, values) })) {
      toast('Saved');
      reload();
    }
  };
  const reset = async () => {
    const result = await confirmDialog({
      title: 'Reset password?',
      body: `${user.name} is signed out everywhere and must use the new temporary password.`,
      confirmLabel: 'Reset password',
      onConfirm: () => post(`/api/admin/users/${id}/reset-password`),
    });
    if (result) await secretDialog({ title: 'Password reset', intro: `Send this temporary password to ${user.email} over a secure channel.`, secret: result.temporaryPassword });
  };
  const toggle = async () => {
    const disabling = !user.disabled;
    const done = await confirmDialog({
      title: disabling ? `Disable ${user.name}?` : `Enable ${user.name}?`,
      body: disabling
        ? `They are signed out straight away and cannot sign in.${members.length ? ` ${plural(members.length, 'team member')} also lose access.` : ''} Subnets and records stay as they are.`
        : 'They will be able to sign in again.',
      confirmLabel: disabling ? 'Disable account' : 'Enable account',
      danger: disabling,
      onConfirm: () => patch(`/api/admin/users/${id}`, { disabled: disabling }),
    });
    if (done) reload();
  };
  const remove = async () => {
    const done = await confirmDialog({
      title: `Delete ${user.company || user.name}?`,
      body: [
        members.length ? `Their ${plural(members.length, 'team member')} will be deleted too.` : '',
        ptrCount ? `${plural(ptrCount, 'PTR record')} they created will be removed from Cloudflare.` : '',
        'This cannot be undone. The audit log keeps its history.',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: 'Delete account',
      onConfirm: () => del(`/api/admin/users/${id}`),
    });
    if (done) {
      toast('Account deleted');
      go(owner ? `/accounts/${owner.id}` : '/accounts');
    }
  };
  const addMember = async () => {
    const created = await formDialog({
      title: `Add a team member to ${user.company || user.name}`,
      submitLabel: 'Add member',
      fields: memberFields(),
      onSubmit: (values) => post(`/api/admin/users/${id}/members`, values),
    });
    if (created) {
      await secretDialog({ title: 'Team member added', intro: `Send this temporary password to ${created.member.email} over a secure channel.`, secret: created.temporaryPassword });
      reload();
    }
  };

  const fact = (label, value) => (value ? h('div', null, h('dt', null, label), h('dd', null, value)) : null);

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'crumbs' },
      h('a', { href: '#/accounts' }, 'Accounts'),
      owner && [h('span', null, '/'), h('a', { href: `#/accounts/${owner.id}` }, owner.company || owner.name)],
    ),
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        null,
        h(
          'div',
          { class: 'page-title' },
          h('h1', null, user.company || user.name),
          owner ? accessBadge(user) : user.disabled ? badge('Disabled', 'bad') : badge(user.role === 'admin' ? 'Admin' : 'Customer', user.role === 'admin' ? 'brand' : ''),
        ),
        h('p', null, user.email),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: edit }, 'Edit'),
        !isSelf && h('button', { class: 'btn', type: 'button', onClick: reset }, 'Reset password'),
        !isSelf && h('button', { class: 'btn', type: 'button', onClick: toggle }, user.disabled ? 'Enable' : 'Disable'),
        !isSelf && h('button', { class: 'btn danger', type: 'button', onClick: remove }, 'Delete'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h(
        'dl',
        { class: 'facts' },
        fact('Contact', user.name),
        fact('Phone', user.phone),
        fact('Created', when(user.created_at)),
        fact('Last sign-in', when(user.last_login_at)),
        fact('Internal notes', user.notes),
      ),
    ),
    user.role === 'customer' &&
      !owner &&
      panel(
        'Team',
        members.length
          ? table(
              [{ label: 'Name' }, { label: 'Email' }, { label: 'Access' }, { label: 'Last sign-in' }],
              members.map((m) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('a', { href: `#/accounts/${m.id}` }, m.name)),
                  h('td', { class: 'break' }, m.email),
                  h('td', null, accessBadge(m)),
                  h('td', { class: 'nowrap muted' }, when(m.last_login_at)),
                ),
              ),
            )
          : emptyState('No team members', 'Only the account owner can sign in.'),
        h('button', { class: 'btn sm', type: 'button', onClick: addMember }, 'Add member'),
      ),
    user.role === 'customer' &&
      !owner &&
      panel(
        'Assigned subnets',
        subnets.length
          ? table(
              [{ label: 'Subnet' }, { label: 'Gateway' }, { label: 'Records' }, { label: 'PTRs' }, { label: 'Description' }],
              subnets.map((p) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'nowrap' }, prefixLink(p)),
                  h('td', { class: 'mono nowrap' }, p.gateway ?? ''),
                  h('td', null, p.recordCount),
                  h('td', null, p.rdnsCount),
                  h('td', { class: 'break' }, p.description),
                ),
              ),
            )
          : emptyState('No subnets assigned', 'Open a prefix and choose Assign to customer.', h('a', { class: 'btn', href: '#/prefixes' }, 'Go to prefixes')),
      ),
  );
}

// ---- datacenters ----

function datacenterFields(datacenter = {}) {
  return [
    [
      { name: 'name', label: 'Name', value: datacenter.name, required: true, placeholder: 'Pittsburgh 1' },
      { name: 'code', label: 'Code (optional)', value: datacenter.code, placeholder: 'PIT1' },
    ],
    { name: 'address', label: 'Address (optional)', value: datacenter.address },
    { name: 'notes', label: 'Notes (optional)', type: 'textarea', value: datacenter.notes },
  ];
}

export async function datacenters() {
  const { datacenters: all } = await get('/api/admin/datacenters');

  const add = async () => {
    const created = await formDialog({
      title: 'Add a datacenter',
      submitLabel: 'Add datacenter',
      fields: datacenterFields(),
      onSubmit: (values) => post('/api/admin/datacenters', values),
    });
    if (created) {
      toast(`Added ${created.datacenter.name}`);
      go(`/datacenters/${created.datacenter.id}`);
    }
  };
  const addButton = h('button', { class: 'btn primary', type: 'button', onClick: add }, icon('plus', 14), 'Add datacenter');

  return h(
    'div',
    null,
    pageHead('Datacenters', all.length ? plural(all.length, 'datacenter') : 'Where your prefixes are deployed.', [addButton]),
    h(
      'section',
      { class: 'panel' },
      all.length
        ? table(
            [{ label: 'Name' }, { label: 'Code' }, { label: 'Address' }, { label: 'Prefixes' }, { label: 'Assigned' }],
            all.map((d) =>
              h(
                'tr',
                null,
                h('td', null, h('a', { href: `#/datacenters/${d.id}` }, d.name)),
                h('td', { class: 'mono' }, d.code),
                h('td', { class: 'break' }, d.address),
                h('td', null, d.prefixes),
                h('td', null, d.assigned),
              ),
            ),
          )
        : emptyState('No datacenters yet', 'Add one before you allocate subnets.'),
    ),
  );
}

export async function datacenterDetail({ id }, { reload }) {
  const { datacenter, prefixes: list } = await get(`/api/admin/datacenters/${id}`);

  const edit = async () => {
    const done = await formDialog({
      title: `Edit ${datacenter.name}`,
      submitLabel: 'Save changes',
      fields: datacenterFields(datacenter),
      onSubmit: (values) => patch(`/api/admin/datacenters/${id}`, values),
    });
    if (done) {
      toast('Saved');
      reload();
    }
  };
  const remove = async () => {
    const done = await confirmDialog({
      title: `Delete ${datacenter.name}?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete datacenter',
      onConfirm: () => del(`/api/admin/datacenters/${id}`),
    });
    if (done) {
      toast(`Deleted ${datacenter.name}`);
      go('/datacenters');
    }
  };
  const fact = (label, value) => (value ? h('div', null, h('dt', null, label), h('dd', null, value)) : null);

  return h(
    'div',
    null,
    h('div', { class: 'crumbs' }, h('a', { href: '#/datacenters' }, 'Datacenters')),
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('div', { class: 'page-title' }, h('h1', null, datacenter.name), datacenter.code && badge(datacenter.code))),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onClick: edit }, 'Edit'),
        h('button', { class: 'btn danger', type: 'button', onClick: remove }, 'Delete'),
      ),
    ),
    (datacenter.address || datacenter.notes) &&
      h('section', { class: 'panel' }, h('dl', { class: 'facts' }, fact('Address', datacenter.address), fact('Notes', datacenter.notes))),
    panel(
      'Prefixes',
      list.length
        ? table(
            [{ label: 'Prefix' }, { label: 'Status' }, { label: 'Customer' }, { label: 'VLAN' }, { label: 'Description' }],
            list.map((p) =>
              h(
                'tr',
                null,
                h('td', { class: 'nowrap' }, prefixLink(p)),
                h('td', null, statusBadge(p)),
                h('td', null, ownerName(p)),
                h('td', null, p.vlan ?? ''),
                h('td', { class: 'break' }, p.description),
              ),
            ),
          )
        : emptyState('No prefixes here yet', 'Choose this datacenter when you allocate or edit a prefix.'),
    ),
  );
}

// ---- search ----

export async function search(params, { query }) {
  const q = query.get('q') ?? '';
  const data = await get(`/api/admin/search?q=${encodeURIComponent(q)}`);
  const total = data.prefixes.length + data.addresses.length + data.rdns.length + data.customers.length;
  const prefixHref = (id) => (id ? `#/prefixes/${id}` : '#/prefixes');
  return h(
    'div',
    null,
    pageHead('Search', q ? `${plural(total, 'result')} for “${q}”` : 'Search prefixes, addresses, PTRs and customers.'),
    q && !total && h('section', { class: 'panel' }, emptyState('No results', 'Try an address, hostname, MAC or company name.')),
    data.prefixes.length > 0 &&
      panel(
        'Prefixes',
        table(
          [{ label: 'Prefix' }, { label: 'Customer' }, { label: 'Description' }],
          data.prefixes.map((p) => h('tr', null, h('td', { class: 'nowrap' }, prefixLink(p)), h('td', null, p.customer ?? ''), h('td', { class: 'break' }, p.description))),
        ),
      ),
    data.addresses.length > 0 &&
      panel(
        'Addresses',
        table(
          [{ label: 'Address' }, { label: 'Hostname' }, { label: 'Description' }],
          data.addresses.map((a) => h('tr', null, h('td', { class: 'nowrap' }, h('a', { class: 'mono', href: prefixHref(a.prefixId) }, a.ip)), h('td', { class: 'mono' }, a.hostname), h('td', { class: 'break' }, a.description))),
        ),
      ),
    data.rdns.length > 0 &&
      panel(
        'PTR records',
        table(
          [{ label: 'Address' }, { label: 'Hostname' }],
          data.rdns.map((a) => h('tr', null, h('td', { class: 'nowrap' }, h('a', { class: 'mono', href: prefixHref(a.prefixId) }, a.ip)), h('td', { class: 'mono break' }, a.hostname))),
        ),
      ),
    data.customers.length > 0 &&
      panel(
        'Customers',
        table(
          [{ label: 'Customer' }, { label: 'Email' }],
          data.customers.map((c) => h('tr', null, h('td', null, h('a', { href: `#/accounts/${c.id}` }, c.company || c.name)), h('td', { class: 'break' }, c.email))),
        ),
      ),
  );
}

// ---- audit ----

export async function audit() {
  const state = { page: 0, q: '' };
  const holder = h('div', null);

  async function load() {
    const data = await get(`/api/admin/audit?page=${state.page}&q=${encodeURIComponent(state.q)}`);
    holder.replaceChildren(
      data.entries.length
        ? table(
            [{ label: 'When' }, { label: 'Who' }, { label: 'Action' }, { label: 'Target' }, { label: 'Detail' }, { label: 'From' }],
            data.entries.map((e) =>
              h(
                'tr',
                null,
                h('td', { class: 'nowrap muted' }, when(e.ts)),
                h('td', { class: 'break' }, e.actor),
                h('td', { class: 'mono nowrap' }, e.action),
                h('td', { class: 'mono break' }, e.target),
                h('td', { class: 'break' }, e.detail),
                h('td', { class: 'mono nowrap muted' }, e.ip),
              ),
            ),
          )
        : emptyState('No entries', state.q ? 'Nothing matches that search.' : 'Changes appear here as they happen.'),
      pager(data, (page) => {
        state.page = page;
        load();
      }) ?? '',
    );
  }
  await load();

  return h(
    'div',
    null,
    pageHead('Audit log', 'Every sign-in and change, by admins and customers.'),
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'toolbar' },
        h(
          'div',
          { class: 'grow searchbox' },
          icon('search', 14),
          h('input', {
            type: 'search',
            placeholder: 'Filter by user, action or address',
            'aria-label': 'Filter the audit log',
            onInput: debounce((event) => {
              state.q = event.target.value.trim();
              state.page = 0;
              load();
            }),
          }),
        ),
      ),
      holder,
    ),
  );
}

// ---- settings ----

function coverageView(data) {
  const missing = data.prefixes.flatMap((p) => p.zones).filter((z) => !z.found).length;
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'panel-body' },
      missing
        ? notice(`Connected, but ${plural(missing, 'reverse zone')} ${missing === 1 ? 'is' : 'are'} missing. PTR changes in those ranges will fail until you add the zones to Cloudflare.`)
        : notice('Connected. Every prefix has a reverse zone in Cloudflare.', 'info'),
    ),
    table(
      [{ label: 'Prefix' }, { label: 'Reverse zone' }, { label: 'Status' }],
      data.prefixes.flatMap((p) =>
        p.zones.map((z, i) =>
          h(
            'tr',
            null,
            h('td', { class: 'mono nowrap' }, i === 0 ? p.cidr : ''),
            h('td', { class: 'mono break' }, z.name),
            h('td', null, z.found ? badge('Found', 'good') : badge('Missing', 'bad')),
          ),
        ),
      ),
    ),
  );
}

export async function settings(params, { reload }) {
  const { cloudflare } = await get('/api/admin/settings');
  const results = h('div', null);

  const form = buildForm({
    submitLabel: 'Save settings',
    fields: [
      {
        name: 'token',
        label: 'API token',
        type: 'password',
        autocomplete: 'new-password',
        placeholder: cloudflare.configured ? `Saved (ends ${cloudflare.tokenHint}). Leave blank to keep it.` : 'Paste your API token',
        hint: 'Create a custom token with Zone: Read and DNS: Edit on your reverse zones. It is encrypted here and never shown again.',
      },
      [
        { name: 'accountId', label: 'Account ID (optional)', value: cloudflare.accountId, mono: true, hint: 'Limits the zone search to one account.' },
        { name: 'ttl', label: 'PTR TTL (seconds)', type: 'number', value: cloudflare.ttl, min: 1, max: 86400, required: true, hint: '1 means automatic.' },
      ],
    ],
    extraActions:
      cloudflare.configured &&
      h(
        'button',
        {
          class: 'btn danger spacer',
          type: 'button',
          onClick: async () => {
            const done = await confirmDialog({
              title: 'Remove the API token?',
              body: 'Customers can no longer change reverse DNS. Existing PTR records stay live in Cloudflare.',
              confirmLabel: 'Remove token',
              onConfirm: () => put('/api/admin/settings', { clearToken: true }),
            });
            if (done) {
              session.rdnsEnabled = false;
              reload();
            }
          },
        },
        'Remove token',
      ),
    onSubmit: async (values) => {
      const saved = await put('/api/admin/settings', values);
      session.rdnsEnabled = saved.cloudflare.configured;
      toast('Settings saved');
      reload();
    },
  });

  const run = (label, fn) => async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      results.replaceChildren(h('div', { class: 'panel-body' }, notice(error.message)));
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  return h(
    'div',
    null,
    pageHead('Settings', 'Connect Cloudflare for reverse DNS, and SNMP for router monitoring.'),
    panel('Cloudflare', h('div', { class: 'panel-body' }, form), cloudflare.configured ? badge('Connected', 'good') : badge('Not set up', 'warn')),
    await snmpPanel(),
    cloudflare.configured &&
      panel(
        'Reverse zones',
        results.childElementCount ? results : h('div', null, results, h('div', { class: 'panel-body muted' }, 'Test the connection to check each prefix has a reverse zone. Sync imports PTR records that already exist in Cloudflare.')),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onClick: run('Sync PTR records', async () => {
                const r = await post('/api/admin/rdns/sync');
                toast(`Synced ${plural(r.records, 'PTR record')} from ${plural(r.zones, 'zone')}`);
              }),
            },
            'Sync PTR records',
          ),
          h(
            'button',
            {
              class: 'btn sm primary',
              type: 'button',
              onClick: run('Test connection', async () => {
                const data = await post('/api/admin/settings/test-cloudflare');
                results.parentElement.replaceChildren(results);
                results.replaceChildren(coverageView(data));
              }),
            },
            'Test connection',
          ),
        ),
      ),
  );
}
