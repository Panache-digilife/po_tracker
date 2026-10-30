from __future__ import annotations

import csv
import io
from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user, require_manager
from ..db import get_db
from ..deps import scope_pos
from ..models import (
    AuditLog,
    Customer,
    CustomerPO,
    Dispatch,
    DispatchLine,
    Invoice,
    InvoiceStatus,
    Payment,
    POLine,
    POStatus,
    User,
)
from ..schemas import ActionItem, AgeingBucket, AuditOut, DashboardStats
from ..services.core import ZERO, dispatched_by_line, m, q, qty_str

router = APIRouter(tags=["reports"])

LIVE = [POStatus.open, POStatus.partial]
OPEN_INV = [InvoiceStatus.unpaid, InvoiceStatus.part_paid]


def _live_pos(db: Session, user: User) -> list[CustomerPO]:
    stmt = (
        select(CustomerPO)
        .options(
            selectinload(CustomerPO.lines),
            selectinload(CustomerPO.customer),
            selectinload(CustomerPO.owner),
        )
        .where(CustomerPO.status.in_(LIVE))
    )
    return db.scalars(scope_pos(stmt, user)).all()


@router.get("/reports/dashboard", response_model=DashboardStats)
def dashboard(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    today = date.today()
    month_start = today.replace(day=1)

    pos = _live_pos(db, user)
    dispatched = dispatched_by_line(db, [p.id for p in pos])

    order_book = ZERO
    pending = ZERO
    overdue_lines = 0
    for po in pos:
        for ln in po.lines:
            ordered = q(ln.qty_ordered)
            done = min(dispatched.get(ln.id, ZERO), ordered)
            rate = Decimal(str(ln.rate))
            order_book += m(ordered * rate)
            outstanding_qty = ordered - done
            pending += m(outstanding_qty * rate)
            due = ln.required_date or po.expected_delivery_date
            if outstanding_qty > 0 and due and due < today:
                overdue_lines += 1

    dispatch_stmt = scope_pos(
        select(func.count(Dispatch.id)).join(
            CustomerPO, CustomerPO.id == Dispatch.po_id
        ),
        user,
    ).where(Dispatch.dispatch_date >= month_start)
    dispatch_count = db.scalar(dispatch_stmt) or 0

    invoiced_stmt = scope_pos(
        select(func.coalesce(func.sum(Invoice.total_amount), 0)).join(
            CustomerPO, CustomerPO.id == Invoice.po_id
        ),
        user,
    ).where(
        Invoice.invoice_date >= month_start,
        Invoice.status != InvoiceStatus.cancelled,
    )
    invoiced = m(db.scalar(invoiced_stmt))

    open_invoices = db.scalars(
        scope_pos(
            select(Invoice)
            .options(selectinload(Invoice.payments))
            .join(CustomerPO, CustomerPO.id == Invoice.po_id),
            user,
        ).where(Invoice.status.in_(OPEN_INV))
    ).all()

    outstanding = ZERO
    overdue_amount = ZERO
    for inv in open_invoices:
        received = sum((m(p.amount) for p in inv.payments), ZERO)
        balance = m(inv.total_amount) - received
        outstanding += balance
        if inv.due_date < today:
            overdue_amount += balance

    return DashboardStats(
        open_pos=len(pos),
        order_book_value=order_book,
        pending_value=pending,
        overdue_lines=overdue_lines,
        dispatches_this_month=dispatch_count,
        invoiced_this_month=invoiced,
        outstanding_receivables=outstanding,
        overdue_receivables=overdue_amount,
    )


def _last_n_months(n: int, today: date) -> list[tuple[int, int]]:
    """[(year, month), ...] for the last n months, oldest first, inclusive of today's month."""
    months = []
    y, mo = today.year, today.month
    for _ in range(n):
        months.append((y, mo))
        mo -= 1
        if mo == 0:
            mo = 12
            y -= 1
    return list(reversed(months))


@router.get("/reports/trend")
def monthly_trend(
    months: int = Query(6, ge=1, le=12),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Dispatched vs invoiced value per month, for the trend chart on the dashboard."""
    today = date.today()
    buckets = _last_n_months(months, today)
    start = date(buckets[0][0], buckets[0][1], 1)

    dispatches = db.scalars(
        scope_pos(
            select(Dispatch)
            .options(selectinload(Dispatch.lines).selectinload(DispatchLine.po_line))
            .join(CustomerPO, CustomerPO.id == Dispatch.po_id),
            user,
        ).where(Dispatch.dispatch_date >= start)
    ).all()

    invoices = db.scalars(
        scope_pos(
            select(Invoice).join(CustomerPO, CustomerPO.id == Invoice.po_id),
            user,
        ).where(Invoice.invoice_date >= start, Invoice.status != InvoiceStatus.cancelled)
    ).all()

    dispatched_by_month: dict[tuple[int, int], Decimal] = {b: ZERO for b in buckets}
    for d in dispatches:
        key = (d.dispatch_date.year, d.dispatch_date.month)
        if key not in dispatched_by_month:
            continue
        value = ZERO
        for dl in d.lines:
            if dl.po_line:
                value += m(Decimal(str(dl.qty)) * Decimal(str(dl.po_line.rate)))
        dispatched_by_month[key] += value

    invoiced_by_month: dict[tuple[int, int], Decimal] = {b: ZERO for b in buckets}
    for inv in invoices:
        key = (inv.invoice_date.year, inv.invoice_date.month)
        if key in invoiced_by_month:
            invoiced_by_month[key] += m(inv.total_amount)

    return [
        {
            "month": f"{y:04d}-{mo:02d}",
            "label": date(y, mo, 1).strftime("%b %y"),
            "dispatched_value": m(dispatched_by_month[(y, mo)]),
            "invoiced_value": m(invoiced_by_month[(y, mo)]),
        }
        for (y, mo) in buckets
    ]


@router.get("/reports/status-breakdown")
def status_breakdown(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """Count of orders by status, for the dashboard donut chart."""
    stmt = scope_pos(
        select(CustomerPO.status, func.count(CustomerPO.id)).group_by(CustomerPO.status),
        user,
    )
    rows = db.execute(stmt).all()
    counts = {s.value: 0 for s in POStatus}
    for status_value, count in rows:
        counts[status_value.value] = count
    return [{"status": k, "count": v} for k, v in counts.items() if v > 0]


@router.get("/reports/user/{user_id}", response_model=DashboardStats)
def user_dashboard(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_manager),
):
    """Same shape as the main dashboard, scoped to one staff member.

    Deliberately bypasses scope_pos: the requester is an admin/manager
    inspecting someone else's numbers, not viewing their own inbox, so the
    ownership filter is the explicit user_id rather than the caller's id.
    """
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    today = date.today()
    month_start = today.replace(day=1)

    pos = db.scalars(
        select(CustomerPO)
        .options(selectinload(CustomerPO.lines))
        .where(CustomerPO.owner_id == user_id, CustomerPO.status.in_(LIVE))
    ).all()
    dispatched = dispatched_by_line(db, [p.id for p in pos])

    order_book = ZERO
    pending = ZERO
    overdue_lines = 0
    for po in pos:
        for ln in po.lines:
            ordered = q(ln.qty_ordered)
            done = min(dispatched.get(ln.id, ZERO), ordered)
            rate = Decimal(str(ln.rate))
            order_book += m(ordered * rate)
            outstanding_qty = ordered - done
            pending += m(outstanding_qty * rate)
            due = ln.required_date or po.expected_delivery_date
            if outstanding_qty > 0 and due and due < today:
                overdue_lines += 1

    dispatch_count = db.scalar(
        select(func.count(Dispatch.id))
        .join(CustomerPO, CustomerPO.id == Dispatch.po_id)
        .where(CustomerPO.owner_id == user_id, Dispatch.dispatch_date >= month_start)
    ) or 0

    invoiced = m(db.scalar(
        select(func.coalesce(func.sum(Invoice.total_amount), 0))
        .join(CustomerPO, CustomerPO.id == Invoice.po_id)
        .where(
            CustomerPO.owner_id == user_id,
            Invoice.invoice_date >= month_start,
            Invoice.status != InvoiceStatus.cancelled,
        )
    ))

    open_invoices = db.scalars(
        select(Invoice)
        .options(selectinload(Invoice.payments))
        .join(CustomerPO, CustomerPO.id == Invoice.po_id)
        .where(CustomerPO.owner_id == user_id, Invoice.status.in_(OPEN_INV))
    ).all()

    outstanding = ZERO
    overdue_amount = ZERO
    for inv in open_invoices:
        received = sum((m(p.amount) for p in inv.payments), ZERO)
        balance = m(inv.total_amount) - received
        outstanding += balance
        if inv.due_date < today:
            overdue_amount += balance

    return DashboardStats(
        open_pos=len(pos),
        order_book_value=order_book,
        pending_value=pending,
        overdue_lines=overdue_lines,
        dispatches_this_month=dispatch_count,
        invoiced_this_month=invoiced,
        outstanding_receivables=outstanding,
        overdue_receivables=overdue_amount,
    )


@router.get("/reports/action-items", response_model=list[ActionItem])
def action_items(
    horizon: int = 7,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """What needs attention, newest problem first. Drives the home screen."""
    today = date.today()
    limit_date = today + timedelta(days=horizon)
    items: list[ActionItem] = []

    pos = _live_pos(db, user)
    dispatched = dispatched_by_line(db, [p.id for p in pos])

    for po in pos:
        for ln in po.lines:
            outstanding_qty = q(ln.qty_ordered) - min(
                dispatched.get(ln.id, ZERO), q(ln.qty_ordered)
            )
            if outstanding_qty <= 0:
                continue
            due = ln.required_date or po.expected_delivery_date
            if not due or due > limit_date:
                continue
            days = (due - today).days
            items.append(
                ActionItem(
                    kind="delivery_overdue" if days < 0 else "delivery_due",
                    entity_id=po.id,
                    title=f"{po.po_number} · {ln.description}",
                    subtitle=(
                        f"{po.customer.name if po.customer else ''} · "
                        f"{qty_str(outstanding_qty)} {ln.uom} pending"
                    ),
                    due_date=due,
                    days=days,
                    severity="high" if days < 0 else ("medium" if days <= 2 else "low"),
                )
            )

    invoices = db.scalars(
        scope_pos(
            select(Invoice)
            .options(selectinload(Invoice.payments), selectinload(Invoice.customer))
            .join(CustomerPO, CustomerPO.id == Invoice.po_id),
            user,
        ).where(Invoice.status.in_(OPEN_INV), Invoice.due_date <= limit_date)
    ).all()

    for inv in invoices:
        received = sum((m(p.amount) for p in inv.payments), ZERO)
        balance = m(inv.total_amount) - received
        if balance <= 0:
            continue
        days = (inv.due_date - today).days
        items.append(
            ActionItem(
                kind="payment_overdue" if days < 0 else "payment_due",
                entity_id=inv.id,
                title=f"Invoice {inv.invoice_no}",
                subtitle=(
                    f"{inv.customer.name if inv.customer else ''} · "
                    f"₹{balance:,.2f} outstanding"
                ),
                due_date=inv.due_date,
                days=days,
                severity="high" if days < 0 else "medium",
            )
        )

    items.sort(key=lambda i: (i.days, i.title))
    return items


@router.get("/reports/ageing", response_model=list[AgeingBucket])
def receivables_ageing(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    today = date.today()
    buckets = [
        ("Not due", -10_000, 0),
        ("1–30 days", 1, 30),
        ("31–60 days", 31, 60),
        ("61–90 days", 61, 90),
        ("90+ days", 91, 10_000),
    ]
    result = {label: [0, ZERO] for label, _, _ in buckets}

    invoices = db.scalars(
        scope_pos(
            select(Invoice)
            .options(selectinload(Invoice.payments))
            .join(CustomerPO, CustomerPO.id == Invoice.po_id),
            user,
        ).where(Invoice.status.in_(OPEN_INV))
    ).all()

    for inv in invoices:
        received = sum((m(p.amount) for p in inv.payments), ZERO)
        balance = m(inv.total_amount) - received
        if balance <= 0:
            continue
        overdue_days = (today - inv.due_date).days
        for label, lo, hi in buckets:
            if lo <= overdue_days <= hi:
                result[label][0] += 1
                result[label][1] += balance
                break

    return [
        AgeingBucket(label=label, count=result[label][0], value=result[label][1])
        for label, _, _ in buckets
    ]


@router.get("/reports/order-book.csv")
def order_book_csv(
    status: str = Query(
        "all", description="all | live | open | partial | completed | cancelled"
    ),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(CustomerPO)
        .options(
            selectinload(CustomerPO.lines),
            selectinload(CustomerPO.customer),
            selectinload(CustomerPO.owner),
        )
    )
    stmt = scope_pos(stmt, user)
    if status == "live":
        stmt = stmt.where(CustomerPO.status.in_(LIVE))
    elif status != "all":
        try:
            stmt = stmt.where(CustomerPO.status == POStatus(status))
        except ValueError:
            raise HTTPException(400, f"Unknown status filter: {status}")

    pos = db.scalars(stmt).all()
    dispatched = dispatched_by_line(db, [p.id for p in pos])

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "PO number", "PO date", "Customer", "Owner", "Item", "UOM",
            "Qty ordered", "Qty dispatched", "Qty pending", "Rate",
            "Pending value", "Required date", "Status",
        ]
    )
    for po in sorted(pos, key=lambda p: p.po_date):
        for ln in po.lines:
            done = min(dispatched.get(ln.id, ZERO), q(ln.qty_ordered))
            pending_qty = q(ln.qty_ordered) - done
            writer.writerow(
                [
                    po.po_number,
                    po.po_date,
                    po.customer.name if po.customer else "",
                    po.owner.name if po.owner else "",
                    ln.description,
                    ln.uom,
                    q(ln.qty_ordered),
                    done,
                    pending_qty,
                    m(ln.rate),
                    m(pending_qty * Decimal(str(ln.rate))),
                    ln.required_date or po.expected_delivery_date or "",
                    po.status.value,
                ]
            )

    buffer.seek(0)
    filename = f"order-book-{status}-{date.today():%Y-%m-%d}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/reports/audit", response_model=list[AuditOut])
def audit_trail(
    table: str | None = None,
    limit: int = Query(200, le=1000),
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    stmt = select(AuditLog, User.name).join(
        User, User.id == AuditLog.user_id, isouter=True
    )
    if table:
        stmt = stmt.where(AuditLog.table_name == table)
    rows = db.execute(stmt.order_by(AuditLog.at.desc()).limit(limit)).all()

    out = []
    for log, user_name in rows:
        record = AuditOut.model_validate(log)
        record.user_name = user_name or "System"
        out.append(record)
    return out


@router.get("/reports/customer-outstanding")
def customer_outstanding(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Per-customer breakdown: open POs, pending, invoiced, received, outstanding, overdue invoices."""
    from ..services.core import outstanding_for_customer, dispatched_by_line, q

    customers = db.scalars(select(Customer).where(Customer.is_active.is_(True)).order_by(Customer.name)).all()
    today = date.today()
    result = []

    for c in customers:
        # Open POs
        open_pos = db.scalars(
            select(CustomerPO).where(
                CustomerPO.customer_id == c.id,
                CustomerPO.status.in_([POStatus.open, POStatus.partial, POStatus.on_hold])
            ).options(selectinload(CustomerPO.lines))
        ).all()

        dispatched = dispatched_by_line(db, [p.id for p in open_pos])
        pending = ZERO
        for po in open_pos:
            for ln in po.lines:
                done = min(dispatched.get(ln.id, ZERO), q(ln.qty_ordered))
                pending += m((q(ln.qty_ordered) - done) * Decimal(str(ln.rate)))

        # Invoices
        invoices = db.scalars(
            select(Invoice).join(CustomerPO).where(
                CustomerPO.customer_id == c.id,
                Invoice.status.in_(OPEN_INV)
            ).options(selectinload(Invoice.payments))
        ).all()

        invoiced = sum(Decimal(str(i.total_amount)) for i in invoices)
        received = sum(sum(Decimal(str(p.amount)) for p in i.payments) for i in invoices)
        outstanding = invoiced - received
        overdue = sum(
            Decimal(str(i.total_amount)) - sum(Decimal(str(p.amount)) for p in i.payments)
            for i in invoices if i.due_date and i.due_date < today
        )
        overdue_count = sum(1 for i in invoices if i.due_date and i.due_date < today)

        # Per PO summary
        pos_summary = []
        for po in open_pos:
            po_dispatched = dispatched_by_line(db, [po.id])
            po_pending = ZERO
            for ln in po.lines:
                done = min(po_dispatched.get(ln.id, ZERO), q(ln.qty_ordered))
                po_pending += m((q(ln.qty_ordered) - done) * Decimal(str(ln.rate)))
            po_invoices = db.scalars(
                select(Invoice).where(
                    Invoice.po_id == po.id,
                    Invoice.status.in_(OPEN_INV)
                ).options(selectinload(Invoice.payments))
            ).all()
            po_outstanding = sum(
                Decimal(str(i.total_amount)) - sum(Decimal(str(p.amount)) for p in i.payments)
                for i in po_invoices
            )
            pos_summary.append({
                "po_number": po.po_number,
                "po_date": po.po_date.isoformat() if po.po_date else None,
                "status": po.status.value,
                "pending_value": float(po_pending),
                "outstanding": float(po_outstanding),
            })

        result.append({
            "customer_id": c.id,
            "customer_name": c.name,
            "customer_code": c.code,
            "gstin": c.gstin,
            "phone": c.phone,
            "open_pos": len(open_pos),
            "pending_value": float(pending),
            "invoiced": float(invoiced),
            "received": float(received),
            "outstanding": float(outstanding),
            "overdue": float(overdue),
            "overdue_count": overdue_count,
            "pos": pos_summary,
        })

    return result
