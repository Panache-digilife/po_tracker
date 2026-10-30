/* Create and edit forms. */

const Forms = {};

/* ============================================================ order editor

   Entry speed decides whether this system gets used at all. Roughly 25 orders
   a day have to be keyed in, so: rates fill in from the item master, Enter
   adds the next line, and totals update as you type.                       */

Forms.orderEditor = async function (existing = null) {
  await loadReferenceData();

  if (!State.customers.length) {
    toast('Add a customer first', 'error');
    location.hash = '#/customers';
    return;
  }

  const isEdit = !!existing;
  const po = existing || {
    po_number: '', po_date: Fmt.today(), customer_id: State.customers[0].id,
    owner_id: Session.user().id, expected_delivery_date: '', payment_terms_days: 30,
    reference: '', notes: '', attachment_url: '', attachment_name: '', lines: []
  };

  let lines = po.lines.length
    ? po.lines.map(l => ({
        id: l.id, item_id: l.item_id || '', description: l.description,
        uom: l.uom, qty_ordered: l.qty_ordered, rate: l.rate,
        tax_rate: l.tax_rate, required_date: l.required_date || '',
        locked: Number(l.qty_dispatched) > 0
      }))
    : [blankLine()];

  function blankLine() {
    return {
      id: null, item_id: '', description: '', uom: 'NOS',
      qty_ordered: '', rate: '', tax_rate: 18, required_date: '', locked: false
    };
  }

  const ownerOptions = Session.seesEverything()
    ? State.users.filter(u => u.is_active).map(u => ({ value: u.id, label: u.name }))
    : [{ value: Session.user().id, label: Session.user().name }];

  Drawer.open(`
    <div class="drawer-head">
      <div style="flex:1">
        <span class="eyebrow">${isEdit ? 'Editing order' : 'New customer order'}</span>
        <h1 style="margin-top:3px">${isEdit ? esc(po.po_number) : 'Record a purchase order'}</h1>
      </div>
      <div class="drawer-actions">
        <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button>
      </div>
    </div>

    <div class="drawer-body">
      <div id="formError" class="alert-box error hidden"></div>

      <div class="card"><div class="card-body">
        <div class="field-row c3">
          ${fieldText('poNumber', "Customer's PO number", po.po_number,
            { required: true, placeholder: 'e.g. PUR/2026/1184' })}
          ${fieldText('poDate', 'PO date', po.po_date, { type: 'date', required: true })}
          ${fieldCombo('poCustomer', 'Customer',
            State.customers.map(c => ({ value: c.id, label: c.name })),
            po.customer_id, { required: true, placeholder: 'Search customers…' })}
        </div>
        <div class="field-row c4">
          ${fieldText('poDelivery', 'Expected delivery',
            po.expected_delivery_date || '', { type: 'date' })}
          ${fieldText('poTerms', 'Payment terms (days)', po.payment_terms_days,
            { type: 'number', required: true })}
          ${fieldSelect('poOwner', 'Owner', ownerOptions, po.owner_id,
            { hint: '— responsible for this order' })}
          ${fieldText('poReference', 'Reference', po.reference || '',
            { placeholder: 'Quotation no.' })}
        </div>
      </div></div>

      <div class="card">
        <div class="card-head">
          <h2>Order lines</h2>
          <div class="card-actions">
            <span class="small muted">Press Enter on the last field to add a line</span>
          </div>
        </div>
        <div class="card-body">
          <div class="line-editor" id="lineEditor"></div>
          <button class="btn btn-ghost btn-sm" id="addLine" style="margin-top:11px">
            ${Icons.plus} Add line</button>
        </div>
      </div>

      <div class="card"><div class="card-body">
        <div class="field-row c2">
          ${fieldText('poAttachName', 'Attachment name', po.attachment_name || '',
            { placeholder: 'customer-po.pdf' })}
          ${fieldText('poAttachUrl', 'Attachment link', po.attachment_url || '',
            { placeholder: 'Drive or SharePoint link to the original PO' })}
        </div>
        ${fieldArea('poNotes', 'Notes', po.notes || '',
          'Packing instructions, inspection requirements, anything the team should see.')}
      </div></div>
    </div>

    <div class="drawer-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="savePo">
        ${isEdit ? 'Save changes' : 'Create order'}</button>
    </div>`);

  function renderLines() {
    const itemOptions = State.items.filter(i => i.is_active)
      .map(i => ({ value: i.id, label: `${i.code} — ${i.name}` }));
    const itemLabel = (itemId) => {
      const item = State.items.find(i => String(i.id) === String(itemId));
      return item ? `${item.code} — ${item.name}` : '';
    };

    document.getElementById('lineEditor').innerHTML = `<table>
      <thead><tr>
        <th style="width:23%">Item</th><th style="width:26%">Description</th>
        <th style="width:7%">UOM</th><th style="width:9%" class="right">Qty</th>
        <th style="width:10%" class="right">Rate</th>
        <th style="width:12%">Required by</th>
        <th style="width:11%" class="right">Amount</th><th style="width:2%"></th>
      </tr></thead>
      <tbody>${lines.map((line, index) => `<tr data-i="${index}">
        <td>${comboBox(`lineItem_${index}`, 'Choose product',
          line.item_id, itemLabel(line.item_id), line.locked)}</td>
        <td><input data-f="description" value="${esc(line.description)}"
          placeholder="Item description" ${line.locked ? 'disabled' : ''}></td>
        <td><input data-f="uom" value="${esc(line.uom)}" ${line.locked ? 'disabled' : ''}></td>
        <td><input data-f="qty_ordered" class="num" type="number" step="0.001" min="0"
          value="${esc(line.qty_ordered)}"></td>
        <td><input data-f="rate" class="num" type="number" step="0.01" min="0"
          value="${esc(line.rate)}"></td>
        <td><input data-f="required_date" type="date" value="${esc(line.required_date || '')}"></td>
        <td class="right num" data-amount>${Fmt.money(
          (Number(line.qty_ordered) || 0) * (Number(line.rate) || 0), true)}</td>
        <td class="center">${lines.length > 1 && !line.locked
          ? `<button class="btn btn-quiet btn-sm" data-remove title="Remove line">×</button>` : ''}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="6" class="right">Order total</td>
        <td class="right num" id="orderTotal"></td><td></td>
      </tr></tfoot>
    </table>`;

    lines.forEach((line, index) => {
      if (line.locked) return;
      initFieldCombo(`lineItem_${index}`, itemOptions, (value) => {
        const item = State.items.find(i => String(i.id) === String(value));
        lines[index].item_id = value;
        if (item) {
          lines[index].description = item.name;
          lines[index].uom = item.uom;
          lines[index].tax_rate = item.tax_rate;
          if (!lines[index].rate) lines[index].rate = item.default_rate;
          renderLines();
          const qty = document.querySelector(
            `#lineEditor tr[data-i="${index}"] [data-f="qty_ordered"]`);
          if (qty) qty.focus();
        }
      });
    });

    document.querySelectorAll('#lineEditor tbody tr').forEach(row => {
      const index = Number(row.dataset.i);

      row.querySelectorAll('[data-f]').forEach(input => {
        input.addEventListener('input', () => {
          lines[index][input.dataset.f] = input.value;
          if (input.dataset.f === 'qty_ordered' || input.dataset.f === 'rate') {
            row.querySelector('[data-amount]').textContent = Fmt.money(
              (Number(lines[index].qty_ordered) || 0) * (Number(lines[index].rate) || 0), true);
            updateTotal();
          }
        });

        /* Enter moves on; on the last line it creates the next one. */
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (index === lines.length - 1) {
            lines.push(blankLine());
            renderLines();
            const next = document.querySelector(
              `#lineEditor tr[data-i="${lines.length - 1}"] [data-f="description"]`);
            if (next) next.focus();
          } else {
            const next = document.querySelector(
              `#lineEditor tr[data-i="${index + 1}"] [data-f="description"]`);
            if (next) next.focus();
          }
        });
      });

      const removeBtn = row.querySelector('[data-remove]');
      if (removeBtn) {
        removeBtn.onclick = () => { lines.splice(index, 1); renderLines(); };
      }
    });

    updateTotal();
  }

  function updateTotal() {
    const total = lines.reduce((sum, l) =>
      sum + (Number(l.qty_ordered) || 0) * (Number(l.rate) || 0), 0);
    const el = document.getElementById('orderTotal');
    if (el) el.textContent = Fmt.money(total);
  }

  renderLines();
  document.getElementById('addLine').onclick = () => {
    lines.push(blankLine());
    renderLines();
  };

  /* Copying the delivery date down saves typing it on every line. */
  document.getElementById('poDelivery').addEventListener('change', (event) => {
    lines.forEach(l => { if (!l.required_date) l.required_date = event.target.value; });
    renderLines();
  });

  initFieldCombo('poCustomer',
    State.customers.map(c => ({ value: c.id, label: c.name })),
    (value) => {
      const customer = State.customers.find(c => String(c.id) === String(value));
      if (customer) document.getElementById('poTerms').value = customer.payment_terms_days;
    });

  document.getElementById('savePo').onclick = function () {
    const errorBox = document.getElementById('formError');
    errorBox.classList.add('hidden');

    const clean = lines
      .filter(l => l.description && Number(l.qty_ordered) > 0)
      .map(l => ({
        id: l.id,
        item_id: l.item_id ? Number(l.item_id) : null,
        description: l.description,
        uom: l.uom || 'NOS',
        qty_ordered: Number(l.qty_ordered),
        rate: Number(l.rate) || 0,
        tax_rate: Number(l.tax_rate) || 18,
        required_date: orNull(l.required_date)
      }));

    if (!val('poNumber')) {
      errorBox.textContent = 'Enter the PO number from the customer.';
      errorBox.classList.remove('hidden');
      return;
    }
    if (!clean.length) {
      errorBox.textContent = 'Add at least one line with a description and quantity.';
      errorBox.classList.remove('hidden');
      return;
    }

    const payload = {
      po_number: val('poNumber'),
      po_date: val('poDate'),
      customer_id: Number(val('poCustomer')),
      owner_id: Number(val('poOwner')),
      expected_delivery_date: orNull(val('poDelivery')),
      payment_terms_days: numVal('poTerms') || 30,
      reference: orNull(val('poReference')),
      notes: orNull(val('poNotes')),
      attachment_name: orNull(val('poAttachName')),
      attachment_url: orNull(val('poAttachUrl')),
      lines: clean
    };

    submitting(this, async () => {
      const saved = isEdit
        ? await API.patch(`/pos/${po.id}`, payload)
        : await API.post('/pos', payload);
      toast(isEdit ? 'Order updated' : `Order ${saved.po_number} created`);
      Overlay.hide();
      Router.refresh();
      openOrder(saved.id);
    });
  };
};

/* ============================================================ dispatch */

Forms.dispatch = function (po) {
  const pendingLines = po.lines.filter(l => Number(l.qty_pending) > 0);
  if (!pendingLines.length) {
    toast('Everything on this order has been dispatched');
    return;
  }

  Modal.open(`
    <div class="modal-head"><h2>Record dispatch</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <p class="small muted" style="margin:0 0 16px">
        Against <strong class="mono">${esc(po.po_number)}</strong> · ${esc(po.customer_name)}</p>
      <div id="dispatchError" class="alert-box error hidden"></div>

      <div class="field-row c2">
        ${fieldText('dDate', 'Dispatch date', Fmt.today(), { type: 'date', required: true, attrs: `min="${po.po_date}"` })}
        ${fieldText('dChallan', 'Delivery challan no.', '', { placeholder: 'DC/2026/442' })}
      </div>
      <div class="field-row c3">
        ${fieldText('dEway', 'E-way bill', '')}
        ${fieldText('dVehicle', 'Vehicle no.', '', { placeholder: 'MH-04-AB-1234' })}
        ${fieldText('dTransporter', 'Transporter', '')}
      </div>

      <label style="font-size:12px;font-weight:600;display:block;margin:6px 0 7px">
        Quantities going out</label>
      <div class="line-editor"><table>
        <thead><tr><th>Item</th><th class="right">Pending</th>
          <th style="width:112px" class="right">Dispatching</th></tr></thead>
        <tbody>${pendingLines.map(l => `<tr>
          <td>${esc(l.description)}<div class="small muted">${esc(l.uom)}</div></td>
          <td class="right num">${Fmt.qty(l.qty_pending)}</td>
          <td><input type="number" class="num" step="0.001" min="0"
            max="${l.qty_pending}" data-line="${l.id}" value="${l.qty_pending}"></td>
        </tr>`).join('')}</tbody>
      </table></div>

      <div style="margin-top:14px">${fieldArea('dNotes', 'Notes', '')}</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="saveDispatch">Record dispatch</button>
    </div>`, true);

  document.getElementById('saveDispatch').onclick = function () {
    const errorBox = document.getElementById('dispatchError');
    errorBox.classList.add('hidden');

    const dispatchLines = [...document.querySelectorAll('[data-line]')]
      .map(input => ({ po_line_id: Number(input.dataset.line), qty: Number(input.value) }))
      .filter(l => l.qty > 0);

    if (!dispatchLines.length) {
      errorBox.textContent = 'Enter a quantity on at least one line.';
      errorBox.classList.remove('hidden');
      return;
    }

    submitting(this, async () => {
      const saved = await API.post('/dispatches', {
        po_id: po.id,
        dispatch_date: val('dDate'),
        challan_no: orNull(val('dChallan')),
        eway_bill: orNull(val('dEway')),
        vehicle_no: orNull(val('dVehicle')),
        transporter: orNull(val('dTransporter')),
        notes: orNull(val('dNotes')),
        lines: dispatchLines
      });
      toast(`Dispatch ${saved.dispatch_no} recorded`);
      Overlay.hide();
      const fresh = await API.get(`/pos/${po.id}`);
      renderOrderDrawer(fresh);
      Router.refresh();
    });
  };
};

/* ============================================================ invoice */

Forms.invoice = async function (po) {
  // Fetch suggested invoice number
  let suggestedInvNo = '';
  try {
    const res = await API.get('/invoices/next-no');
    suggestedInvNo = res.invoice_no;
  } catch (_) {}

  const uninvoiced = po.dispatches.filter(
    d => !po.invoices.some(i => i.dispatch_id === d.id));
  const suggested = uninvoiced.length ? uninvoiced[0] : null;
  const balance = Number(po.to_invoice_balance) || 0;
  const clamp = (v) => Math.max(0, Math.min(v, Math.max(balance, 0)));
  const initialBasic = suggested ? clamp(Number(suggested.value)) : (balance > 0 ? balance : '');

  Modal.open(`
    <div class="modal-head"><h2>Add invoice</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <p class="small muted" style="margin:0 0 10px">
        Against <strong class="mono">${esc(po.po_number)}</strong> · ${esc(po.customer_name)}</p>
      <p class="small" style="margin:0 0 16px;${balance < 0 ? 'color:var(--alert);font-weight:600' : balance === 0 ? 'color:var(--steel)' : 'color:var(--go)'}">
        ${balance < 0
          ? `This order is already over-invoiced by ${Fmt.money(Math.abs(balance))} — check the existing invoices below.`
          : balance === 0
            ? 'Nothing left to invoice — everything dispatched has already been billed.'
            : `${Fmt.money(balance)} left to invoice, based on what's been dispatched.`}
      </p>
      <div id="invError" class="alert-box error hidden"></div>

      <div class="field-row c2">
        ${fieldText('invNo', 'Invoice number', suggestedInvNo, { required: true, placeholder: 'INV/26-27/0142' })}
        ${fieldText('invDate', 'Invoice date', Fmt.today(), { type: 'date', required: true })}
      </div>
      ${fieldSelect('invDispatch', 'Against dispatch',
        [{ value: '', label: '— not linked to a dispatch —' }].concat(
          po.dispatches.map(d => ({
            value: d.id,
            label: `${d.dispatch_no} · ${Fmt.date(d.dispatch_date)} · ${Fmt.money(d.value, true)}`
          }))),
        suggested ? suggested.id : '',
        { hint: '— links the bill to what actually went out' })}
      <div class="field-row c3">
        ${fieldText('invBasic', 'Basic amount', initialBasic,
          { type: 'number', required: true, attrs: 'step="0.01" min="0"' })}
        ${fieldText('invTax', 'Tax amount', '',
          { type: 'number', attrs: 'step="0.01" min="0"' })}
        ${fieldText('invDue', 'Due date', '',
          { type: 'date', hint: `defaults to ${po.payment_terms_days} days` })}
      </div>
      <p class="small muted" style="margin:-4px 0 14px">
        Total <strong class="mono" id="invTotal">₹0.00</strong></p>
      ${fieldArea('invNotes', 'Notes', '')}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="saveInvoice">Add invoice</button>
    </div>`);

  const recalc = () => {
    document.getElementById('invTotal').textContent =
      Fmt.money((numVal('invBasic') || 0) + (numVal('invTax') || 0));
  };
  document.getElementById('invBasic').oninput = recalc;
  document.getElementById('invTax').oninput = recalc;

  /* Tax defaults to 18% of basic — override if the order is mixed-rate. */
  document.getElementById('invBasic').onblur = () => {
    if (!val('invTax') && numVal('invBasic')) {
      document.getElementById('invTax').value = (numVal('invBasic') * 0.18).toFixed(2);
      recalc();
    }
  };

  document.getElementById('invDispatch').onchange = (event) => {
    const dispatch = po.dispatches.find(d => String(d.id) === event.target.value);
    if (dispatch) {
      const amount = clamp(Number(dispatch.value));
      document.getElementById('invBasic').value = amount;
      document.getElementById('invTax').value = (amount * 0.18).toFixed(2);
      recalc();
    }
  };
  recalc();

  document.getElementById('saveInvoice').onclick = function () {
    const errorBox = document.getElementById('invError');
    errorBox.classList.add('hidden');
    if (!val('invNo') || !numVal('invBasic')) {
      errorBox.textContent = 'Enter the invoice number and basic amount.';
      errorBox.classList.remove('hidden');
      return;
    }
    submitting(this, async () => {
      await API.post('/invoices', {
        invoice_no: val('invNo'),
        invoice_date: val('invDate'),
        po_id: po.id,
        dispatch_id: val('invDispatch') ? Number(val('invDispatch')) : null,
        basic_amount: numVal('invBasic'),
        tax_amount: numVal('invTax') || 0,
        due_date: orNull(val('invDue')),
        notes: orNull(val('invNotes'))
      });
      toast('Invoice added');
      Overlay.hide();
      const fresh = await API.get(`/pos/${po.id}`);
      renderOrderDrawer(fresh);
      Router.refresh();
    });
  };
};

/* ============================================================ payment */

Forms.payment = function (invoice) {
  Modal.open(`
    <div class="modal-head"><h2>Record payment</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <p class="small muted" style="margin:0 0 16px">
        Invoice <strong class="mono">${esc(invoice.invoice_no)}</strong> ·
        ${esc(invoice.customer_name)} · balance
        <strong class="mono">${Fmt.money(invoice.balance)}</strong></p>
      <div id="payError" class="alert-box error hidden"></div>
      <div class="field-row c2">
        ${fieldText('payDate', 'Payment date', Fmt.today(), { type: 'date', required: true })}
        ${fieldText('payAmount', 'Amount received', invoice.balance,
          { type: 'number', required: true, attrs: 'step="0.01" min="0"' })}
      </div>
      <div class="field-row c2">
        ${fieldSelect('payMode', 'Mode',
          ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash'].map(m => ({ value: m, label: m })),
          'NEFT')}
        ${fieldText('payRef', 'Reference', '', { placeholder: 'UTR or cheque no.' })}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="savePayment">Record payment</button>
    </div>`);

  document.getElementById('savePayment').onclick = function () {
    const errorBox = document.getElementById('payError');
    errorBox.classList.add('hidden');
    if (!numVal('payAmount')) {
      errorBox.textContent = 'Enter the amount received.';
      errorBox.classList.remove('hidden');
      return;
    }
    submitting(this, async () => {
      await API.post('/payments', {
        invoice_id: invoice.id,
        payment_date: val('payDate'),
        amount: numVal('payAmount'),
        mode: val('payMode'),
        reference: orNull(val('payRef'))
      });
      toast('Payment recorded');
      Overlay.hide();
      Router.refresh();
    });
  };
};

/* ============================================================ masters */

Forms.customer = async function (existing = null) {
  const c = existing || {
    code: '', name: '', gstin: '', contact_person: '', email: '', phone: '',
    billing_address: '', shipping_address: '', payment_terms_days: 30,
    credit_limit: 0, is_active: true
  };
  const isEdit = !!existing;

  // Auto-generate next customer code silently (not shown to user)
  let autoCode = c.code;
  if (!isEdit) {
    const customers = await API.get('/customers');
    const maxNum = customers.reduce((max, cu) => {
      const n = parseInt(cu.code, 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    autoCode = String(maxNum + 1).padStart(3, '0');
  }

  Modal.open(`
    <div class="modal-head"><h2>${isEdit ? 'Edit customer' : 'Add customer'}</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <div id="custError" class="alert-box error hidden"></div>
      ${fieldText('cName', 'Company name', c.name, { required: true })}
      <div class="field-row c2">
        ${fieldText('cCode', 'Nickname', isEdit ? c.code : '',
          { required: false, placeholder: 'e.g. ORPAK (optional)', attrs: isEdit ? 'disabled' : '' })}
        ${fieldText('cGstin', 'GSTIN', c.gstin || '')}
      </div>
      <div class="field-row c3">
        ${fieldText('cContact', 'Contact person', c.contact_person || '')}
        ${fieldText('cEmail', 'Email', c.email || '', { type: 'email' })}
        ${fieldText('cPhone', 'Phone', c.phone || '')}
      </div>
      <div class="field-row c2">
        ${fieldText('cTerms', 'Payment terms (days)', c.payment_terms_days,
          { type: 'number', required: true })}
        ${fieldText('cLimit', 'Credit limit', c.credit_limit,
          { type: 'number', attrs: 'step="0.01" min="0"' })}
      </div>
      <div class="field-row c2">
        ${fieldArea('cBilling', 'Billing address', c.billing_address || '')}
        ${fieldArea('cShipping', 'Shipping address', c.shipping_address || '')}
      </div>
      ${isEdit ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px">
        <input type="checkbox" id="cActive" ${c.is_active ? 'checked' : ''}
          style="width:auto">Active</label>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="saveCustomer">
        ${isEdit ? 'Save changes' : 'Add customer'}</button>
    </div>`);

  document.getElementById('saveCustomer').onclick = function () {
    const errorBox = document.getElementById('custError');
    errorBox.classList.add('hidden');
    if (!val('cName')) {
      errorBox.textContent = 'Company name is required.';
      errorBox.classList.remove('hidden');
      return;
    }
    const payload = {
      name: val('cName'),
      gstin: orNull(val('cGstin')),
      contact_person: orNull(val('cContact')),
      email: orNull(val('cEmail')),
      phone: orNull(val('cPhone')),
      payment_terms_days: numVal('cTerms') || 30,
      credit_limit: numVal('cLimit') || 0,
      billing_address: orNull(val('cBilling')),
      shipping_address: orNull(val('cShipping'))
    };
    if (isEdit) payload.is_active = document.getElementById('cActive').checked;
    else payload.code = val('cCode') || autoCode;

    submitting(this, async () => {
      if (isEdit) await API.patch(`/customers/${c.id}`, payload);
      else await API.post('/customers', payload);
      toast(isEdit ? 'Customer updated' : 'Customer added');
      Overlay.hide();
      await loadReferenceData(true);
      Router.refresh();
    });
  };
};

Forms.item = async function (existing = null) {
  const i = existing || {
    code: '', name: '', uom: 'NOS', hsn_code: '',
    default_rate: '', tax_rate: 18, is_active: true
  };
  const isEdit = !!existing;

  // Auto-generate next item code
  let suggestedCode = i.code;
  if (!isEdit) {
    const items = await API.get('/items');
    const maxNum = items.reduce((max, it) => {
      const n = parseInt(it.code, 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    suggestedCode = String(maxNum + 1).padStart(3, '0');
  }

  Modal.open(`
    <div class="modal-head"><h2>${isEdit ? 'Edit item' : 'Add item'}</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <div id="itemError" class="alert-box error hidden"></div>
      <div class="field-row c2">
        ${fieldText('iCode', 'Item code', isEdit ? i.code : suggestedCode,
          { required: true, attrs: isEdit ? 'disabled' : '' })}
        ${fieldText('iHsn', 'HSN code', i.hsn_code || '')}
      </div>
      ${fieldText('iName', 'Description', i.name, { required: true })}
      <div class="field-row c3">
        ${fieldText('iUom', 'Unit', i.uom, { required: true })}
        ${fieldText('iRate', 'Default rate', i.default_rate,
          { type: 'number', attrs: 'step="0.01" min="0"', hint: 'fills in on new order lines' })}
        ${fieldText('iTax', 'Tax %', i.tax_rate, { type: 'number', attrs: 'step="0.01"' })}
      </div>
      ${isEdit ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px">
        <input type="checkbox" id="iActive" ${i.is_active ? 'checked' : ''}
          style="width:auto">Active</label>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="saveItem">
        ${isEdit ? 'Save changes' : 'Add item'}</button>
    </div>`);

  document.getElementById('saveItem').onclick = function () {
    const errorBox = document.getElementById('itemError');
    errorBox.classList.add('hidden');
    if (!val('iName') || (!isEdit && !val('iCode'))) {
      errorBox.textContent = 'Item code and description are both needed.';
      errorBox.classList.remove('hidden');
      return;
    }
    const payload = {
      name: val('iName'),
      uom: val('iUom') || 'NOS',
      hsn_code: orNull(val('iHsn')),
      default_rate: numVal('iRate') || 0,
      tax_rate: numVal('iTax') || 18
    };
    if (isEdit) payload.is_active = document.getElementById('iActive').checked;
    else payload.code = val('iCode') || suggestedCode;

    submitting(this, async () => {
      if (isEdit) await API.patch(`/items/${i.id}`, payload);
      else await API.post('/items', payload);
      toast(isEdit ? 'Item updated' : 'Item added');
      Overlay.hide();
      await loadReferenceData(true);
      Router.refresh();
    });
  };
};

Forms.user = function (existing = null) {
  const u = existing || { name: '', email: '', role: 'staff', is_active: true };
  const isEdit = !!existing;

  Modal.open(`
    <div class="modal-head"><h2>${isEdit ? 'Edit user' : 'Add user'}</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button></div>
    <div class="modal-body">
      <div id="userError" class="alert-box error hidden"></div>
      ${fieldText('uName', 'Full name', u.name, { required: true })}
      ${fieldText('uEmail', 'Email', u.email,
        { type: 'email', required: true, attrs: isEdit ? 'disabled' : '' })}
      ${fieldSelect('uRole', 'Role', [
        { value: 'staff', label: 'Staff — records and owns their own orders' },
        { value: 'stores', label: 'Stores — confirms dispatches' },
        { value: 'manager', label: 'Manager — sees all, records payments' },
        { value: 'admin', label: 'Admin — everything, including users' }
      ], u.role, { required: true })}
      ${fieldText('uPassword', isEdit ? 'New password' : 'Password', '',
        { type: 'password', required: !isEdit,
          hint: isEdit ? 'leave blank to keep the current one' : 'at least 8 characters' })}
      ${isEdit ? `<label style="display:flex;gap:8px;align-items:center;font-size:13px">
        <input type="checkbox" id="uActive" ${u.is_active ? 'checked' : ''}
          style="width:auto">Active — unchecking signs them out immediately</label>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="saveUser">
        ${isEdit ? 'Save changes' : 'Add user'}</button>
    </div>`);

  document.getElementById('saveUser').onclick = function () {
    const errorBox = document.getElementById('userError');
    errorBox.classList.add('hidden');
    const password = val('uPassword');
    if (!val('uName') || (!isEdit && (!val('uEmail') || password.length < 8))) {
      errorBox.textContent = 'Name, email and a password of at least 8 characters are needed.';
      errorBox.classList.remove('hidden');
      return;
    }
    if (isEdit && password && password.length < 8) {
      errorBox.textContent = 'A new password must be at least 8 characters.';
      errorBox.classList.remove('hidden');
      return;
    }

    submitting(this, async () => {
      if (isEdit) {
        const payload = {
          name: val('uName'),
          role: val('uRole'),
          is_active: document.getElementById('uActive').checked
        };
        if (password) payload.password = password;
        await API.patch(`/users/${u.id}`, payload);
      } else {
        await API.post('/users', {
          name: val('uName'),
          email: val('uEmail'),
          role: val('uRole'),
          password
        });
      }
      toast(isEdit ? 'User updated' : 'User added');
      Overlay.hide();
      await loadReferenceData(true);
      Router.refresh();
    });
  };
};

Forms.changePassword = function (user) {
  const isSelf = Session.user().id === user.id;

  Modal.open(`
    <div class="modal-head">
      <h2>Change password</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button>
    </div>
    <div class="modal-body">
      <div id="cpError" class="alert-box error hidden"></div>
      <p class="small muted" style="margin:0 0 16px">
        ${isSelf ? 'Changing your own password.' : `Changing password for <strong>${esc(user.name)}</strong>.`}
      </p>
      ${isSelf ? fieldText('cpCurrent', 'Current password', '', { type: 'password', required: true }) : ''}
      <div style="position:relative">
        ${fieldText('cpNew', 'New password', '', { type: 'password', required: true, hint: 'at least 8 characters' })}
      </div>
      ${fieldText('cpConfirm', 'Confirm new password', '', { type: 'password', required: true })}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="savePassword">Change password</button>
    </div>`);

  document.getElementById('savePassword').onclick = function () {
    const errorBox = document.getElementById('cpError');
    errorBox.classList.add('hidden');

    const current  = isSelf ? val('cpCurrent') : null;
    const newPass  = val('cpNew');
    const confirm  = val('cpConfirm');

    if (isSelf && !current) {
      errorBox.textContent = 'Please enter your current password.';
      errorBox.classList.remove('hidden'); return;
    }
    if (newPass.length < 8) {
      errorBox.textContent = 'New password must be at least 8 characters.';
      errorBox.classList.remove('hidden'); return;
    }
    if (newPass !== confirm) {
      errorBox.textContent = 'Passwords do not match.';
      errorBox.classList.remove('hidden'); return;
    }

    submitting(this, async () => {
      const payload = { password: newPass };
      if (isSelf) payload.current_password = current;
      await API.patch(`/users/${user.id}`, payload);
      toast('Password changed successfully');
      Overlay.hide();
    });
  };
};

/* ============================================================ Upload PO PDF */


/* ============================================================ Upload PO PDF */

Forms.uploadPO = function () {
  Modal.open(`
    <div class="modal-head">
      <h2>Upload PO document</h2>
      <button class="icon-btn" data-close style="color:var(--steel)">${Icons.close}</button>
    </div>
    <div class="modal-body">
      <div id="upError" class="alert-box error hidden"></div>
      <div id="upStep1">
        <p class="small muted" style="margin:0 0 16px">
          Upload a customer PO as a PDF. The system will extract all details for your review before anything is saved.
        </p>
        <label class="field">
          <span>PO document (PDF only)</span>
          <input type="file" id="poFile" accept=".pdf" style="padding:8px">
        </label>
      </div>
      <div id="upStep2" style="display:none">
        <div id="upLoading" style="text-align:center;padding:32px 0">
          <div class="spinner" style="margin:0 auto 12px"></div>
          <p class="small muted">Reading document…</p>
        </div>
        <div id="upPreview" style="display:none"></div>
      </div>
    </div>
    <div class="modal-foot" id="upFoot">
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="upReadBtn">Read document</button>
    </div>`);

  let extracted = null;

  document.getElementById('upReadBtn').onclick = async function () {
    const file = document.getElementById('poFile').files[0];
    const errorBox = document.getElementById('upError');
    errorBox.classList.add('hidden');

    if (!file) {
      errorBox.textContent = 'Please select a PDF file first.';
      errorBox.classList.remove('hidden');
      return;
    }

    document.getElementById('upStep1').style.display = 'none';
    document.getElementById('upStep2').style.display = '';
    document.getElementById('upFoot').innerHTML =
      `<button class="btn btn-ghost" data-close>Cancel</button>`;

    try {
      // Send PDF to backend for extraction
      const formData = new FormData();
      formData.append('file', file);

      const token = Session.token();
      const response = await fetch(API_BASE + '/extract/po-pdf', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `Server error (${response.status})`);
      }

      extracted = await response.json();

      // Normalize Gemini flat response into internal shape
      if (!extracted.customer) {
        extracted.customer = {
          match_id: null,
          name: extracted.customer_name || '',
          code: ''
        };
        delete extracted.customer_name;
      }
      extracted.lines = (extracted.lines || []).map(l => ({
        ...l,
        match_id: null,
        item_code: null,
        tax_rate: 0,
      }));

      // Fetch existing customers and items for matching UI
      const [customers, items] = await Promise.all([
        API.get('/customers'),
        API.get('/items')
      ]);

      // Auto-match customer by name similarity
      if (!extracted.customer.match_id && extracted.customer.name) {
        const needle = extracted.customer.name.toLowerCase();
        const match = customers.find(c =>
          c.name.toLowerCase().includes(needle.split(' ')[0]) ||
          needle.includes(c.name.toLowerCase().split(' ')[0])
        );
        if (match) extracted.customer.match_id = match.id;
      }

      // Auto-match lines by description similarity
      extracted.lines.forEach(line => {
        if (line.match_id) return;
        const needle = line.description.toLowerCase();
        const match = items.find(i =>
          i.name.toLowerCase().includes(needle.split(' ')[0]) ||
          needle.includes(i.name.toLowerCase().split(' ')[0])
        );
        if (match) {
          line.match_id = match.id;
          if (!line.rate) line.rate = Number(match.default_rate);
        }
      });

      // Suggest item codes for new items
      const maxCode = items.reduce((max, i) => {
        const n = parseInt(i.code, 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);
      let nextCode = maxCode + 1;
      extracted.lines.forEach(line => {
        if (!line.match_id) {
          line.item_code = String(nextCode).padStart(3, '0');
          nextCode++;
        }
      });

      // Suggest customer code if new
      if (!extracted.customer.match_id && extracted.customer.name) {
        extracted.customer.code = extracted.customer.name
          .replace(/pvt|ltd|llc|inc|private|limited/gi, '')
          .trim().split(/\s+/).slice(0, 2)
          .map(w => w.slice(0, 3).toUpperCase()).join('');
      }

      document.getElementById('upLoading').style.display = 'none';
      document.getElementById('upPreview').style.display = '';
      document.getElementById('upPreview').innerHTML = buildPreview(extracted, customers, items);
      document.getElementById('upFoot').innerHTML = `
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="upConfirmBtn">Confirm &amp; create PO</button>`;
      document.getElementById('upConfirmBtn').onclick = () => confirmAndCreate(extracted);

      // Wire editable fields
      wirePreviewEdits(extracted);

    } catch (err) {
      document.getElementById('upLoading').style.display = 'none';
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
      document.getElementById('upFoot').innerHTML =
        `<button class="btn btn-ghost" data-close>Close</button>`;
    }
  };

  function buildPreview(data, customers, items) {
    const isNewCustomer = !data.customer.match_id;
    const newLines = data.lines.filter(l => !l.match_id);
    const matchedCustomer = customers.find(c => c.id === data.customer.match_id);

    return `
      <h3 style="font-size:13px;font-weight:600;margin:0 0 14px">Review before saving</h3>

      <div class="card" style="margin-bottom:12px"><div class="card-body">
        <dl class="kv">
          <dt>PO Number</dt>
          <dd><input id="prev_poNumber" class="inline-edit" value="${esc(data.po_number || '')}" placeholder="Enter PO number"></dd>
          <dt>PO Date</dt>
          <dd><input id="prev_poDate" type="date" class="inline-edit" value="${esc(data.po_date || '')}"></dd>
          <dt>Payment Terms</dt>
          <dd><input id="prev_terms" type="number" class="inline-edit" value="${data.payment_terms_days}" style="width:80px"> days</dd>
          ${data.notes ? `<dt>Notes</dt><dd>${esc(data.notes)}</dd>` : ''}
        </dl>
      </div></div>

      <div class="card" style="margin-bottom:12px"><div class="card-body">
        <strong style="font-size:12px">Customer</strong>
        ${isNewCustomer
          ? `<span class="badge open" style="margin-left:6px;font-size:10px">NEW — will be created</span>
             <dl class="kv" style="margin-top:8px">
               <dt>Name</dt><dd><input id="prev_custName" class="inline-edit" value="${esc(data.customer.name)}"></dd>
               <dt>Code</dt><dd><input id="prev_custCode" class="inline-edit" value="${esc(data.customer.code)}" style="width:100px"></dd>
             </dl>`
          : `<p class="small" style="margin:6px 0 0">Matched to: <strong>${esc(matchedCustomer?.name)}</strong></p>`
        }
      </div></div>

      <div class="card"><div class="card-body">
        <strong style="font-size:12px">Order lines</strong>
        ${newLines.length ? `<span class="badge open" style="margin-left:6px;font-size:10px">${newLines.length} NEW ITEM${newLines.length > 1 ? 'S' : ''}</span>` : ''}
        <div class="table-wrap" style="margin-top:8px"><table>
          <thead><tr>
            <th>Description</th><th>UOM</th><th class="right">Qty</th>
            <th class="right">Rate</th><th></th>
          </tr></thead>
          <tbody>${data.lines.map((l, i) => `<tr>
            <td><input class="inline-edit" id="prev_desc_${i}" value="${esc(l.description)}" style="width:100%"></td>
            <td><input class="inline-edit" id="prev_uom_${i}" value="${esc(l.uom)}" style="width:60px"></td>
            <td class="right"><input class="inline-edit" id="prev_qty_${i}" type="number" value="${l.qty}" style="width:70px;text-align:right"></td>
            <td class="right"><input class="inline-edit" id="prev_rate_${i}" type="number" value="${l.rate || ''}" placeholder="0" style="width:90px;text-align:right"></td>
            <td>${!l.match_id ? `<span class="badge open" style="font-size:10px">NEW · ${esc(l.item_code)}</span>` : '<span class="small muted">matched</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div></div>

      <style>
        .inline-edit { border:1px solid var(--line); border-radius:4px; padding:3px 6px;
          font-size:12px; background:var(--surface); color:var(--ink); width:auto; }
        .inline-edit:focus { outline:none; border-color:var(--blueprint); }
      </style>`;
  }

  function wirePreviewEdits(data) {
    // Sync editable fields back to data object before confirm
    const g = (id) => document.getElementById(id);
    const sync = () => {
      if (g('prev_poNumber')) data.po_number = g('prev_poNumber').value;
      if (g('prev_poDate'))   data.po_date   = g('prev_poDate').value;
      if (g('prev_terms'))    data.payment_terms_days = parseInt(g('prev_terms').value) || 30;
      if (g('prev_custName')) data.customer.name = g('prev_custName').value;
      if (g('prev_custCode')) data.customer.code = g('prev_custCode').value;
      data.lines.forEach((l, i) => {
        if (g(`prev_desc_${i}`))  l.description = g(`prev_desc_${i}`).value;
        if (g(`prev_uom_${i}`))   l.uom         = g(`prev_uom_${i}`).value;
        if (g(`prev_qty_${i}`))   l.qty         = parseFloat(g(`prev_qty_${i}`).value) || 1;
        if (g(`prev_rate_${i}`))  l.rate        = parseFloat(g(`prev_rate_${i}`).value) || 0;
      });
    };
    // Sync on every input change
    document.getElementById('upPreview').addEventListener('input', sync);
  }

  async function confirmAndCreate(data) {
    // Final sync from fields
    const g = (id) => document.getElementById(id);
    if (g('prev_poNumber')) data.po_number = g('prev_poNumber').value;
    if (g('prev_poDate'))   data.po_date   = g('prev_poDate').value;
    if (g('prev_terms'))    data.payment_terms_days = parseInt(g('prev_terms').value) || 30;
    if (g('prev_custName')) data.customer.name = g('prev_custName').value;
    if (g('prev_custCode')) data.customer.code = g('prev_custCode').value;
    data.lines.forEach((l, i) => {
      if (g(`prev_desc_${i}`))  l.description = g(`prev_desc_${i}`).value;
      if (g(`prev_uom_${i}`))   l.uom         = g(`prev_uom_${i}`).value;
      if (g(`prev_qty_${i}`))   l.qty         = parseFloat(g(`prev_qty_${i}`).value) || 1;
      if (g(`prev_rate_${i}`))  l.rate        = parseFloat(g(`prev_rate_${i}`).value) || 0;
    });

    const btn = document.getElementById('upConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    const errorBox = document.getElementById('upError');
    errorBox.classList.add('hidden');

    try {
      // 1. Create customer if new
      let customerId = data.customer.match_id;
      if (!customerId) {
        const newCustomer = await API.post('/customers', {
          name: data.customer.name,
          code: data.customer.code,
          payment_terms_days: data.payment_terms_days
        });
        customerId = newCustomer.id;
      }

      // 2. Create new items
      const lineItemIds = [];
      for (const line of data.lines) {
        if (line.match_id) {
          lineItemIds.push(line.match_id);
        } else {
          const newItem = await API.post('/items', {
            name: line.description,
            code: line.item_code,
            uom: line.uom || 'NOS',
            default_rate: line.rate || 0,
            tax_rate: 0
          });
          lineItemIds.push(newItem.id);
        }
      }

      // 3. Create PO
      await API.post('/pos', {
        po_number: data.po_number,
        po_date: data.po_date || new Date().toISOString().slice(0, 10),
        customer_id: customerId,
        payment_terms_days: data.payment_terms_days,
        notes: data.notes || null,
        lines: data.lines.map((l, i) => ({
          item_id: lineItemIds[i],
          description: l.description,
          uom: l.uom || 'NOS',
          qty_ordered: l.qty,
          rate: l.rate || 0,
          tax_rate: 0
        }))
      });

      toast('PO created from document');
      Overlay.hide();
      await loadReferenceData(true);
      Router.refresh();

    } catch (err) {
      errorBox.textContent = 'Error: ' + err.message;
      errorBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Confirm & create PO';
    }
  }
};
