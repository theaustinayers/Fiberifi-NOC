import { addressTable } from './addresses.js';
import { ApiFailure, buildForm, emptyState, get, go, h, icon, meter, notice, pageHead, panel, plural, post, session, table, toast } from './lib.js';
import { networkMap } from './views-map.js';
import * as routerViews from './views-routers.js';
import { routerSync } from './views-sync.js';
import { teamView } from './team.js';
import * as admin from './views-admin.js';

const app = document.getElementById('app');

// ---- signed-out screens ----

function logoBlock(tagline) {
  return [h('img', { src: '/img/logo.png', alt: 'Fiberifi', width: 168, height: 51 }), h('p', null, tagline)];
}

function renderLogin() {
  document.title = 'Sign in · Fiberifi NOC';
  app.replaceChildren(
    h(
      'main',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        logoBlock('Network Operations'),
        h(
          'div',
          { class: 'panel' },
          buildForm({
            submitLabel: 'Sign in',
            fields: [
              { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' },
              { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' },
            ],
            onSubmit: async (values) => {
              await post('/api/auth/login', values);
              await start();
            },
          }),
        ),
      ),
    ),
  );
  app.querySelector('input')?.focus();
}

function passwordForm(onDone) {
  return buildForm({
    submitLabel: 'Change password',
    fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'newPassword', label: 'New password', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters.' },
    ],
    onSubmit: async (values, form) => {
      await post('/api/auth/change-password', values);
      form.reset();
      await onDone();
    },
  });
}

function renderForcedPassword() {
  document.title = 'Set a password · Fiberifi NOC';
  app.replaceChildren(
    h(
      'main',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        logoBlock('Set a new password to continue'),
        h('div', { class: 'panel' }, passwordForm(start)),
        h('div', { class: 'right' }, h('button', { class: 'btn ghost sm', type: 'button', onClick: signOut }, 'Sign out')),
      ),
    ),
  );
}

async function signOut() {
  await post('/api/auth/logout').catch(() => {});
  session.user = null;
  location.hash = '';
  renderLogin();
}

// ---- customer views ----

async function mySubnets() {
  const { subnets } = await get('/api/subnets');
  return h(
    'div',
    null,
    pageHead('My subnets', subnets.length ? plural(subnets.length, 'subnet') : null),
    h(
      'section',
      { class: 'panel' },
      subnets.length
        ? table(
            [{ label: 'Subnet' }, { label: 'Gateway' }, { label: 'Broadcast' }, { label: 'Usable' }, { label: 'Recorded' }, { label: 'PTRs' }, { label: 'Description' }],
            subnets.map((s) =>
              h(
                'tr',
                null,
                h('td', { class: 'nowrap' }, h('a', { class: 'mono', href: `#/subnets/${s.id}` }, s.cidr)),
                h('td', { class: 'mono nowrap' }, s.gateway ?? '—'),
                h('td', { class: 'mono nowrap' }, s.broadcast ?? '—'),
                h('td', { class: 'nowrap' }, s.usable),
                h('td', null, s.utilization.pct === null ? s.recordCount : meter(s.utilization)),
                h('td', null, s.rdnsCount),
                h('td', { class: 'break' }, s.description),
              ),
            ),
          )
        : emptyState('No subnets yet', 'Your subnets appear here once Fiberifi assigns them.'),
    ),
  );
}

async function subnetView({ id }) {
  const { subnet } = await get(`/api/subnets/${id}`);
  const fact = (label, value, mono = true) => (value ? h('div', null, h('dt', null, label), h('dd', { class: mono ? 'mono' : '' }, value)) : null);
  return h(
    'div',
    null,
    h('div', { class: 'crumbs' }, h('a', { href: '#/subnets' }, 'My subnets')),
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('div', { class: 'page-title' }, h('h1', { class: 'mono' }, subnet.cidr)), subnet.description && h('p', null, subnet.description)),
    ),
    !session.user.canEdit && notice('You have read-only access. Ask your account admin if you need to make changes.', 'info'),
    session.user.canEdit && !session.rdnsEnabled && notice('Reverse DNS is not available yet. Your address records still work.', 'info'),
    h(
      'section',
      { class: 'panel' },
      h(
        'dl',
        { class: 'facts' },
        fact('Network', subnet.network ?? subnet.firstAddress),
        fact('Gateway', subnet.gateway),
        fact('Broadcast', subnet.broadcast),
        fact('Netmask', subnet.netmask),
        fact('Usable addresses', subnet.usable, false),
        fact('Datacenter', subnet.datacenter?.name, false),
      ),
    ),
    h('section', { class: 'panel' }, addressTable(subnet)),
  );
}

async function account() {
  const { user } = session;
  return h(
    'div',
    null,
    pageHead('Account', user.email),
    panel(
      'Change password',
      h(
        'div',
        { class: 'panel-body', style: { maxWidth: '420px' } },
        passwordForm(() => toast('Password changed. Other devices have been signed out.')),
      ),
    ),
  );
}

// ---- routing ----

const ADMIN_NAV = [
  ['/', 'Overview', 'grid'],
  ['/prefixes', 'Prefixes', 'tree'],
  ['/datacenters', 'Datacenters', 'server'],
  ['/routers', 'Routers', 'pulse'],
  ['/map', 'Network map', 'map'],
  ['/accounts', 'Accounts', 'users'],
  ['/audit', 'Audit log', 'list'],
  ['/settings', 'Settings', 'gear'],
];
const CUSTOMER_NAV = [
  ['/subnets', 'My subnets', 'tree'],
  ['/team', 'Team', 'users'],
  ['/account', 'Account', 'user'],
];

const ADMIN_ROUTES = [
  [/^\/$/, admin.overview, 'Overview'],
  [/^\/prefixes$/, admin.prefixes, 'Prefixes'],
  [/^\/prefixes\/(?<id>\d+)$/, admin.prefixDetail, 'Prefix'],
  [/^\/datacenters$/, admin.datacenters, 'Datacenters'],
  [/^\/datacenters\/(?<id>\d+)$/, admin.datacenterDetail, 'Datacenter'],
  [/^\/map$/, networkMap, 'Network map'],
  [/^\/routers$/, routerViews.routers, 'Routers'],
  [/^\/routers\/sync$/, routerSync, 'Router changes'],
  [/^\/routers\/(?<id>\d+)$/, routerViews.routerDetail, 'Router'],
  [/^\/accounts$/, admin.accounts, 'Accounts'],
  [/^\/accounts\/(?<id>\d+)$/, admin.accountDetail, 'Account'],
  [/^\/search$/, admin.search, 'Search'],
  [/^\/audit$/, admin.audit, 'Audit log'],
  [/^\/settings$/, admin.settings, 'Settings'],
  [/^\/account$/, account, 'Account'],
];
const CUSTOMER_ROUTES = [
  [/^\/$/, mySubnets, 'My subnets'],
  [/^\/subnets$/, mySubnets, 'My subnets'],
  [/^\/subnets\/(?<id>\d+)$/, subnetView, 'Subnet'],
  [/^\/team$/, teamView, 'Team'],
  [/^\/account$/, account, 'Account'],
];

let outlet;
let nav;
let renderToken = 0;

function currentPath() {
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  return { path, query: new URLSearchParams(query) };
}

async function renderRoute() {
  if (!outlet) return;
  const { path, query } = currentPath();
  const isAdmin = session.user.role === 'admin';
  const routes = isAdmin ? ADMIN_ROUTES : CUSTOMER_ROUTES;
  const token = (renderToken += 1);

  for (const link of nav.querySelectorAll('a')) {
    const target = link.getAttribute('href').slice(1);
    const active = target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`);
    if (active || (!isAdmin && path === '/' && target === '/subnets')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.querySelector('.sidebar')?.classList.remove('open');

  const route = routes.map(([pattern, view, title]) => ({ match: path.match(pattern), view, title })).find((r) => r.match);
  if (!route) {
    outlet.replaceChildren(emptyState('Page not found', 'That page does not exist.', h('a', { class: 'btn', href: '#/' }, 'Go home')));
    return;
  }

  document.title = `${route.title} · Fiberifi NOC`;
  if (!outlet.firstChild) outlet.replaceChildren(h('div', { class: 'skeleton' }));
  try {
    const view = await route.view(route.match.groups ?? {}, { query, reload: renderRoute });
    if (token === renderToken) {
      outlet.replaceChildren(view);
      window.scrollTo?.(0, 0);
    }
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    if (error.status === 401) return;
    if (token === renderToken) {
      outlet.replaceChildren(
        emptyState(error.status === 404 ? 'Not found' : 'Could not load this page', error.message, h('a', { class: 'btn', href: '#/' }, 'Go home')),
      );
    }
  }
}

function renderShell() {
  const { user } = session;
  const isAdmin = user.role === 'admin';
  const items = isAdmin ? ADMIN_NAV : CUSTOMER_NAV.filter(([path]) => path !== '/team' || user.canManageTeam);

  nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main' },
    items.map(([path, label, iconName]) => h('a', { href: `#${path}` }, icon(iconName), label)),
  );
  outlet = h('main', { class: 'main' });

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/img/logo.png', alt: 'Fiberifi', width: 128, height: 39 }), h('span', null, 'Network Operations')),
    isAdmin &&
      h(
        'form',
        {
          class: 'searchbox',
          role: 'search',
          onSubmit: (event) => {
            event.preventDefault();
            const q = event.target.elements.q.value.trim();
            if (q) go(`/search?q=${encodeURIComponent(q)}`);
          },
        },
        icon('search', 14),
        h('input', { name: 'q', type: 'search', placeholder: 'Search everything', 'aria-label': 'Search everything' }),
      ),
    nav,
    h(
      'div',
      { class: 'who' },
      h(
        'div',
        null,
        h('strong', null, h('a', { href: '#/account' }, user.name)),
        h('small', null, user.accountName || user.email),
      ),
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onClick: signOut }, icon('out')),
    ),
  );

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('a', { href: '#/' }, h('img', { src: '/img/logo.png', alt: 'Fiberifi', width: 96, height: 29 })),
    h(
      'button',
      { class: 'btn ghost icon', type: 'button', 'aria-label': 'Menu', onClick: () => sidebar.classList.toggle('open') },
      icon('menu', 20),
    ),
  );

  app.replaceChildren(topbar, h('div', { class: 'layout' }, sidebar, outlet));
  renderRoute();
}

async function start() {
  try {
    const me = await get('/api/auth/me');
    session.user = me.user;
    session.rdnsEnabled = me.rdnsEnabled;
  } catch (error) {
    if (error.status === 401) return renderLogin();
    app.replaceChildren(h('main', { class: 'auth' }, emptyState('Could not reach the panel', error.message)));
    return undefined;
  }
  if (session.user.mustChangePassword) return renderForcedPassword();
  return renderShell();
}

session.onSignedOut = () => {
  session.user = null;
  outlet = null;
  renderLogin();
};

window.addEventListener('hashchange', renderRoute);
start();
