// DOM, API and dialog helpers. Everything renders through h(), which only ever creates text nodes,
// so customer-typed values cannot become markup.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && key !== 'list' && !key.startsWith('aria') && key !== 'role') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const ICONS = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  tree: 'M12 3v6M12 9H6v4M12 9h6v4M3 13h6v6H3zM15 13h6v6h-6z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.8H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.9-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 1 1 8 0v4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chevron: 'M9 6l6 6-6 6',
  pulse: 'M3 12h4l3 8 4-16 3 8h4',
  map: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 6h6M7.5 8.6l3 6.8M16.5 8.6l-3 6.8',
  close: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  server: 'M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 13h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM7 7h.01M7 17h.01',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

export class ApiFailure extends Error {
  constructor(status, error) {
    super(error?.message ?? 'Something went wrong');
    this.status = status;
    this.code = error?.code;
    this.field = error?.field;
    this.detail = error;
  }
}

export const session = { user: null, rdnsEnabled: false, onSignedOut: () => {} };

export async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, { message: 'Could not reach the server. Check your connection and try again.' });
  }
  const data = await response.json().catch(() => null);
  if (response.ok) return data;
  if (response.status === 401 && !url.startsWith('/api/auth/')) session.onSignedOut();
  throw new ApiFailure(response.status, data?.error);
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const patch = (url, body = {}) => api('PATCH', url, body);
export const del = (url) => api('DELETE', url);

export function toast(message, kind = 'good', ms = 4500) {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function when(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function badge(label, kind = '') {
  return h('span', { class: `badge ${kind}` }, label);
}

export function panel(title, body, action) {
  return h(
    'section',
    { class: 'panel' },
    title && h('div', { class: 'panel-head' }, h('h2', null, title), action),
    body,
  );
}

export function pageHead(title, sub, actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', null, h('h1', null, title), sub && h('p', null, sub)),
    actions && h('div', { class: 'actions' }, actions),
  );
}

export function table(columns, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.right ? 'right' : '' }, c.label)))),
      h('tbody', null, rows),
    ),
  );
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('strong', null, title), text, action && h('div', null, action));
}

export function notice(content, kind = '') {
  return h('div', { class: `notice ${kind}` }, icon(kind === 'info' ? 'info' : 'alert'), h('div', null, content));
}

export function meter(utilization) {
  if (utilization.pct === null) return h('span', { class: 'muted' }, '—');
  const pct = utilization.pct;
  const label = pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  return h(
    'div',
    { class: 'meter', title: `${pct}% of ${utilization.basis === 'prefixes' ? 'this prefix is allocated' : 'usable addresses are recorded'}` },
    h(
      'div',
      { class: 'meter-track' },
      h('span', { class: `meter-fill ${pct >= 90 ? 'full' : ''}`, style: { width: `${Math.max(pct, pct > 0 ? 1 : 0)}%` } }),
    ),
    h('span', { class: 'value' }, label),
  );
}

export function pager({ page, pageSize, total }, onPage) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const first = page * pageSize + 1;
  return h(
    'div',
    { class: 'pager' },
    h('span', null, `${first.toLocaleString()}–${Math.min(first + pageSize - 1, total).toLocaleString()} of ${total.toLocaleString()}`),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn sm', type: 'button', disabled: page === 0, onClick: () => onPage(page - 1) }, 'Previous'),
      h('button', { class: 'btn sm', type: 'button', disabled: page + 1 >= pages, onClick: () => onPage(page + 1) }, 'Next'),
    ),
  );
}

// ---- dialogs ----

export function openDialog(content, { title, wide } = {}) {
  const dialog = h('dialog', { 'aria-label': title, style: wide ? { width: 'min(640px, calc(100vw - 24px))' } : {} });
  const close = () => dialog.close();
  dialog.append(
    h(
      'div',
      { class: 'dialog-head' },
      h('h2', null, title),
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'Close', onClick: close }, icon('close')),
    ),
    h('div', { class: 'dialog-body' }, content(close)),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function control(field) {
  const id = `f-${field.name}-${Math.random().toString(36).slice(2, 7)}`;
  const common = {
    id,
    name: field.name,
    required: field.required,
    placeholder: field.placeholder,
    autocomplete: field.autocomplete ?? 'off',
    disabled: field.disabled,
    class: field.mono ? 'mono' : null,
  };
  if (field.type === 'checkbox') {
    return h(
      'label',
      { class: 'check' },
      h('input', { id, name: field.name, type: 'checkbox', checked: Boolean(field.value) }),
      h('span', null, field.label),
    );
  }
  let input;
  if (field.type === 'select') {
    input = h(
      'select',
      common,
      field.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(field.value ?? '') }, o.label)),
    );
  } else if (field.type === 'textarea') {
    input = h('textarea', { ...common, rows: 3, value: field.value ?? '' });
  } else {
    input = h('input', {
      ...common,
      type: field.type ?? 'text',
      value: field.value ?? '',
      min: field.min,
      max: field.max,
      spellcheck: false,
    });
  }
  return h(
    'div',
    { class: 'field', 'data-field': field.name },
    h('label', { htmlFor: id }, field.label),
    input,
    field.hint && h('div', { class: 'hint' }, field.hint),
  );
}

function clearErrors(form) {
  form.querySelectorAll('.err, .form-error').forEach((el) => el.remove());
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
}

export function showFormError(form, error) {
  clearErrors(form);
  const target = error.field && form.querySelector(`[data-field="${error.field}"]`);
  if (target) {
    target.classList.add('invalid');
    target.append(h('div', { class: 'err' }, error.message));
    target.querySelector('input, select, textarea')?.focus();
  } else {
    form.prepend(h('div', { class: 'form-error', role: 'alert' }, error.message));
  }
}

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

// Builds a form that stays open and shows the error in place when the request fails.
export function buildForm({ fields, submitLabel, cancelLabel = 'Cancel', onSubmit, danger, onCancel, extraActions, onInput }) {
  const note = h('div', { class: 'form-note', hidden: true });
  const submit = submitLabel ? h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, type: 'submit' }, submitLabel) : null;
  const rows = fields.map((f) => {
    if (f instanceof Node) return f;
    return Array.isArray(f) ? h('div', { class: 'form-row' }, f.map(control)) : control(f);
  });
  const form = h(
    'form',
    {
      class: 'form',
      novalidate: false,
      onSubmit: async (event) => {
        event.preventDefault();
        if (!submit) return;
        clearErrors(form);
        submit.disabled = true;
        try {
          await onSubmit(formValues(form), form);
        } catch (error) {
          if (!(error instanceof ApiFailure)) throw error;
          showFormError(form, error);
        } finally {
          submit.disabled = false;
        }
      },
    },
    rows,
    note,
    h(
      'div',
      { class: 'dialog-actions' },
      extraActions,
      onCancel && h('button', { class: 'btn', type: 'button', onClick: onCancel }, cancelLabel),
      submit,
    ),
  );
  if (onInput) {
    const setNote = (text) => {
      note.hidden = !text;
      note.textContent = text ?? '';
    };
    const run = debounce(() => onInput(formValues(form), setNote));
    form.addEventListener('input', run);
    queueMicrotask(run);
  }
  return form;
}

export function formDialog({ title, intro, wide, onSubmit, ...options }) {
  return new Promise((resolve) => {
    let result = null;
    const dialog = openDialog(
      (close) =>
        h(
          'div',
          { class: 'form' },
          intro && h('p', { class: 'muted' }, intro),
          buildForm({
            ...options,
            onCancel: close,
            onSubmit: async (values, form) => {
              result = (await onSubmit(values, form)) ?? true;
              close();
            },
          }),
        ),
      { title, wide },
    );
    dialog.addEventListener('close', () => resolve(result));
  });
}

export function confirmDialog({ title, body, confirmLabel, danger = true, fields = [], onConfirm }) {
  return formDialog({ title, intro: body, fields, submitLabel: confirmLabel, danger, onSubmit: onConfirm });
}

export function secretDialog({ title, intro, secret }) {
  return new Promise((resolve) => {
    const dialog = openDialog(
      (close) =>
        h(
          'div',
          { class: 'form' },
          h('p', null, intro),
          h(
            'div',
            { class: 'secret' },
            h('code', null, secret),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onClick: async (event) => {
                  await navigator.clipboard?.writeText(secret);
                  event.target.textContent = 'Copied';
                },
              },
              'Copy',
            ),
          ),
          h('p', { class: 'muted' }, 'This password is not shown again. It must be changed at first sign-in.'),
          h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onClick: close }, 'Done')),
        ),
      { title },
    );
    dialog.addEventListener('close', () => resolve());
  });
}

export function go(path) {
  location.hash = `#${path}`;
}
