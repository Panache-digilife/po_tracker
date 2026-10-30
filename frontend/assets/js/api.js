/* API client, session and formatting helpers. */

const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.apiBase)
  || localStorage.getItem('ob_api_base')
  || 'https://potracker-navy.vercel.app/';

const Session = {
  token: () => localStorage.getItem('ob_token'),
  user: () => {
    try { return JSON.parse(localStorage.getItem('ob_user') || 'null'); }
    catch { return null; }
  },
  set(token, user) {
    localStorage.setItem('ob_token', token);
    localStorage.setItem('ob_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('ob_token');
    localStorage.removeItem('ob_user');
  },
  can(...roles) {
    const user = Session.user();
    return !!user && roles.includes(user.role);
  },
  seesEverything: () => Session.can('admin', 'manager')
};

const API = {
  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = Session.token();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetch(API_BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('Cannot reach the server. Check your connection.');
    }

    if (response.status === 401 && !path.includes('/auth/login')) {
      Session.clear();
      location.href = 'index.html';
      throw new Error('Session expired');
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!response.ok) {
      const detail = data && data.detail;
      if (Array.isArray(detail)) {
        throw new Error(detail.map(d => d.msg || 'Invalid value').join('. '));
      }
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return data;
  },
  get: (path) => API.request('GET', path),
  post: (path, body) => API.request('POST', path, body),
  patch: (path, body) => API.request('PATCH', path, body),
  del: (path) => API.request('DELETE', path)
};

/* ------------------------------------------------------------ formatting */

const Fmt = {
  money(value, compact = false) {
    const n = Number(value || 0);
    if (compact) {
      if (Math.abs(n) >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
      if (Math.abs(n) >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
    }
    return '₹' + n.toLocaleString('en-IN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  },
  qty(value) {
    const n = Number(value || 0);
    return Number.isInteger(n) ? String(n)
      : n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  },
  date(value) {
    if (!value) return '—';
    const d = new Date(value + 'T00:00:00');
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: '2-digit'
    });
  },
  dateLong(value) {
    if (!value) return '—';
    return new Date(value + 'T00:00:00').toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
    });
  },
  datetime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  },
  days(n) {
    if (n === null || n === undefined) return '—';
    if (n === 0) return 'Today';
    if (n < 0) return `${Math.abs(n)}d late`;
    return `in ${n}d`;
  },
  status(value) {
    return String(value || '').replace(/_/g, ' ');
  },
  initials(name) {
    return String(name || '?').split(' ').filter(Boolean)
      .slice(0, 2).map(p => p[0].toUpperCase()).join('');
  },
  today() {
    return new Date().toISOString().slice(0, 10);
  }
};

/* ------------------------------------------------------------ utilities */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function toast(message, kind = '') {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function debounce(fn, wait = 280) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const Icons = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  orders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  dispatch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  invoice: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5z"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>',
  customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  items: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/></svg>',
  reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6M19 8v6"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>'
};
