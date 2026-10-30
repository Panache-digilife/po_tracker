# Order Book

Customer purchase order tracking for manufacturers. Records the POs your
customers send you and follows each one through to dispatch, invoice and
payment — so nothing sits pending without someone knowing about it.

Built as a static frontend (Vercel) talking to a FastAPI backend (Render).

---

## What it does

**The cycle it tracks**

```
Customer PO received → order lines entered → dispatch (full or partial)
  → invoice raised → payment received → closed
```

The number everything is built on is `qty_pending` per order line:
`qty_ordered − qty_dispatched`. Order book value, dashboards, the delivery
gauge and every reminder derive from it.

**Features**

- Customer PO entry with multi-line orders, per-line required dates, and
  revisions (customers amend orders; the original stays on record)
- Partial dispatches with delivery challan, e-way bill and vehicle details
- Invoices linked to the dispatch they cover, with payment recording and
  automatic status transitions
- Dashboard: order book value, pending value, overdue lines, receivables
  ageing, and a prioritised "needs attention" queue
- Daily reminder digests by email — one mail per person per morning, not
  one per line
- Order book CSV export
- Audit trail of every create, update and cancel

**Roles**

| Role | Sees | Can do |
|---|---|---|
| `staff` | Only orders they own | Record and edit their own orders, raise invoices |
| `stores` | All orders | Confirm dispatches against any order |
| `manager` | All orders | Everything above, plus payments, masters, audit trail |
| `admin` | Everything | Everything, plus user accounts |

Dispatch confirmation sits with `stores` rather than the order owner on
purpose. If the person chasing an order also confirms the goods left, pending
quantities drift from physical reality with nothing to catch it.

---

## Repository layout

```
backend/
  app/
    main.py              FastAPI app, CORS, router mounting
    config.py            environment configuration
    db.py                engine and session
    models.py            SQLAlchemy tables
    schemas.py           Pydantic request/response models
    auth.py              hashing, JWT, current-user dependency
    deps.py              row-level access control (single chokepoint)
    seed.py              table creation, first admin, demo data
    routers/
      auth_users.py      login, /me, user management
      masters.py         customers and items
      pos.py             purchase orders, lines, revisions
      fulfilment.py      dispatches, invoices, payments
      reports.py         dashboard, action items, ageing, CSV, audit
    services/
      core.py            pending-qty maths, serialisers, status rules
    jobs/
      reminders.py       daily digest job (run from Render Cron)
  alembic/               migrations
  requirements.txt

frontend/
  index.html             login
  app.html               application shell
  assets/css/app.css     design tokens and all styling
  assets/js/
    config.js            API base URL — change this after deploying
    api.js               fetch client, session, formatting
    components.js        tables, gauges, badges, drawer, modal
    views.js             page renderers
    forms.js             create/edit forms
    app.js               router, navigation, bootstrap
  vercel.json

render.yaml              Render blueprint (web + cron + database)
```

---

## Running locally

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp ../.env.example .env          # then edit it
export $(grep -v '^#' .env | xargs)

python -m app.seed --demo        # tables + admin + sample data
uvicorn app.main:app --reload --port 8000
```

The API is at `http://localhost:8000`, interactive docs at `/docs`.

Without `DATABASE_URL` set it uses a local SQLite file, which is fine for
development. Use Postgres for anything real.

**Frontend**

```bash
cd frontend
python -m http.server 5173
```

Open `http://localhost:5173`. The default API base in
`assets/js/config.js` already points at `http://localhost:8000/api`.

**Demo logins** (after `--demo`)

| Email | Password | Role |
|---|---|---|
| admin@example.com | changeme123 | admin |
| anita@example.com | password123 | manager |
| sunil@example.com | password123 | stores |
| priya@example.com | password123 | staff |

Change the admin password before you put this anywhere real.

---

## Deploying

### 1. Database and API on Render

Push this repo to GitHub, then in Render choose **New → Blueprint** and point
it at the repo. `render.yaml` creates three services: a Postgres instance, the
web service, and a daily cron job for reminders.

Set these environment variables on the **web service**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | from the Render Postgres instance (internal URL) |
| `JWT_SECRET` | a long random string — `openssl rand -hex 32` |
| `CORS_ORIGINS` | your exact Vercel URL, e.g. `https://orders.vercel.app` |
| `COMPANY_NAME` | shows in the sidebar and reminder emails |
| `SEED_ADMIN_EMAIL` | your admin email |
| `SEED_ADMIN_PASSWORD` | a strong password, used once |

Set the same `DATABASE_URL`, plus `RESEND_API_KEY`, `MAIL_FROM` and
`APP_BASE_URL`, on the **cron job**.

After the first deploy, open the Render shell on the web service and run:

```bash
python -m app.seed
```

That creates the tables and your admin account. Add `--demo` if you want
sample data to look around with first.

**Render specifics worth knowing**

- The free web tier sleeps after 15 minutes idle and takes ~50 seconds to
  wake. For an internal tool people open through the day, the starter tier is
  worth the money.
- Free Postgres expires after 30 days. Don't build on it and then find out.
- Turn on daily backups. This is your order book.

### 2. Frontend on Vercel

Import the repo, set the root directory to `frontend`, and leave the build
command empty — these are static files.

Then edit `frontend/assets/js/config.js`:

```js
window.APP_CONFIG = {
  apiBase: 'https://your-api.onrender.com/api'
};
```

Commit and push; Vercel redeploys automatically.

### 3. Email

Reminders use [Resend](https://resend.com). Create an account, verify a
sending domain, and set `RESEND_API_KEY` and `MAIL_FROM` on the cron job.
Without a key the job runs and logs what it *would* have sent, which is a
useful way to check the digests before switching them on.

---

## Migrations

Alembic is set up from the start, because this schema will change and
`create_all` won't help once there's real data in it.

```bash
cd backend
alembic revision --autogenerate -m "add supplier column"
alembic upgrade head
```

Run `alembic upgrade head` from the Render shell after deploying a schema
change.

---

## Design notes

A few decisions that are deliberate and worth not undoing by accident:

**Money is `Numeric(14,2)` and `Decimal` everywhere.** Never float. Line
totals are computed server-side even though the frontend also displays
them — the frontend number is display, the server number is truth.

**Orders are cancelled, never deleted.** Amendments create a revision rather
than editing in place, so what the customer originally sent stays auditable.

**Lines with dispatch history are protected.** You cannot delete them or
reduce the ordered quantity below what has already gone out.

**Reminders are idempotent.** `reminder_log` has a unique constraint on
`(entity_type, entity_id, rule, fire_date)`, so re-running the job — which
you will while testing — cannot double-send.

**Access control lives in one function.** `scope_pos()` in `deps.py`. The
moment that logic gets copy-pasted inline into endpoints, a leak becomes
inevitable.

---

## Not built yet

Worth knowing before someone asks for them:

- **File uploads.** PO attachments are a name plus a link (Drive, SharePoint).
  Real uploads need S3 or Cloudflare R2, since Render's disk is ephemeral.
- **Production tracking.** If you're made-to-order rather than dispatching
  from stock, orders need to link to a production status. That's a schema
  addition and a genuine scope increase.
- **Tally / Zoho Books export.** The CSV export is the manual version.
- **Credit limit enforcement.** Limits are stored per customer but not
  checked at order entry.
