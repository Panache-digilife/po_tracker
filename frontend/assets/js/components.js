/* Shared rendering pieces. */

/* The signature element: a fill bar showing dispatched against ordered,
   so an order's real state reads before any number is parsed. */
function gauge(pct, overdue = false) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  let cls = '';
  if (value >= 100) cls = 'full';
  else if (value <= 0) cls = overdue ? 'late' : 'none';
  else if (overdue) cls = 'late';
  return `<div class="gauge">
    <div class="gauge-track">
      <div class="gauge-fill ${cls}" style="width:${value}%"></div>
    </div>
    <span class="gauge-pct">${value.toFixed(0)}%</span>
  </div>`;
}

function badge(status, label) {
  const key = String(status || '').toLowerCase();
  return `<span class="badge ${key}">${esc(label || Fmt.status(status))}</span>`;
}

function dueCell(dateValue, days, pending) {
  if (!dateValue) return '<span class="muted">—</span>';
  const late = days !== null && days < 0 && pending;
  return `<span class="num ${late ? '' : ''}" style="${late ? 'color:var(--alert);font-weight:600' : ''}">
    ${Fmt.date(dateValue)}</span>
    ${late ? `<div class="small" style="color:var(--alert)">${Math.abs(days)} days late</div>` : ''}`;
}

function emptyState(title, message, actionLabel, actionId) {
  return `<div class="empty">
    ${Icons.empty}
    <h3>${esc(title)}</h3>
    <p>${esc(message)}</p>
    ${actionLabel ? `<button class="btn btn-primary" id="${actionId}">${esc(actionLabel)}</button>` : ''}
  </div>`;
}

function loadingBlock() {
  return `<div class="loading-rows"><span class="spinner dark"></span></div>`;
}

function metric(label, value, sub, tone = '') {
  return `<div class="metric ${tone}">
    <div class="metric-label">${esc(label)}</div>
    <div class="metric-value">${value}</div>
    <div class="metric-sub">${sub || ''}</div>
  </div>`;
}

function searchBox(id, placeholder) {
  return `<div class="search">${Icons.search}
    <input type="search" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off">
  </div>`;
}

/* ------------------------------------------------------------ overlays */

const Overlay = {
  el: () => document.getElementById('overlay'),
  show() { Overlay.el().classList.add('open'); },
  hide() {
    Overlay.el().classList.remove('open');
    Drawer.close();
    Modal.close();
  }
};

const Drawer = {
  open(html) {
    const drawer = document.getElementById('drawer');
    drawer.innerHTML = html;
    drawer.classList.add('open');
    Overlay.show();
    const first = drawer.querySelector('[data-autofocus]');
    if (first) first.focus();
  },
  close() {
    document.getElementById('drawer').classList.remove('open');
  },
  isOpen: () => document.getElementById('drawer').classList.contains('open')
};

const Modal = {
  open(html, wide = false) {
    const modal = document.getElementById('modal');
    modal.className = 'modal open' + (wide ? ' wide' : '');
    modal.innerHTML = html;
    Overlay.show();
    const first = modal.querySelector('[data-autofocus]');
    if (first) first.focus();
  },
  close() {
    const modal = document.getElementById('modal');
    modal.classList.remove('open');
    if (!Drawer.isOpen()) {
      Overlay.el().classList.remove('open');
    }
  },
  isOpen: () => document.getElementById('modal').classList.contains('open'),
  confirm(title, message, confirmLabel, onConfirm, danger = true) {
    Modal.open(`
      <div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="modal-body"><p style="margin:0;line-height:1.6">${esc(message)}</p></div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmYes" data-autofocus>
          ${esc(confirmLabel)}</button>
      </div>`);
    document.getElementById('confirmYes').onclick = async () => {
      Overlay.hide();
      await onConfirm();
    };
  }
};

/* Close controls are wired once, globally. */
document.addEventListener('click', (event) => {
  if (event.target.id === 'overlay' || event.target.closest('[data-close]')) {
    Overlay.hide();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (Drawer.isOpen() || Modal.isOpen())) {
    Overlay.hide();
  }
});

/* ------------------------------------------------------------ form helpers */

function fieldText(id, label, value = '', opts = {}) {
  const { type = 'text', required = false, hint = '', placeholder = '', attrs = '' } = opts;
  return `<div class="field">
    <label for="${id}">${esc(label)}${required ? '' : ' <span class="hint">optional</span>'}
      ${hint ? `<span class="hint"> · ${esc(hint)}</span>` : ''}</label>
    <input type="${type}" id="${id}" value="${esc(value)}"
      placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${attrs}>
  </div>`;
}

function fieldSelect(id, label, options, selected, opts = {}) {
  const { required = false, hint = '' } = opts;
  const items = options.map(o =>
    `<option value="${esc(o.value)}" ${String(o.value) === String(selected) ? 'selected' : ''}>
      ${esc(o.label)}</option>`).join('');
  return `<div class="field">
    <label for="${id}">${esc(label)}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</label>
    <select id="${id}" ${required ? 'required' : ''}>${items}</select>
  </div>`;
}

/* Searchable dropdown: a text input that filters a list, backed by a hidden
   input holding the real value. The hidden input keeps the id the caller
   passed in, so existing val(id) / numVal(id) reads work unchanged —
   swapping a fieldSelect() for a fieldCombo() needs no change anywhere
   else that reads the value, only where it's rendered and wired. */

function comboBox(id, placeholder, selectedValue, selectedLabel, disabled = false) {
  return `<div class="combo">
    <input type="text" class="combo-input" id="${id}_search" autocomplete="off"
      placeholder="${esc(placeholder)}" value="${esc(selectedLabel || '')}"
      ${disabled ? 'disabled' : ''}>
    <input type="hidden" id="${id}" value="${selectedValue ?? ''}">
    <div class="combo-list" id="${id}_list"></div>
  </div>`;
}

function fieldCombo(id, label, options, selected, opts = {}) {
  const { required = false, hint = '', placeholder = 'Type to search…' } = opts;
  const current = options.find(o => String(o.value) === String(selected));
  return `<div class="field">
    <label for="${id}_search">${esc(label)}${required ? '' : ' <span class="hint">optional</span>'}
      ${hint ? `<span class="hint"> · ${esc(hint)}</span>` : ''}</label>
    ${comboBox(id, placeholder, selected, current ? current.label : '')}
  </div>`;
}

/* Wires a rendered combo box's search input + list to a set of options.
   Works on raw elements so it can back either a static field (looked up
   by id via initFieldCombo) or a dynamically-regenerated table row. */
function wireCombo(searchEl, listEl, options, { getValue, onSelect } = {}) {
  function render(filterText) {
    const needle = filterText.trim().toLowerCase();
    const matches = needle
      ? options.filter(o => o.label.toLowerCase().includes(needle))
      : options;
    listEl.innerHTML = matches.length
      ? matches.slice(0, 50).map(o =>
          `<div class="combo-option" data-value="${esc(String(o.value))}">${esc(o.label)}</div>`
        ).join('')
      : `<div class="combo-empty">No matches</div>`;
    listEl.querySelectorAll('.combo-option').forEach(opt => {
      // Prevent the input's blur from closing the list before the click registers.
      opt.addEventListener('mousedown', e => e.preventDefault());
      opt.addEventListener('click', () => {
        const match = options.find(o => String(o.value) === opt.dataset.value);
        searchEl.value = match ? match.label : '';
        listEl.classList.remove('open');
        if (onSelect) onSelect(match ? match.value : '', match);
      });
    });
  }

  searchEl.addEventListener('focus', () => {
    render('');
    listEl.classList.add('open');
    searchEl.select();
  });
  searchEl.addEventListener('input', () => {
    render(searchEl.value);
    listEl.classList.add('open');
  });
  searchEl.addEventListener('blur', () => {
    // Delay so a click on an option fires before the list is torn down.
    setTimeout(() => {
      listEl.classList.remove('open');
      const current = getValue ? getValue() : null;
      const match = options.find(o => String(o.value) === String(current));
      if (match) searchEl.value = match.label;
    }, 150);
  });
  searchEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      listEl.classList.remove('open');
      searchEl.blur();
    }
    if (event.key === 'Enter' && listEl.classList.contains('open')) {
      const first = listEl.querySelector('.combo-option');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
}

/* Convenience wrapper for the common case: a combo rendered by fieldCombo()
   or comboBox(), looked up by the id it was given. */
function initFieldCombo(id, options, onChange) {
  const search = document.getElementById(`${id}_search`);
  const hidden = document.getElementById(id);
  const list = document.getElementById(`${id}_list`);
  if (!search || !hidden || !list) return;
  wireCombo(search, list, options, {
    getValue: () => hidden.value,
    onSelect: (value) => {
      hidden.value = value;
      if (onChange) onChange(value);
    }
  });
}

function fieldArea(id, label, value = '', placeholder = '') {
  return `<div class="field">
    <label for="${id}">${esc(label)} <span class="hint">optional</span></label>
    <textarea id="${id}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
  </div>`;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function numVal(id) {
  const raw = val(id);
  return raw === '' ? null : Number(raw);
}

function orNull(value) {
  return value === '' || value === undefined ? null : value;
}

async function submitting(button, work) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Saving';
  try {
    await work();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}
