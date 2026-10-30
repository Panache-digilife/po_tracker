/* Page renderers. Each returns nothing; it writes into #page. */

const Views = {};
const State = { customers: [], items: [], users: [] };

async function loadReferenceData(force = false) {
  if (!force && State.customers.length) return;
  const [customers, items, users] = await Promise.all([
    API.get('/customers'),
    API.get('/items'),
    API.get('/users')
  ]);
  State.customers = customers;
  State.items = items;
  State.users = users;
}

/* ============================================================ dashboard */

Views.dashboard = async function (page) {
  page.innerHTML = `<div class="metrics" id="metrics">${loadingBlock()}</div>
    <div class="grid-3">
      <div class="card">
        <div class="card-head">
          <h2>Needs attention</h2>
          <div class="card-actions">
            <select id="horizon" style="width:auto">
              <option value="7">Next 7 days</option>
              <option value="14">Next 14 days</option>
              <option value="30">Next 30 days</option>
            </select>
          </div>
        </div>
        <div class="card-body flush" id="actions">${loadingBlock()}</div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><h2>Receivables ageing</h2></div>
          <div class="card-body" id="ageing">${loadingBlock()}</div>
        </div>
      </div>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="card-head"><h2>Dispatched vs invoiced</h2>
          <span class="small muted">Last 6 months</span></div>
        <div class="card-body">
          <div class="chart-box"><canvas id="trendChart"></canvas></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><h2>Order status</h2></div>
          <div class="card-body">
            <div class="chart-box chart-box-sm"><canvas id="statusChart"></canvas></div>
            <div id="statusLegend" style="margin-top:14px"></div>
          </div>
        </div>
      </div>
    </div>`;

  const [stats, ageing, trend, statusBreakdown] = await Promise.all([
    API.get('/reports/dashboard'),
    API.get('/reports/ageing'),
    API.get('/reports/trend'),
    API.get('/reports/status-breakdown')
  ]);

  document.getElementById('metrics').innerHTML = [
    metric('Order book', Fmt.money(stats.order_book_value, true),
      `${stats.open_pos} live orders`, 'is-blueprint'),
    metric('Pending value', Fmt.money(stats.pending_value, true),
      'Ordered but not dispatched', 'is-signal'),
    metric('Overdue lines', stats.overdue_lines,
      stats.overdue_lines ? 'Past required date' : 'All on schedule',
      stats.overdue_lines ? 'is-alert' : 'is-go'),
    metric('Outstanding', Fmt.money(stats.outstanding_receivables, true),
      `${Fmt.money(stats.overdue_receivables, true)} overdue`,
      Number(stats.overdue_receivables) > 0 ? 'is-alert' : ''),
    metric('Invoiced this month', Fmt.money(stats.invoiced_this_month, true),
      `${stats.dispatches_this_month} dispatches`, 'is-go')
  ].join('');

  renderAgeing(ageing);
  renderTrendChart(trend);
  renderStatusChart(statusBreakdown);
  await renderActions(7);

  document.getElementById('horizon').onchange = (e) => renderActions(Number(e.target.value));
};

/* Reads real colour values (not CSS var() strings, which Chart.js can't use
   directly) so the charts stay in sync with the app's design tokens. */
function chartColour(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let trendChartInstance = null;
function renderTrendChart(trend) {
  const canvas = document.getElementById('trendChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (trendChartInstance) trendChartInstance.destroy();

  const blueprint = chartColour('--blueprint-2');
  const go = chartColour('--go');
  const line = chartColour('--line');
  const steel = chartColour('--steel');

  trendChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: trend.map(t => t.label),
      datasets: [
        {
          label: 'Dispatched',
          data: trend.map(t => Number(t.dispatched_value)),
          backgroundColor: blueprint,
          borderRadius: 4,
          maxBarThickness: 34
        },
        {
          label: 'Invoiced',
          data: trend.map(t => Number(t.invoiced_value)),
          backgroundColor: go,
          borderRadius: 4,
          maxBarThickness: 34
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle',
            font: { family: "Inter", size: 12 }, color: steel }
        },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Fmt.money(ctx.parsed.y, true)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: "Inter", size: 11 }, color: steel } },
        y: {
          grid: { color: line },
          ticks: {
            font: { family: "JetBrains Mono", size: 10 }, color: steel,
            callback: (v) => Fmt.money(v, true)
          }
        }
      }
    }
  });
}

let statusChartInstance = null;
function renderStatusChart(rows) {
  const canvas = document.getElementById('statusChart');
  const legend = document.getElementById('statusLegend');
  if (!canvas || typeof Chart === 'undefined') return;
  if (statusChartInstance) statusChartInstance.destroy();

  if (!rows.length) {
    canvas.parentElement.innerHTML = '<p class="muted small" style="margin:0;padding:20px 0;text-align:center">No orders yet.</p>';
    return;
  }

  const colourFor = {
    open: chartColour('--blueprint-2'),
    partial: chartColour('--signal'),
    completed: chartColour('--go'),
    cancelled: chartColour('--steel-pale'),
    on_hold: chartColour('--steel-pale'),
    draft: chartColour('--steel-pale')
  };
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  statusChartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => Fmt.status(r.status)),
      datasets: [{
        data: rows.map(r => r.count),
        backgroundColor: rows.map(r => colourFor[r.status] || chartColour('--steel-pale')),
        borderWidth: 2,
        borderColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: { legend: { display: false }, tooltip: { enabled: true } }
    }
  });

  legend.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px">
      <span style="width:9px;height:9px;border-radius:50%;flex-shrink:0;
        background:${colourFor[r.status] || chartColour('--steel-pale')}"></span>
      <span style="flex:1;text-transform:capitalize;color:var(--ink-soft)">${esc(Fmt.status(r.status))}</span>
      <span class="num" style="color:var(--steel)">${r.count} · ${((r.count / total) * 100).toFixed(0)}%</span>
    </div>`).join('');
}

function renderAgeing(buckets) {
  const max = Math.max(...buckets.map(b => Number(b.value)), 1);
  const colour = (label) => label === 'Not due' ? 'var(--blueprint-2)'
    : label === '90+ days' ? 'var(--alert)'
    : label === '61–90 days' ? '#D9603F'
    : 'var(--signal)';

  const total = buckets.reduce((sum, b) => sum + Number(b.value), 0);
  if (total === 0) {
    document.getElementById('ageing').innerHTML =
      '<p class="muted small" style="margin:0">No outstanding invoices. Everything is collected.</p>';
    return;
  }

  document.getElementById('ageing').innerHTML = buckets.map(b => `
    <div class="ageing-row">
      <span class="ageing-label">${esc(b.label)}</span>
      <div class="ageing-track">
        <div class="ageing-fill" style="width:${(Number(b.value) / max * 100).toFixed(1)}%;
             background:${colour(b.label)}"></div>
      </div>
      <span class="ageing-value">${Fmt.money(b.value, true)}</span>
    </div>`).join('')
    + `<p class="small muted" style="margin:16px 0 0;border-top:1px solid var(--line);padding-top:12px">
        Total outstanding <strong class="mono">${Fmt.money(total)}</strong></p>`;
}

async function renderActions(horizon) {
  const box = document.getElementById('actions');
  box.innerHTML = loadingBlock();
  const items = await API.get(`/reports/action-items?horizon=${horizon}`);

  if (!items.length) {
    box.innerHTML = emptyState('Nothing due',
      `No deliveries or payments fall due in the next ${horizon} days.`);
    return;
  }

  box.innerHTML = items.slice(0, 40).map(item => `
    <div class="action-item ${item.severity}" data-kind="${item.kind}" data-id="${item.entity_id}">
      <span class="action-rail"></span>
      <div class="action-body">
        <strong>${esc(item.title)}</strong>
        <span>${esc(item.subtitle)}</span>
      </div>
      <div class="action-due">
        <strong>${Fmt.days(item.days)}</strong>
        <span class="muted">${Fmt.date(item.due_date)}</span>
      </div>
    </div>`).join('');

  box.querySelectorAll('.action-item').forEach(row => {
    row.onclick = () => {
      const kind = row.dataset.kind;
      if (kind.startsWith('delivery')) openOrder(Number(row.dataset.id));
      else location.hash = '#/invoices';
    };
  });
}

/* ============================================================ orders */

Views.orders = async function (page, params) {
  await loadReferenceData();

  page.innerHTML = `
    <div class="filters">
      ${searchBox('poSearch', 'Search PO number, customer or reference')}
      <button class="chip active" data-status="live">Live</button>
      <button class="chip" data-status="all">All</button>
      <button class="chip" data-status="on_hold">On hold</button>
      <button class="chip" data-status="completed">Completed</button>
      <button class="chip" data-status="cancelled">Cancelled</button>
      <select id="ownerFilter" style="margin-left:auto">
        <option value="">All owners</option>
        <option value="mine">My orders</option>
        ${Session.seesEverything() ? State.users.map(u =>
          `<option value="${u.id}">${esc(u.name)}</option>`).join('') : ''}
      </select>
      ${comboBox('customerFilter', 'All customers', '', '')}
    </div>
    <div class="card">
      <div class="card-body flush" id="poList">${loadingBlock()}</div>
    </div>`;

  const filters = { status: params.status || 'live', search: '', owner: '', customer: '' };
  if (params.status) {
    page.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c.dataset.status === params.status));
  }

  const load = async () => {
    const box = document.getElementById('poList');
    box.innerHTML = loadingBlock();
    const query = new URLSearchParams({ status: filters.status, limit: '400' });
    if (filters.search) query.set('search', filters.search);
    if (filters.owner === 'mine') query.set('mine', 'true');
    else if (filters.owner) query.set('owner_id', filters.owner);
    if (filters.customer) query.set('customer_id', filters.customer);

    const rows = await API.get('/pos?' + query.toString());
    renderOrderTable(box, rows);
  };

  page.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      page.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filters.status = chip.dataset.status;
      load();
    };
  });
  document.getElementById('poSearch').oninput = debounce(e => {
    filters.search = e.target.value.trim();
    load();
  });
  document.getElementById('ownerFilter').onchange = e => {
    filters.owner = e.target.value; load();
  };
  initFieldCombo('customerFilter',
    [{ value: '', label: 'All customers' }].concat(
      State.customers.map(c => ({ value: c.id, label: c.name }))),
    (value) => { filters.customer = value; load(); });

  await load();
};

function exportPoPdf(po) {
  const lines = po.lines.map(l => `
    <tr>
      <td>${esc(l.description)}</td>
      <td class="right">${Fmt.qty(l.qty_ordered)} ${esc(l.uom)}</td>
      <td class="right">${Fmt.qty(l.qty_dispatched)}</td>
      <td class="right">${Fmt.qty(l.qty_pending)}</td>
      <td class="right">${Fmt.money(l.rate)}</td>
      <td class="right">${Fmt.money(l.line_total)}</td>
    </tr>`).join('');

  const dispatches = po.dispatches.length ? po.dispatches.map(d => `
    <tr>
      <td>${esc(d.dispatch_no)}</td>
      <td>${Fmt.date(d.dispatch_date)}</td>
      <td>${esc(d.challan_no || '—')}</td>
      <td>${esc(d.vehicle_no || '—')}</td>
      <td class="right">${Fmt.money(d.value, true)}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">No dispatches recorded.</td></tr>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>PO ${esc(po.po_number)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           font-size: 12px; color: #111; padding: 32px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 2px; }
    .eyebrow { font-size: 11px; color: #666; text-transform: uppercase;
               letter-spacing: .05em; margin-bottom: 4px; }
    .meta { font-size: 11px; color: #666; margin-top: 4px; }
    .status { display:inline-block; padding: 2px 8px; border-radius: 20px;
              font-size: 11px; font-weight: 600; background:#eee; color:#444;
              text-transform:capitalize; margin-left: 8px; vertical-align:middle; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr);
               gap: 12px; margin: 24px 0; }
    .metric { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; }
    .metric label { font-size: 10px; color: #888; text-transform: uppercase;
                    letter-spacing: .05em; display: block; margin-bottom: 4px; }
    .metric strong { font-size: 16px; font-weight: 700; font-family: monospace; }
    h2 { font-size: 13px; font-weight: 600; margin: 20px 0 8px;
         padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing:.04em;
         color: #888; border-bottom: 1px solid #e5e7eb;
         padding: 6px 8px; text-align: left; }
    td { padding: 7px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .right { text-align: right; }
    .muted { color: #888; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb;
              font-size: 10px; color: #aaa; display:flex; justify-content:space-between; }
    @media print { body { padding: 16px; } }
  </style></head><body>
  <div class="eyebrow">${esc(po.customer_name)}</div>
  <h1>${esc(po.po_number)}${po.revision ? ` · R${po.revision}` : ''}
    <span class="status">${Fmt.status(po.status)}</span>
  </h1>
  <div class="meta">
    Dated ${Fmt.date(po.po_date)} &nbsp;·&nbsp; Owner: ${esc(po.owner_name)}
    &nbsp;·&nbsp; Payment terms: ${po.payment_terms_days} days
    ${po.reference ? `&nbsp;·&nbsp; Ref: ${esc(po.reference)}` : ''}
  </div>

  <div class="metrics">
    <div class="metric"><label>Order value</label><strong>${Fmt.money(po.order_value, true)}</strong></div>
    <div class="metric"><label>Pending</label><strong>${Fmt.money(po.pending_value, true)}</strong></div>
    <div class="metric"><label>Invoiced</label><strong>${Fmt.money(po.invoiced_value, true)}</strong></div>
    <div class="metric"><label>Received</label><strong>${Fmt.money(po.received_value, true)}</strong></div>
  </div>

  <h2>Order Lines</h2>
  <table>
    <thead><tr>
      <th>Item</th><th class="right">Ordered</th><th class="right">Dispatched</th>
      <th class="right">Pending</th><th class="right">Rate</th><th class="right">Value</th>
    </tr></thead>
    <tbody>${lines}</tbody>
  </table>

  <h2>Dispatches</h2>
  <table>
    <thead><tr>
      <th>Dispatch No</th><th>Date</th><th>Challan</th><th>Vehicle</th><th class="right">Value</th>
    </tr></thead>
    <tbody>${dispatches}</tbody>
  </table>

  ${po.notes ? `<h2>Notes</h2><p style="font-size:12px;color:#444;white-space:pre-wrap">${esc(po.notes)}</p>` : ''}

  <div class="footer">
    <span>Panache DigiLife · Sales Order Tracker</span>
    <span>Generated ${new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}</span>
  </div>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`;

  const win = window.open('', '_blank');
  if (!win) {
    toast('Popup blocked — please allow popups for this site to export PDF', 'error');
    return;
  }
  win.document.write(html);
  win.document.close();
}

function sharePoOnWhatsApp(po) {
  const dispatched = po.dispatches.length
    ? po.dispatches.map(d =>
        `• ${d.dispatch_no} · ${Fmt.date(d.dispatch_date)} · ${Fmt.money(d.value, true)}`
      ).join('\n')
    : '• No dispatches yet';

  const lines = [
    `*Purchase Order — ${po.po_number}*`,
    `Customer: ${po.customer_name}`,
    `Date: ${Fmt.date(po.po_date)}`,
    ``,
    `*Order Value:* ${Fmt.money(po.order_value, true)}`,
    `*Pending:* ${Fmt.money(po.pending_value, true)}`,
    `*Status:* ${po.status.replace('_', ' ').toUpperCase()}`,
    ``,
    `*Dispatches:*`,
    dispatched,
    po.notes ? `\n*Notes:* ${po.notes}` : '',
    ``,
    `_Panache DigiLife · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}_`
  ].filter(l => l !== '').join('\n');

  const url = `https://wa.me/?text=${encodeURIComponent(lines)}`;
  const win = window.open(url, '_blank');
  if (!win) toast('Popup blocked — allow popups to share on WhatsApp', 'error');
}

function renderOrderTable(box, rows) {
  if (!rows.length) {
    box.innerHTML = emptyState('No orders here',
      'Nothing matches these filters. Record a customer PO to get started.',
      'Add purchase order', 'emptyAddPo');
    const btn = document.getElementById('emptyAddPo');
    if (btn) btn.onclick = () => Forms.orderEditor();
    return;
  }

  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>PO number</th><th>Customer</th><th>Owner</th>
      <th class="right">Order value</th><th class="right">Pending</th>
      <th style="width:150px">Progress</th><th>Delivery</th><th>Status</th>
    </tr></thead>
    <tbody>${rows.map(po => `
      <tr class="clickable" data-id="${po.id}">
        <td class="cell-stack">
          <strong class="mono">${esc(po.po_number)}${po.revision ? ` R${po.revision}` : ''}</strong>
          <span>${Fmt.date(po.po_date)}</span>
        </td>
        <td>${esc(po.customer_name)}</td>
        <td class="small">${esc(po.owner_name)}</td>
        <td class="right num">${Fmt.money(po.order_value, true)}</td>
        <td class="right num" style="${Number(po.pending_value) > 0 ? 'color:var(--signal-text,#96690A);font-weight:600' : 'color:var(--steel)'}">
          ${Number(po.pending_value) > 0 ? Fmt.money(po.pending_value, true) : '—'}</td>
        <td>${gauge(po.completion_pct, po.is_overdue)}</td>
        <td>${dueCell(po.expected_delivery_date, po.days_to_delivery, Number(po.pending_value) > 0)}</td>
        <td>${badge(po.status)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;

  box.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openOrder(Number(row.dataset.id));
  });
}

async function openOrder(id) {
  Drawer.open(`<div class="drawer-body">${loadingBlock()}</div>`);
  try {
    const po = await API.get(`/pos/${id}`);
    renderOrderDrawer(po);
  } catch (err) {
    toast(err.message, 'error');
    Overlay.hide();
  }
}

function renderOrderDrawer(po) {
  const pending = Number(po.pending_value) > 0;
  const canDispatch = Session.can('admin', 'manager', 'stores')
    && pending && ['open', 'partial'].includes(po.status);
  const canEdit = Session.seesEverything() || po.owner_id === Session.user().id;

  const linesHtml = po.lines.map(line => `
    <tr>
      <td class="cell-stack">
        <strong>${esc(line.description)}</strong>
        <span>${Fmt.date(line.required_date) !== '—' ? 'Required ' + Fmt.date(line.required_date) : ''}</span>
      </td>
      <td class="right num">${Fmt.qty(line.qty_ordered)} ${esc(line.uom)}</td>
      <td class="right num">${Fmt.qty(line.qty_dispatched)}</td>
      <td class="right num" style="${Number(line.qty_pending) > 0 ? 'font-weight:600' : 'color:var(--steel)'}">
        ${Fmt.qty(line.qty_pending)}</td>
      <td class="right num">${Fmt.money(line.rate)}</td>
      <td class="right num">${Fmt.money(line.line_total)}</td>
    </tr>`).join('');

  const dispatchHtml = po.dispatches.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Dispatch</th><th>Date</th><th>Challan</th><th>Vehicle</th>
      <th class="right">Value</th></tr></thead>
      <tbody>${po.dispatches.map(d => `<tr>
        <td class="mono">${esc(d.dispatch_no)}</td>
        <td class="num">${Fmt.date(d.dispatch_date)}</td>
        <td class="small">${esc(d.challan_no || '—')}</td>
        <td class="small mono">${esc(d.vehicle_no || '—')}</td>
        <td class="right num">${Fmt.money(d.value, true)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted small" style="padding:16px 18px;margin:0">Nothing dispatched yet.</p>';

  const invoiceHtml = po.invoices.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Due</th>
      <th class="right">Total</th><th class="right">Balance</th><th>Status</th></tr></thead>
      <tbody>${po.invoices.map(i => `<tr>
        <td class="mono">${esc(i.invoice_no)}</td>
        <td class="num">${Fmt.date(i.invoice_date)}</td>
        <td class="num" style="${i.days_overdue > 0 ? 'color:var(--alert);font-weight:600' : ''}">
          ${Fmt.date(i.due_date)}</td>
        <td class="right num">${Fmt.money(i.total_amount, true)}</td>
        <td class="right num">${Fmt.money(i.balance, true)}</td>
        <td>${badge(i.status)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted small" style="padding:16px 18px;margin:0">No invoices raised yet.</p>';

  Drawer.open(`
    <div class="drawer-head">
      <div style="flex:1;min-width:0">
        <span class="eyebrow">${esc(po.customer_name)}</span>
        <h1 style="margin-top:3px" class="mono">${esc(po.po_number)}${po.revision ? ` · R${po.revision}` : ''}</h1>
        <div class="small muted" style="margin-top:4px">
          Dated ${Fmt.date(po.po_date)} · Owned by ${esc(po.owner_name)}
        </div>
      </div>
      <div class="drawer-actions">
        ${badge(po.status)}
        <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button>
      </div>
    </div>

    <div class="drawer-body">
      <div class="metrics" style="margin-bottom:18px">
        ${metric('Order value', Fmt.money(po.order_value, true), '')}
        ${metric('Pending', Fmt.money(po.pending_value, true), '',
          pending ? 'is-signal' : 'is-go')}
        ${metric('Invoiced', Fmt.money(po.invoiced_value, true), '')}
        ${metric('Received', Fmt.money(po.received_value, true), '', 'is-go')}
        ${metric('To invoice',
          Number(po.to_invoice_balance) < 0
            ? `Over by ${Fmt.money(Math.abs(po.to_invoice_balance), true)}`
            : Fmt.money(po.to_invoice_balance, true),
          Number(po.to_invoice_balance) < 0 ? 'Invoiced more than dispatched' : '',
          Number(po.to_invoice_balance) < 0 ? 'is-alert'
            : Number(po.to_invoice_balance) > 0 ? 'is-signal' : 'is-go')}
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Order lines</h2>
          <div class="card-actions">
            <span class="small muted">${po.completion_pct}% dispatched</span>
          </div>
        </div>
        <div class="card-body flush">
          <div class="table-wrap"><table>
            <thead><tr>
              <th>Item</th><th class="right">Ordered</th><th class="right">Dispatched</th>
              <th class="right">Pending</th><th class="right">Rate</th><th class="right">Value</th>
            </tr></thead>
            <tbody>${linesHtml}</tbody>
          </table></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Dispatches</h2>
          <div class="card-actions">
            ${canDispatch ? `<button class="btn btn-ghost btn-sm" id="addDispatch">
              ${Icons.plus} Record dispatch</button>` : ''}
          </div>
        </div>
        <div class="card-body flush">${dispatchHtml}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Invoices</h2>
          <div class="card-actions">
            <button class="btn btn-ghost btn-sm" id="addInvoice">${Icons.plus} Add invoice</button>
          </div>
        </div>
        <div class="card-body flush">${invoiceHtml}</div>
      </div>

      ${po.notes || po.reference ? `<div class="card"><div class="card-body">
        <dl class="kv">
          ${po.reference ? `<dt>Reference</dt><dd>${esc(po.reference)}</dd>` : ''}
          <dt>Payment terms</dt><dd>${po.payment_terms_days} days</dd>
          ${po.notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(po.notes)}</dd>` : ''}
        </dl></div></div>` : ''}
    </div>

    <div class="drawer-foot">
      ${canEdit && po.status !== 'cancelled' ? `
        <button class="btn btn-danger" id="cancelPo">Cancel PO</button>
        ${po.status !== 'on_hold'
          ? `<button class="btn btn-ghost" id="holdPo">Put on hold</button>`
          : `<button class="btn btn-ghost" id="unholdPo">Resume PO</button>`}
        <button class="btn btn-ghost" id="amendPo">Create revision</button>
        <button class="btn btn-ghost" id="editPo">Edit order</button>` : ''}
      <button class="btn btn-ghost" id="exportPdf">${Icons.download} Export PDF</button>
      <button class="btn btn-ghost" id="whatsappPo">📲 WhatsApp</button>
      <button class="btn btn-primary" data-close>Done</button>
    </div>`);

  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  wire('addDispatch', () => Forms.dispatch(po));
  wire('addInvoice', async () => await Forms.invoice(po));
  wire('editPo', () => Forms.orderEditor(po));
  wire('holdPo', () => Modal.confirm(
    'Put this PO on hold?',
    `PO ${po.po_number} will be paused. Dispatches can still be recorded but it won't show as active. You can resume it at any time.`,
    'Put on hold',
    async () => {
      await API.patch(`/pos/${po.id}`, { status: 'on_hold' });
      toast(`PO ${po.po_number} put on hold`);
      const fresh = await API.get(`/pos/${po.id}`);
      renderOrderDrawer(fresh);
      Router.refresh();
    }, false));
  wire('unholdPo', () => Modal.confirm(
    'Resume this PO?',
    `PO ${po.po_number} will be set back to active.`,
    'Resume',
    async () => {
      await API.patch(`/pos/${po.id}`, { status: Number(po.completion_pct) >= 100 ? 'completed' : po.dispatches.length ? 'partial' : 'open' });
      toast(`PO ${po.po_number} resumed`);
      const fresh = await API.get(`/pos/${po.id}`);
      renderOrderDrawer(fresh);
      Router.refresh();
    }, false));
  wire('exportPdf', () => exportPoPdf(po));
  wire('whatsappPo', () => sharePoOnWhatsApp(po));
  wire('amendPo', () => Modal.confirm(
    'Create a revision?',
    `Revision ${po.revision + 1} will be created as a copy and this version will be `
    + 'marked cancelled. The original stays on record.',
    'Create revision',
    async () => {
      const fresh = await API.post(`/pos/${po.id}/amend`);
      toast(`Revision ${fresh.revision} created`);
      renderOrderDrawer(fresh);
      Router.refresh();
    }, false));
  wire('cancelPo', () => Modal.confirm(
    'Cancel this PO?',
    po.dispatches && po.dispatches.length
      ? `PO ${po.po_number} already has dispatches recorded and cannot be cancelled. Put it on hold instead.`
      : `PO ${po.po_number} will be marked as cancelled. This cannot be undone — the record stays for audit purposes.`,
    'Cancel PO',
    async () => {
      try {
        await API.del(`/pos/${po.id}`);
        toast(`PO ${po.po_number} cancelled`);
        Overlay.hide();
        Router.refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  ));
}

/* ============================================================ dispatches */

Views.dispatches = async function (page) {
  page.innerHTML = `
    <div class="filters">${searchBox('dSearch', 'Search dispatch, challan or PO number')}</div>
    <div class="card"><div class="card-body flush" id="dList">${loadingBlock()}</div></div>`;

  const load = async (search = '') => {
    const box = document.getElementById('dList');
    box.innerHTML = loadingBlock();
    const rows = await API.get('/dispatches' + (search ? `?search=${encodeURIComponent(search)}` : ''));
    if (!rows.length) {
      box.innerHTML = emptyState('No dispatches',
        'Dispatches are recorded against an order. Open an order to add one.');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Dispatch</th><th>Date</th><th>PO</th><th>Customer</th>
      <th>Challan</th><th>Vehicle</th><th class="right">Value</th><th>Recorded by</th>
      </tr></thead><tbody>${rows.map(d => `
        <tr class="clickable" data-po="${d.po_id}">
          <td class="mono"><strong>${esc(d.dispatch_no)}</strong></td>
          <td class="num">${Fmt.date(d.dispatch_date)}</td>
          <td class="mono small">${esc(d.po_number)}</td>
          <td>${esc(d.customer_name)}</td>
          <td class="small">${esc(d.challan_no || '—')}</td>
          <td class="small mono">${esc(d.vehicle_no || '—')}</td>
          <td class="right num">${Fmt.money(d.value, true)}</td>
          <td class="small muted">${esc(d.created_by_name)}</td>
        </tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('tr.clickable').forEach(r =>
      r.onclick = () => openOrder(Number(r.dataset.po)));
  };

  document.getElementById('dSearch').oninput = debounce(e => load(e.target.value.trim()));
  await load();
};

/* ============================================================ invoices */

Views.invoices = async function (page) {
  page.innerHTML = `
    <div class="filters">
      ${searchBox('iSearch', 'Search invoice or PO number')}
      <button class="chip active" data-f="outstanding">Outstanding</button>
      <button class="chip" data-f="overdue">Overdue</button>
      <button class="chip" data-f="paid">Paid</button>
      <button class="chip" data-f="all">All</button>
    </div>
    <div class="card"><div class="card-body flush" id="iList">${loadingBlock()}</div></div>`;

  let filter = 'outstanding';
  let search = '';

  const load = async () => {
    const box = document.getElementById('iList');
    box.innerHTML = loadingBlock();
    const query = new URLSearchParams();
    if (filter === 'overdue') query.set('overdue', 'true');
    else if (filter !== 'all') query.set('status', filter);
    if (search) query.set('search', search);

    const rows = await API.get('/invoices?' + query.toString());
    if (!rows.length) {
      box.innerHTML = emptyState('No invoices',
        'Invoices are raised against an order. Open an order to add one.');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Customer</th><th>PO</th><th>Date</th><th>Due</th>
      <th class="right">Total</th><th class="right">Received</th><th class="right">Balance</th>
      <th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(i => `<tr data-id="${i.id}">
        <td class="mono"><strong>${esc(i.invoice_no)}</strong></td>
        <td>${esc(i.customer_name)}</td>
        <td class="mono small">${esc(i.po_number)}</td>
        <td class="num">${Fmt.date(i.invoice_date)}</td>
        <td class="num" style="${i.days_overdue > 0 ? 'color:var(--alert);font-weight:600' : ''}">
          ${Fmt.date(i.due_date)}
          ${i.days_overdue > 0 ? `<div class="small">${i.days_overdue}d overdue</div>` : ''}</td>
        <td class="right num">${Fmt.money(i.total_amount, true)}</td>
        <td class="right num">${Fmt.money(i.amount_received, true)}</td>
        <td class="right num" style="${Number(i.balance) > 0 ? 'font-weight:600' : 'color:var(--steel)'}">
          ${Fmt.money(i.balance, true)}</td>
        <td>${badge(i.status)}</td>
        <td class="right">${Number(i.balance) > 0 && Session.seesEverything()
          ? `<button class="btn btn-ghost btn-sm" data-pay="${i.id}">Record payment</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;

    box.querySelectorAll('[data-pay]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const invoice = rows.find(r => r.id === Number(btn.dataset.pay));
        Forms.payment(invoice);
      };
    });
  };

  page.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      page.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filter = chip.dataset.f;
      load();
    };
  });
  document.getElementById('iSearch').oninput = debounce(e => {
    search = e.target.value.trim(); load();
  });

  await load();
};

/* ============================================================ customers */

Views.customers = async function (page) {
  page.innerHTML = `
    <div class="filters">
      ${searchBox('cSearch', 'Search customers')}
      <button class="btn btn-primary btn-sm" id="addCustomerBtn" style="margin-left:auto">${Icons.plus} New customer</button>
    </div>
    <div class="card"><div class="card-body flush" id="cList">${loadingBlock()}</div></div>`;

  const load = async (search = '') => {
    const box = document.getElementById('cList');
    box.innerHTML = loadingBlock();
    const rows = await API.get('/customers' + (search ? `?search=${encodeURIComponent(search)}` : ''));
    State.customers = rows;
    if (!rows.length) {
      box.innerHTML = emptyState('No customers yet',
        'Add the companies you supply before recording their orders.',
        'Add customer', 'emptyAddCustomer');
      const btn = document.getElementById('emptyAddCustomer');
      if (btn) btn.onclick = async () => await Forms.customer();
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Customer</th><th>GSTIN</th><th>Terms</th>
      <th class="right">Open orders</th><th class="right">Pending value</th>
      <th class="right">Outstanding</th><th></th></tr></thead>
      <tbody>${rows.map(c => `<tr>
        <td class="mono small">${esc(c.code)}</td>
        <td class="cell-stack"><strong>${esc(c.name)}</strong>
          <span>${esc(c.contact_person || '')}</span></td>
        <td class="mono small">${esc(c.gstin || '—')}</td>
        <td class="num small">${c.payment_terms_days}d</td>
        <td class="right num">${c.open_pos || '—'}</td>
        <td class="right num">${Number(c.pending_value) ? Fmt.money(c.pending_value, true) : '—'}</td>
        <td class="right num" style="${Number(c.outstanding) > 0 ? 'font-weight:600' : 'color:var(--steel)'}">
          ${Number(c.outstanding) ? Fmt.money(c.outstanding, true) : '—'}</td>
        <td class="right"><button class="btn btn-quiet btn-sm" data-edit="${c.id}">Edit</button></td>
      </tr>`).join('')}</tbody></table></div>`;

    box.querySelectorAll('[data-edit]').forEach(btn => {
      btn.onclick = async () => await Forms.customer(rows.find(c => c.id === Number(btn.dataset.edit)));
    });
  };

  document.getElementById('cSearch').oninput = debounce(e => load(e.target.value.trim()));
  document.getElementById('addCustomerBtn').onclick = async () => await Forms.customer();
  await load();
};

/* ============================================================ items */

Views.items = async function (page) {
  page.innerHTML = `
    <div class="filters">
      ${searchBox('itSearch', 'Search items')}
      <button class="btn btn-primary btn-sm" id="addItemBtn" style="margin-left:auto">${Icons.plus} New item</button>
    </div>
    <div class="card"><div class="card-body flush" id="itList">${loadingBlock()}</div></div>`;

  const load = async (search = '') => {
    const box = document.getElementById('itList');
    box.innerHTML = loadingBlock();
    const rows = await API.get('/items' + (search ? `?search=${encodeURIComponent(search)}` : ''));
    State.items = rows;
    if (!rows.length) {
      box.innerHTML = emptyState('No items yet',
        'Adding items lets rates fill in automatically when you enter an order.',
        'Add item', 'emptyAddItem');
      const btn = document.getElementById('emptyAddItem');
      if (btn) btn.onclick = async () => await Forms.item();
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Description</th><th>UOM</th><th>HSN</th>
      <th class="right">Default rate</th><th class="right">Tax</th><th></th></tr></thead>
      <tbody>${rows.map(i => `<tr>
        <td class="mono small"><strong>${esc(i.code)}</strong></td>
        <td>${esc(i.name)}</td>
        <td class="small">${esc(i.uom)}</td>
        <td class="mono small">${esc(i.hsn_code || '—')}</td>
        <td class="right num">${Fmt.money(i.default_rate)}</td>
        <td class="right num small">${Number(i.tax_rate)}%</td>
        <td class="right"><button class="btn btn-quiet btn-sm" data-edit="${i.id}">Edit</button></td>
      </tr>`).join('')}</tbody></table></div>`;

    box.querySelectorAll('[data-edit]').forEach(btn => {
      btn.onclick = async () => await Forms.item(rows.find(i => i.id === Number(btn.dataset.edit)));
    });
  };

  document.getElementById('itSearch').oninput = debounce(e => load(e.target.value.trim()));
  document.getElementById('addItemBtn').onclick = async () => await Forms.item();
  await load();
};

/* ============================================================ users */

Views.users = async function (page) {
  page.innerHTML = `<div class="card"><div class="card-body flush" id="uList">
    ${loadingBlock()}</div></div>
    <div class="card"><div class="card-body">
      <h3 style="margin-bottom:8px">What each role can do</h3>
      <dl class="kv">
        <dt>Staff</dt><dd>Records orders and sees only the orders they own.</dd>
        <dt>Stores</dt><dd>Confirms dispatches against any order.</dd>
        <dt>Manager</dt><dd>Sees every order, records payments, edits masters.</dd>
        <dt>Admin</dt><dd>Everything, plus user accounts and the audit trail.</dd>
      </dl>
      <p class="small muted" style="margin:14px 0 0;border-top:1px solid var(--line);padding-top:12px">
        Dispatch confirmation sits with Stores rather than the order owner on purpose —
        the person chasing an order shouldn't also be the one confirming the goods left.
      </p>
    </div></div>`;

  const rows = await API.get('/users');
  State.users = rows;
  document.getElementById('uList').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map(u => `<tr class="clickable" data-id="${u.id}">
      <td><div style="display:flex;align-items:center;gap:10px">
        <span class="avatar" style="width:26px;height:26px;font-size:10px">${esc(Fmt.initials(u.name))}</span>
        <strong>${esc(u.name)}</strong></div></td>
      <td class="small muted">${esc(u.email)}</td>
      <td><span class="badge open">${esc(u.role)}</span></td>
      <td>${u.is_active ? badge('paid', 'active') : badge('cancelled', 'disabled')}</td>
      <td class="right"><button class="btn btn-quiet btn-sm" data-edit="${u.id}">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;

  document.querySelectorAll('#uList tr.clickable').forEach(row => {
    row.onclick = () => openUserMetrics(rows.find(u => u.id === Number(row.dataset.id)));
  });
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      Forms.user(rows.find(u => u.id === Number(btn.dataset.edit)));
    };
  });
};

async function openUserMetrics(user) {
  Drawer.open(`<div class="drawer-body">${loadingBlock()}</div>`);
  try {
    const [stats, orders] = await Promise.all([
      API.get(`/reports/user/${user.id}`),
      API.get(`/pos?owner_id=${user.id}&status=live&limit=10`)
    ]);
    renderUserMetricsDrawer(user, stats, orders);
  } catch (err) {
    toast(err.message, 'error');
    Overlay.hide();
  }
}

function renderUserMetricsDrawer(user, stats, orders) {
  // Cache of fetched panel data so switching back and forth doesn't refetch.
  const cache = { orders };
  let openPanel = null;

  Drawer.open(`
    <div class="drawer-head">
      <div style="flex:1">
        <span class="eyebrow">${esc(user.role)}</span>
        <h1 style="margin-top:3px">${esc(user.name)}</h1>
        <div class="small muted" style="margin-top:4px">${esc(user.email)}</div>
      </div>
      <div class="drawer-actions">
        <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button>
      </div>
    </div>

    <div class="drawer-body">
      <div class="metrics" style="margin-bottom:18px">
        <div class="metric-link" data-nav="orders">${metric('Live orders', stats.open_pos, '')}</div>
        <div class="metric-link" data-nav="orders">${metric('Order book', Fmt.money(stats.order_book_value, true), '', 'is-blueprint')}</div>
        <div class="metric-link" data-nav="orders">${metric('Pending value', Fmt.money(stats.pending_value, true), '',
          Number(stats.pending_value) > 0 ? 'is-signal' : 'is-go')}</div>
        <div class="metric-link" data-nav="orders">${metric('Overdue lines', stats.overdue_lines, '',
          stats.overdue_lines ? 'is-alert' : 'is-go')}</div>
        <div class="metric-link" data-nav="dispatches">${metric('Dispatches this month', stats.dispatches_this_month, '')}</div>
        <div class="metric-link" data-nav="invoices">${metric('Invoiced this month', Fmt.money(stats.invoiced_this_month, true), '', 'is-go')}</div>
        <div class="metric-link" data-nav="invoices">${metric('Outstanding', Fmt.money(stats.outstanding_receivables, true),
          Number(stats.overdue_receivables) > 0
            ? `${Fmt.money(stats.overdue_receivables, true)} overdue` : '',
          Number(stats.overdue_receivables) > 0 ? 'is-alert' : '')}</div>
      </div>

      <div class="card" id="detailCard" style="display:none">
        <div class="card-head">
          <h2 id="detailTitle"></h2>
          <div class="card-actions">
            <button class="icon-btn" id="detailClose" style="color:var(--steel)">${Icons.close}</button>
          </div>
        </div>
        <div class="card-body flush" id="detailBody"></div>
      </div>
    </div>

    <div class="drawer-foot">
      ${Session.seesEverything() ? `<button class="btn btn-ghost" id="editUserBtn">Edit user</button>` : ''}
      <button class="btn btn-ghost" id="changePassBtn">Change password</button>
      <button class="btn btn-primary" data-close>Done</button>
    </div>`);

  const panels = {
    orders: {
      title: 'Live orders',
      fetch: async () => cache.orders,
      render: (rows) => rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>PO number</th><th>Customer</th><th class="right">Pending</th>
          <th style="width:150px">Progress</th><th>Delivery</th></tr></thead>
          <tbody>${rows.map(po => `<tr class="clickable" data-id="${po.id}">
            <td class="mono small"><strong>${esc(po.po_number)}</strong></td>
            <td class="small">${esc(po.customer_name)}</td>
            <td class="right num">${Number(po.pending_value) ? Fmt.money(po.pending_value, true) : '—'}</td>
            <td>${gauge(po.completion_pct, po.is_overdue)}</td>
            <td class="small">${dueCell(po.expected_delivery_date, po.days_to_delivery, Number(po.pending_value) > 0)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small" style="padding:16px 18px;margin:0">No live orders.</p>',
      wire: (box) => box.querySelectorAll('tr.clickable').forEach(row =>
        row.onclick = () => openOrder(Number(row.dataset.id)))
    },
    dispatches: {
      title: 'Dispatches',
      fetch: async () => {
        if (!cache.dispatches) cache.dispatches = await API.get(`/dispatches?owner_id=${user.id}`);
        return cache.dispatches;
      },
      render: (rows) => rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Dispatch</th><th>Date</th><th>PO</th><th class="right">Value</th></tr></thead>
          <tbody>${rows.map(d => `<tr class="clickable" data-id="${d.po_id}">
            <td class="mono small"><strong>${esc(d.dispatch_no)}</strong></td>
            <td class="small num">${Fmt.date(d.dispatch_date)}</td>
            <td class="mono small">${esc(d.po_number)}</td>
            <td class="right num">${Fmt.money(d.value, true)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small" style="padding:16px 18px;margin:0">No dispatches recorded.</p>',
      wire: (box) => box.querySelectorAll('tr.clickable').forEach(row =>
        row.onclick = () => openOrder(Number(row.dataset.id)))
    },
    invoices: {
      title: 'Invoices',
      fetch: async () => {
        if (!cache.invoices) cache.invoices = await API.get(`/invoices?owner_id=${user.id}&status=all`);
        return cache.invoices;
      },
      render: (rows) => rows.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>PO</th><th class="right">Balance</th><th>Status</th></tr></thead>
          <tbody>${rows.map(i => `<tr class="clickable" data-id="${i.po_id}">
            <td class="mono small"><strong>${esc(i.invoice_no)}</strong></td>
            <td class="mono small">${esc(i.po_number)}</td>
            <td class="right num" style="${Number(i.balance) > 0 ? 'font-weight:600' : 'color:var(--steel)'}">
              ${Fmt.money(i.balance, true)}</td>
            <td>${badge(i.status)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small" style="padding:16px 18px;margin:0">No invoices raised.</p>',
      wire: (box) => box.querySelectorAll('tr.clickable').forEach(row =>
        row.onclick = () => openOrder(Number(row.dataset.id)))
    }
  };

  function setActive(nav) {
    document.querySelectorAll('#drawer .metric-link').forEach(el =>
      el.classList.toggle('active', nav && el.dataset.nav === nav));
  }

  async function openPanelFor(nav) {
    if (openPanel === nav) { closePanel(); return; }
    openPanel = nav;
    setActive(nav);

    const card = document.getElementById('detailCard');
    const body = document.getElementById('detailBody');
    document.getElementById('detailTitle').textContent = panels[nav].title;
    card.style.display = '';
    body.innerHTML = loadingBlock();

    const rows = await panels[nav].fetch();
    if (openPanel !== nav) return; // a different panel was opened while this was loading
    body.innerHTML = panels[nav].render(rows);
    panels[nav].wire(body);
  }

  function closePanel() {
    openPanel = null;
    setActive(null);
    document.getElementById('detailCard').style.display = 'none';
  }

  document.querySelectorAll('#drawer .metric-link').forEach(el => {
    el.onclick = () => openPanelFor(el.dataset.nav);
  });
  document.getElementById('detailClose').onclick = closePanel;

  const editBtn = document.getElementById('editUserBtn');
  if (editBtn) editBtn.onclick = () => Forms.user(user);
  document.getElementById('changePassBtn').onclick = () => Forms.changePassword(user);
}

/* ============================================================ audit */

Views.audit = async function (page) {
  page.innerHTML = `<div class="card"><div class="card-body flush" id="aList">
    ${loadingBlock()}</div></div>`;
  const rows = await API.get('/reports/audit?limit=300');
  const box = document.getElementById('aList');
  if (!rows.length) {
    box.innerHTML = emptyState('Nothing logged yet', 'Changes will appear here as they happen.');
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="num small nowrap">${Fmt.datetime(r.at)}</td>
      <td class="small">${esc(r.user_name)}</td>
      <td><span class="badge ${r.action === 'create' ? 'paid' : r.action === 'cancel' ? 'unpaid' : 'open'}">
        ${esc(r.action)}</span></td>
      <td class="small mono">${esc(r.table_name)}#${r.row_id}</td>
      <td class="small muted">${esc(r.detail || '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
};

/* ============================================================ outstanding */

Views.outstanding = async function (page) {
  page.innerHTML = `
    <div class="filters">
      ${searchBox('outSearch', 'Search customer')}
      <button class="btn btn-ghost" id="exportOutstanding" style="margin-left:auto">
        ${Icons.download} Export PDF
      </button>
    </div>
    <div id="outList">${loadingBlock()}</div>`;

  const load = async (search = '') => {
    const box = document.getElementById('outList');
    box.innerHTML = loadingBlock();
    const rows = await API.get('/reports/customer-outstanding');
    const filtered = search
      ? rows.filter(r => r.customer_name.toLowerCase().includes(search.toLowerCase()))
      : rows;

    const hasData = filtered.some(r => r.outstanding > 0 || r.pending_value > 0 || r.open_pos > 0);
    if (!hasData) {
      box.innerHTML = emptyState('All clear', 'No outstanding balances or open orders.');
      return;
    }

    box.innerHTML = filtered.filter(r => r.outstanding > 0 || r.pending_value > 0 || r.open_pos > 0)
      .map(r => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-head" style="cursor:pointer" data-toggle="${r.customer_id}">
          <div style="flex:1">
            <h2 style="margin:0">${esc(r.customer_name)}</h2>
            <span class="small muted">${esc(r.gstin || r.customer_code || '')}</span>
          </div>
          <div style="display:flex;gap:24px;align-items:center">
            ${r.open_pos ? `<div class="metric" style="padding:0;border:none;min-width:80px">
              <label style="font-size:10px;color:var(--steel);text-transform:uppercase;letter-spacing:.04em">Open POs</label>
              <div class="num" style="font-size:15px;font-weight:700">${r.open_pos}</div>
            </div>` : ''}
            ${r.pending_value > 0 ? `<div class="metric" style="padding:0;border:none;min-width:100px">
              <label style="font-size:10px;color:var(--steel);text-transform:uppercase;letter-spacing:.04em">Pending</label>
              <div class="num" style="font-size:15px;font-weight:700;color:var(--signal-text)">${Fmt.money(r.pending_value, true)}</div>
            </div>` : ''}
            ${r.outstanding > 0 ? `<div class="metric" style="padding:0;border:none;min-width:100px">
              <label style="font-size:10px;color:var(--steel);text-transform:uppercase;letter-spacing:.04em">Outstanding</label>
              <div class="num" style="font-size:15px;font-weight:700;${r.overdue > 0 ? 'color:var(--alert)' : ''}">${Fmt.money(r.outstanding, true)}</div>
            </div>` : ''}
            <button class="btn btn-ghost btn-sm" data-wa="${r.customer_id}">
              📲 WhatsApp
            </button>
            <span style="color:var(--steel);font-size:18px;margin-left:4px" data-arrow="${r.customer_id}">▾</span>
          </div>
        </div>
        <div id="detail-${r.customer_id}" style="display:none">
          <div class="card-body flush">
            <div class="table-wrap"><table>
              <thead><tr>
                <th>PO Number</th><th>Date</th><th>Status</th>
                <th class="right">Pending</th><th class="right">Outstanding</th>
              </tr></thead>
              <tbody>${r.pos.map(po => `<tr>
                <td class="mono">${esc(po.po_number)}</td>
                <td class="num small">${Fmt.date(po.po_date)}</td>
                <td>${badge(po.status)}</td>
                <td class="right num" style="${po.pending_value > 0 ? 'color:var(--signal-text);font-weight:600' : 'color:var(--steel)'}">
                  ${po.pending_value > 0 ? Fmt.money(po.pending_value, true) : '—'}</td>
                <td class="right num" style="${po.outstanding > 0 ? 'font-weight:600' : 'color:var(--steel)'}">
                  ${po.outstanding > 0 ? Fmt.money(po.outstanding, true) : '—'}</td>
              </tr>`).join('')}</tbody>
            </table></div>
            ${r.overdue > 0 ? `<div style="padding:10px 18px;background:var(--alert-bg);border-top:1px solid var(--line);font-size:12px;color:var(--alert);font-weight:600">
              ⚠ ${Fmt.money(r.overdue, true)} overdue across ${r.overdue_count} invoice${r.overdue_count > 1 ? 's' : ''}
            </div>` : ''}
          </div>
        </div>
      </div>`).join('');

    // Toggle expand/collapse
    box.querySelectorAll('[data-toggle]').forEach(header => {
      header.onclick = (e) => {
        if (e.target.closest('[data-wa]')) return;
        const id = header.dataset.toggle;
        const detail = document.getElementById(`detail-${id}`);
        const arrow = box.querySelector(`[data-arrow="${id}"]`);
        const open = detail.style.display === 'none';
        detail.style.display = open ? '' : 'none';
        arrow.textContent = open ? '▴' : '▾';
      };
    });

    // WhatsApp share
    box.querySelectorAll('[data-wa]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const r = filtered.find(x => String(x.customer_id) === btn.dataset.wa);
        if (!r) return;
        shareOnWhatsApp(r);
      };
    });
  };

  // Export PDF
  document.getElementById('exportOutstanding').onclick = async () => {
    const rows = await API.get('/reports/customer-outstanding');
    exportOutstandingPdf(rows.filter(r => r.outstanding > 0 || r.pending_value > 0 || r.open_pos > 0));
  };

  document.getElementById('outSearch').oninput = debounce(e => load(e.target.value.trim()));
  await load();
};

function shareOnWhatsApp(r) {
  const lines = [
    `*${r.customer_name}* — Account Summary`,
    ``,
    `📦 Open Orders: ${r.open_pos}`,
    r.pending_value > 0 ? `⏳ Pending Dispatch: ${Fmt.money(r.pending_value, true)}` : '',
    r.outstanding > 0 ? `💰 Outstanding: ${Fmt.money(r.outstanding, true)}` : '',
    r.overdue > 0 ? `⚠ Overdue: ${Fmt.money(r.overdue, true)} (${r.overdue_count} invoice${r.overdue_count > 1 ? 's' : ''})` : '',
    ``,
    r.pos.length ? `*PO Details:*` : '',
    ...r.pos.map(po =>
      `• ${po.po_number}${po.pending_value > 0 ? ` — Pending ${Fmt.money(po.pending_value, true)}` : ''}${po.outstanding > 0 ? ` — Due ${Fmt.money(po.outstanding, true)}` : ''}`
    ),
    ``,
    `_Panache DigiLife · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}_`
  ].filter(l => l !== '').join('\n');

  const url = `https://wa.me/?text=${encodeURIComponent(lines)}`;
  window.open(url, '_blank');
}

function exportOutstandingPdf(rows) {
  const tableRows = rows.map(r => `
    <tr>
      <td><strong>${esc(r.customer_name)}</strong><br><span style="font-size:10px;color:#888">${esc(r.gstin || r.customer_code || '')}</span></td>
      <td class="right">${r.open_pos || '—'}</td>
      <td class="right" style="${r.pending_value > 0 ? 'font-weight:600;color:#96690A' : 'color:#888'}">${r.pending_value > 0 ? Fmt.money(r.pending_value, true) : '—'}</td>
      <td class="right">${r.invoiced > 0 ? Fmt.money(r.invoiced, true) : '—'}</td>
      <td class="right">${r.received > 0 ? Fmt.money(r.received, true) : '—'}</td>
      <td class="right" style="${r.outstanding > 0 ? 'font-weight:700' : 'color:#888'}">${r.outstanding > 0 ? Fmt.money(r.outstanding, true) : '—'}</td>
      <td class="right" style="${r.overdue > 0 ? 'color:#C0392B;font-weight:700' : 'color:#888'}">${r.overdue > 0 ? Fmt.money(r.overdue, true) : '—'}</td>
    </tr>`).join('');

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const totalOverdue = rows.reduce((s, r) => s + r.overdue, 0);
  const totalPending = rows.reduce((s, r) => s + r.pending_value, 0);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Outstanding Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           font-size: 12px; color: #111; padding: 28px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .meta { font-size: 11px; color: #888; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing:.04em;
         color: #888; border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    td { padding: 8px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .right { text-align: right; }
    tfoot td { font-weight: 700; border-top: 2px solid #e5e7eb; padding-top: 10px; }
    .footer { margin-top: 24px; font-size: 10px; color: #aaa; border-top: 1px solid #e5e7eb; padding-top: 12px; display:flex; justify-content:space-between; }
    @media print { body { padding: 16px; } }
  </style></head><body>
  <h1>Customer Outstanding Report</h1>
  <div class="meta">Panache DigiLife · Generated ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
  <table>
    <thead><tr>
      <th>Customer</th><th class="right">Open POs</th><th class="right">Pending</th>
      <th class="right">Invoiced</th><th class="right">Received</th>
      <th class="right">Outstanding</th><th class="right">Overdue</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
    <tfoot><tr>
      <td><strong>Total</strong></td>
      <td></td>
      <td class="right">${Fmt.money(totalPending, true)}</td>
      <td></td><td></td>
      <td class="right">${Fmt.money(totalOutstanding, true)}</td>
      <td class="right" style="color:#C0392B">${totalOverdue > 0 ? Fmt.money(totalOverdue, true) : '—'}</td>
    </tr></tfoot>
  </table>
  <div class="footer">
    <span>Panache DigiLife · Sales Order Tracker</span>
    <span>${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
  </div>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`;

  const win = window.open('', '_blank');
  if (!win) { toast('Popup blocked — allow popups to export PDF', 'error'); return; }
  win.document.write(html);
  win.document.close();
}
