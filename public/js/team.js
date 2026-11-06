import { badge, confirmDialog, del, emptyState, formDialog, get, h, icon, pageHead, patch, post, secretDialog, session, table, toast, when } from './lib.js';

export const ACCESS_LABEL = { admin: 'Admin', read_only: 'Read only' };

export function memberFields(member = {}) {
  return [
    [
      { name: 'name', label: 'Name', value: member.name, required: true },
      { name: 'email', label: 'Email', type: 'email', value: member.email, required: true },
    ],
    {
      name: 'access',
      label: 'Access',
      type: 'select',
      value: member.access ?? 'read_only',
      options: [
        { value: 'read_only', label: 'Read only: can view and export' },
        { value: 'admin', label: 'Admin: can edit records and rDNS, and manage the team' },
      ],
    },
  ];
}

export function accessBadge(member) {
  if (member.disabled) return badge('Disabled', 'bad');
  return badge(ACCESS_LABEL[member.access], member.access === 'admin' ? 'brand' : '');
}

export async function teamView(params, { reload }) {
  const { owner, members } = await get('/api/team');

  const add = async () => {
    const created = await formDialog({
      title: 'Add a team member',
      intro: 'They get their own login to this account.',
      submitLabel: 'Add member',
      fields: memberFields(),
      onSubmit: (values) => post('/api/team', values),
    });
    if (created) {
      await secretDialog({
        title: 'Team member added',
        intro: `Send this temporary password to ${created.member.email} over a secure channel.`,
        secret: created.temporaryPassword,
      });
      reload();
    }
  };

  const edit = async (member) => {
    const done = await formDialog({
      title: `Edit ${member.name}`,
      submitLabel: 'Save changes',
      fields: memberFields(member),
      onSubmit: (values) => patch(`/api/team/${member.id}`, values),
    });
    if (done) {
      toast('Saved');
      reload();
    }
  };

  const reset = async (member) => {
    const result = await confirmDialog({
      title: 'Reset password?',
      body: `${member.name} is signed out everywhere and must use the new temporary password.`,
      confirmLabel: 'Reset password',
      onConfirm: () => post(`/api/team/${member.id}/reset-password`),
    });
    if (result) await secretDialog({ title: 'Password reset', intro: `Send this temporary password to ${member.email} over a secure channel.`, secret: result.temporaryPassword });
  };

  const toggle = async (member) => {
    const disabling = !member.disabled;
    const done = await confirmDialog({
      title: disabling ? `Disable ${member.name}?` : `Enable ${member.name}?`,
      body: disabling ? 'They are signed out straight away and cannot sign in.' : 'They will be able to sign in again.',
      confirmLabel: disabling ? 'Disable login' : 'Enable login',
      danger: disabling,
      onConfirm: () => patch(`/api/team/${member.id}`, { disabled: disabling }),
    });
    if (done) reload();
  };

  const remove = async (member) => {
    const done = await confirmDialog({
      title: `Remove ${member.name}?`,
      body: 'Their login is deleted. Address records and PTRs they created stay on the account.',
      confirmLabel: 'Remove member',
      onConfirm: () => del(`/api/team/${member.id}`),
    });
    if (done) {
      toast(`Removed ${member.name}`);
      reload();
    }
  };

  const button = (label, onClick, kind = '') => h('button', { class: `btn sm ${kind}`, type: 'button', onClick }, label);
  const isSelf = (member) => member.id === session.user.id;

  const rows = [
    h(
      'tr',
      null,
      h('td', null, owner.name),
      h('td', { class: 'break' }, owner.email),
      h('td', null, badge('Owner', 'good')),
      h('td', { class: 'nowrap muted' }, when(owner.last_login_at)),
      h('td', null, ''),
    ),
    ...members.map((m) =>
      h(
        'tr',
        null,
        h('td', null, m.name, isSelf(m) ? h('span', { class: 'muted' }, ' (you)') : ''),
        h('td', { class: 'break' }, m.email),
        h('td', null, accessBadge(m)),
        h('td', { class: 'nowrap muted' }, when(m.last_login_at)),
        h(
          'td',
          { class: 'right' },
          h(
            'div',
            { class: 'actions row-actions' },
            button('Edit', () => edit(m)),
            !isSelf(m) && button('Reset password', () => reset(m)),
            !isSelf(m) && button(m.disabled ? 'Enable' : 'Disable', () => toggle(m)),
            !isSelf(m) && button('Remove', () => remove(m), 'danger'),
          ),
        ),
      ),
    ),
  ];

  return h(
    'div',
    null,
    pageHead('Team', 'People who can sign in to this account.', [
      h('button', { class: 'btn primary', type: 'button', onClick: add }, icon('plus', 14), 'Add member'),
    ]),
    h(
      'section',
      { class: 'panel' },
      table([{ label: 'Name' }, { label: 'Email' }, { label: 'Access' }, { label: 'Last sign-in' }, { label: '', right: true }], rows),
      !members.length && emptyState('Just you so far', 'Add a teammate to help manage your subnets and rDNS.'),
    ),
  );
}
