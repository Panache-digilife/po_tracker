/* Shell: navigation, hash routing, page actions. */

const ROUTES = [
  { path: 'dashboard', title: 'Overview', icon: 'dashboard', view: 'dashboard',
    section: 'Track' },
  { path: 'orders', title: 'Customer orders', icon: 'orders', view: 'orders' },
  { path: 'dispatches', title: 'Dispatches', icon: 'dispatch', view: 'dispatches' },
  { path: 'invoices', title: 'Invoices', icon: 'invoice', view: 'invoices' },
  { path: 'customers', title: 'Customers', icon: 'customers', view: 'customers',
    section: 'Masters' },
  { path: 'outstanding', title: 'Outstanding', icon: 'invoice', view: 'outstanding' },
  { path: 'items', title: 'Items', icon: 'items', view: 'items' },
  { path: 'users', title: 'Users', icon: 'users', view: 'users',
    section: 'Administration', roles: ['admin'] },
  { path: 'audit', title: 'Audit trail', icon: 'audit', view: 'audit',
    roles: ['admin', 'manager'] }
];

const Router = {
  current: null,

  parse() {
    const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    const [path, ...rest] = raw.split('/');
    return { path: path || 'dashboard', args: rest };
  },

  async go() {
    const { path, args } = Router.parse();
    const route = ROUTES.find(r => r.path === path) || ROUTES[0];

    if (route.roles && !Session.can(...route.roles)) {
      location.hash = '#/dashboard';
      return;
    }

    Router.current = route;
    document.getElementById('pageTitle').textContent = route.title;
    renderNav();
    renderPageActions(route);
    document.getElementById('nav').classList.remove('open');

    const page = document.getElementById('page');
    page.innerHTML = loadingBlock();

    try {
      await Views[route.view](page, { status: args[0] });
    } catch (err) {
      page.innerHTML = `<div class="alert-box error">${esc(err.message)}</div>`;
    }
  },

  refresh() {
    if (Router.current) Router.go();
  }
};

function renderNav() {
  const user = Session.user();
  const visible = ROUTES.filter(r => !r.roles || Session.can(...r.roles));
  const { path } = Router.parse();

  document.getElementById('navMenu').innerHTML = visible.map(route => `
    ${route.section ? `<div class="nav-section">${esc(route.section)}</div>` : ''}
    <a class="nav-item ${route.path === path ? 'active' : ''}" href="#/${route.path}">
      ${Icons[route.icon]}<span>${esc(route.title)}</span>
      ${route.path === 'dashboard' && window.__overdue
        ? `<span class="nav-count alert">${window.__overdue}</span>` : ''}
    </a>`).join('');

  document.getElementById('userAvatar').textContent = Fmt.initials(user.name);
  document.getElementById('userName').textContent = user.name;
  document.getElementById('userRole').textContent = user.role;
}

function renderPageActions(route) {
  const actions = document.getElementById('pageActions');
  const buttons = [];

  if (route.path === 'orders') {
    buttons.push(`<button class="btn btn-ghost" id="uploadPo">${Icons.upload} Upload PO</button>`);
    buttons.push(`<button class="btn btn-primary" id="newPo">${Icons.plus} New order</button>`);
  }
  if (route.path === 'users') {
    buttons.push(`<button class="btn btn-primary" id="newUser">${Icons.plus} Add user</button>`);
  }
  if (['dashboard', 'orders'].includes(route.path)) {
    buttons.unshift(`<button class="btn btn-ghost" id="exportAll">
      ${Icons.download} Export all</button>`);
    buttons.unshift(`<button class="btn btn-ghost" id="exportLive">
      ${Icons.download} Export live</button>`);
  }

  actions.innerHTML = buttons.join('');

  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  wire('newPo', () => Forms.orderEditor());
  wire('uploadPo', () => Forms.uploadPO());
  wire('newUser', () => Forms.user());
  wire('exportLive', () => exportOrderBook('live'));
  wire('exportAll', () => exportOrderBook('all'));
}

async function exportOrderBook(status) {
  try {
    const response = await fetch(
      `${API_BASE}/reports/order-book.csv?status=${status}`,
      { headers: { Authorization: `Bearer ${Session.token()}` } }
    );
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `order-book-${status}-${Fmt.today()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast(status === 'all' ? 'All orders exported' : 'Live orders exported');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------ bootstrap */

(async function start() {
  if (!Session.token()) { location.href = 'index.html'; return; }

  document.getElementById('menuToggle').innerHTML = Icons.menu;

  document.getElementById('logoutBtn').onclick = () => {
    Session.clear();
    location.href = 'index.html';
  };
  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('nav').classList.toggle('open');
  };

  try {
    const config = await API.get('/config');
    if (config.company_name) {
      document.getElementById('brandName').textContent = config.company_name;
      document.title = `${config.company_name} · Order Book`;
    }
  } catch { /* branding is optional */ }

  try {
    const stats = await API.get('/reports/dashboard');
    window.__overdue = stats.overdue_lines || 0;
  } catch { /* badge is optional */ }

  window.addEventListener('hashchange', Router.go);
  await Router.go();
})();
