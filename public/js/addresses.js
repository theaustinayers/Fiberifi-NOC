// The address table and editor, shared by the admin prefix page and the customer subnet page.
import {
  ApiFailure,
  badge,
  buildForm,
  debounce,
  del,
  emptyState,
  formDialog,
  get,
  h,
  icon,
  openDialog,
  pager,
  put,
  session,
  table,
  toast,
} from './lib.js';

export const STATUS = {
  in_use: ['In use', 'brand'],
  reserved: ['Reserved', 'warn'],
  dhcp: ['DHCP', ''],
};
const ROLE_LABEL = { network: 'Network', gateway: 'Gateway', broadcast: 'Broadcast' };

function addressUrl(subnetId, ip, kind = 'addresses') {
  return `/api/subnets/${subnetId}/${kind}/${encodeURIComponent(ip)}`;
}

export function removePtrButton(subnetId, row, reload) {
  return h(
    'button',
    {
      class: 'btn sm danger',
      type: 'button',
      onClick: async () => {
        await del(addressUrl(subnetId, row.ip, 'rdns'));
        toast(`Removed the PTR for ${row.ip}`);
        reload();
      },
    },
    'Remove PTR',
  );
}

export function editAddress(subnetId, row, onChange) {
  const record = row.record ?? {};
  const isAdmin = session.user.role === 'admin';
  const readOnly = !session.user.canEdit;
  const lock = (field) => {
    if (Array.isArray(field)) return field.map(lock);
    return field instanceof Node ? field : { ...field, disabled: field.disabled || readOnly };
  };
  const initial = {
    hostname: record.hostname ?? '',
    status: record.status ?? 'in_use',
    description: record.description ?? '',
    device: record.device ?? '',
    mac: record.mac ?? '',
  };
  const ptrInitial = row.rdns?.hostname ?? '';
  let ptrHint = 'Goes live in public DNS when you save. Clear it to remove the PTR.';
  if (readOnly) {
    ptrHint = '';
  } else if (!session.rdnsEnabled) {
    ptrHint = isAdmin ? 'Add a Cloudflare API token in Settings to manage PTR records.' : 'Reverse DNS is not available yet. Contact Fiberifi support.';
  }

  // One save for the whole address, so nothing typed in one half is lost by saving the other.
  async function save(values, close) {
    const { ptr, ...fields } = values;
    const recordChanged = Object.keys(initial).some((key) => fields[key].trim() !== initial[key]);
    const ptrValue = ptr.trim();
    const ptrChanged = session.rdnsEnabled && ptrValue !== ptrInitial;
    const blank = !fields.hostname.trim() && !fields.description.trim() && !fields.device.trim() && !fields.mac.trim() && fields.status === 'in_use';

    if (recordChanged) {
      if (blank) await del(addressUrl(subnetId, row.ip));
      else await put(addressUrl(subnetId, row.ip), fields);
    }
    if (ptrChanged) {
      try {
        if (ptrValue) await put(addressUrl(subnetId, row.ip, 'rdns'), { hostname: ptrValue });
        else await del(addressUrl(subnetId, row.ip, 'rdns'));
      } catch (error) {
        if (error instanceof ApiFailure && error.field === 'hostname') error.field = 'ptr';
        if (recordChanged) onChange();
        throw error;
      }
    }
    if (recordChanged || ptrChanged) {
      toast(`Saved ${row.ip}`);
      onChange();
    }
    close();
  }

  openDialog(
    (close) =>
      buildForm({
        submitLabel: readOnly ? null : 'Save changes',
        cancelLabel: readOnly ? 'Close' : 'Cancel',
        onCancel: close,
        fields: [
          [
            { name: 'hostname', label: 'Hostname', value: initial.hostname, placeholder: 'web1', mono: true },
            {
              name: 'status',
              label: 'Status',
              type: 'select',
              value: initial.status,
              options: Object.entries(STATUS).map(([value, [label]]) => ({ value, label })),
            },
          ],
          { name: 'description', label: 'Description', value: initial.description },
          [
            { name: 'device', label: 'Device', value: initial.device },
            { name: 'mac', label: 'MAC address', value: initial.mac, placeholder: '00:1a:2b:3c:4d:5e', mono: true },
          ],
          h('h3', { class: 'section-title' }, 'Reverse DNS'),
          {
            name: 'ptr',
            label: 'PTR hostname',
            value: ptrInitial,
            placeholder: 'mail.example.com',
            mono: true,
            disabled: !session.rdnsEnabled,
            hint: ptrHint,
          },
        ].map(lock),
        onSubmit: (values) => save(values, close),
      }),
    { title: row.ip, wide: true },
  );
}

function rowFor(subnetId, row, reload) {
  const statusInfo = row.record ? STATUS[row.record.status] : null;
  if (row.locked) {
    // A sync can import a PTR that breaks the usable-only rule, so admins get a way to clear it.
    return h(
      'tr',
      { class: 'locked', title: 'Gateway and broadcast addresses cannot be edited.' },
      h('td', { class: 'mono nowrap' }, row.ip),
      h('td', { colSpan: row.rdns ? 4 : 5 }, h('span', { class: 'lock' }, icon('lock', 14), ROLE_LABEL[row.role])),
      row.rdns &&
        h(
          'td',
          { class: 'mono break' },
          row.rdns.hostname,
          session.user.role === 'admin' && [' ', removePtrButton(subnetId, row, reload)],
        ),
    );
  }
  const free = !row.record && !row.rdns;
  return h(
    'tr',
    { class: free ? 'free' : '' },
    h(
      'td',
      { class: 'nowrap' },
      h(
        'button',
        { class: 'cell-link mono', type: 'button', onClick: () => editAddress(subnetId, row, reload) },
        row.ip,
      ),
    ),
    h('td', { class: 'mono' }, row.record?.hostname ?? ''),
    h('td', { class: 'break' }, row.record?.description ?? ''),
    h('td', null, statusInfo ? badge(statusInfo[0], statusInfo[1]) : free ? h('span', { class: 'muted' }, 'Free') : ''),
    h('td', { class: 'mono nowrap' }, row.record?.mac ?? ''),
    h('td', { class: 'mono break' }, row.rdns?.hostname ?? ''),
  );
}

export function addressTable(subnet) {
  const state = { page: 0, view: subnet.family === 4 ? 'all' : 'used', q: '' };
  const body = h('div', null);

  async function load() {
    const query = new URLSearchParams({ page: state.page, view: state.view, q: state.q });
    const data = await get(`/api/subnets/${subnet.id}/addresses?${query}`);
    const rows = data.rows.map((row) => rowFor(subnet.id, row, load));
    body.replaceChildren(
      rows.length
        ? table(
            [
              { label: 'Address' },
              { label: 'Hostname' },
              { label: 'Description' },
              { label: 'Status' },
              { label: 'MAC' },
              { label: 'Reverse DNS' },
            ],
            rows,
          )
        : emptyState(state.q ? 'No matches' : 'No records yet', state.q ? `Nothing here matches “${state.q}”.` : session.user.canEdit ? 'Add an address to start keeping records.' : 'Nothing has been recorded here yet.'),
      pager(data, (page) => {
        state.page = page;
        load();
      }) ?? '',
    );
  }

  const search = h('input', {
    type: 'search',
    placeholder: 'Search hostname, MAC, description',
    'aria-label': 'Search addresses',
    onInput: debounce((event) => {
      state.q = event.target.value.trim();
      state.page = 0;
      load();
    }),
  });

  const addAddress = async () => {
    const ip = await formDialog({
      title: 'Add an address',
      intro: `Enter an address inside ${subnet.cidr}.`,
      submitLabel: 'Continue',
      fields: [{ name: 'ip', label: 'Address', required: true, mono: true, placeholder: subnet.family === 6 ? subnet.firstAddress.replace(/::$/, '::10') : subnet.firstAddress }],
      onSubmit: (values) => values.ip.trim(),
    });
    if (ip) editAddress(subnet.id, { ip, role: null, locked: false, record: null, rdns: null }, load);
  };

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'grow searchbox' }, icon('search', 14), search),
    subnet.family === 4 &&
      h(
        'select',
        {
          'aria-label': 'Which addresses to show',
          onChange: (event) => {
            state.view = event.target.value;
            state.page = 0;
            load();
          },
        },
        h('option', { value: 'all' }, 'All addresses'),
        h('option', { value: 'used' }, 'Recorded only'),
      ),
    h('a', { class: 'btn', href: `/api/subnets/${subnet.id}/export.csv` }, icon('download', 14), 'Export CSV'),
    session.user.canEdit && h('button', { class: 'btn primary', type: 'button', onClick: addAddress }, icon('plus', 14), 'Add address'),
  );

  load().catch((error) => body.replaceChildren(emptyState('Could not load addresses', error.message)));
  return h('div', null, toolbar, body);
}
