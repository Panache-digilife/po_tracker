"""Derived values, serialisation and shared helpers.

Everything money-related stays in Decimal. The single most important number in
this system is qty_pending on a PO line: order book, dashboards and reminders
are all built on top of it.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    AuditLog,
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

ZERO = Decimal("0")
Q = Decimal("0.001")
M = Decimal("0.01")


def q(value: Decimal | float | int | None) -> Decimal:
    return (Decimal(str(value or 0))).quantize(Q)


def m(value: Decimal | float | int | None) -> Decimal:
    return (Decimal(str(value or 0))).quantize(M)


def qty_str(value: Decimal | float | int | None) -> str:
    """Trailing zeros read as noise in a sentence: 5.000 NOS -> 5 NOS."""
    d = q(value).normalize()
    return f"{d:f}" if d == d.to_integral_value() else f"{d.normalize():f}"


# ---------------------------------------------------------------- numbering


def next_dispatch_no(db: Session) -> str:
    """DN-YYYYMM-0001, restarting each month."""
    today = date.today()
    prefix = f"DN-{today:%Y%m}-"
    last = db.scalar(
        select(Dispatch.dispatch_no)
        .where(Dispatch.dispatch_no.like(f"{prefix}%"))
        .order_by(Dispatch.dispatch_no.desc())
        .limit(1)
    )
    seq = int(last.split("-")[-1]) + 1 if last else 1
    return f"{prefix}{seq:04d}"


def next_invoice_no(db: Session) -> str:
    """INV/YY-YY/0001, restarting each financial year (Apr-Mar)."""
    today = date.today()
    yr = today.year if today.month >= 4 else today.year - 1
    prefix = f"INV/{str(yr)[-2:]}-{str(yr+1)[-2:]}/"
    last = db.scalar(
        select(Invoice.invoice_no)
        .where(Invoice.invoice_no.like(f"{prefix}%"))
        .order_by(Invoice.invoice_no.desc())
        .limit(1)
    )
    seq = int(last.split("/")[-1]) + 1 if last else 1
    return f"{prefix}{seq:04d}"


# ---------------------------------------------------------------- audit


def audit(db: Session, table: str, row_id: int, action: str,
          detail: str | None = None, user: User | None = None) -> None:
    db.add(
        AuditLog(
            table_name=table,
            row_id=row_id,
            action=action,
            detail=detail,
            user_id=user.id if user else None,
        )
    )


# ---------------------------------------------------------------- dispatched qty


def dispatched_by_line(db: Session, po_ids: list[int]) -> dict[int, Decimal]:
    """Sum of dispatched qty per PO line, for the given POs."""
    if not po_ids:
        return {}
    rows = db.execute(
        select(DispatchLine.po_line_id, func.sum(DispatchLine.qty))
        .join(POLine, POLine.id == DispatchLine.po_line_id)
        .where(POLine.po_id.in_(po_ids))
        .group_by(DispatchLine.po_line_id)
    ).all()
    return {line_id: q(total) for line_id, total in rows}


def line_metrics(line: POLine, dispatched: Decimal) -> dict:
    ordered = q(line.qty_ordered)
    done = min(q(dispatched), ordered)
    pending = ordered - done
    return {
        "qty_dispatched": done,
        "qty_pending": pending,
        "line_total": m(ordered * Decimal(str(line.rate))),
        "pending_value": m(pending * Decimal(str(line.rate))),
    }


# ---------------------------------------------------------------- serialisers


def serialise_line(line: POLine, dispatched: Decimal) -> dict:
    data = {
        "id": line.id,
        "line_no": line.line_no,
        "item_id": line.item_id,
        "description": line.description,
        "uom": line.uom,
        "qty_ordered": q(line.qty_ordered),
        "rate": m(line.rate),
        "tax_rate": Decimal(str(line.tax_rate)),
        "required_date": line.required_date,
    }
    data.update(line_metrics(line, dispatched))
    return data


def serialise_po(po: CustomerPO, dispatched: dict[int, Decimal],
                 detail: bool = False) -> dict:
    today = date.today()
    lines = [serialise_line(ln, dispatched.get(ln.id, ZERO)) for ln in po.lines]

    order_value = sum((ln["line_total"] for ln in lines), ZERO)
    pending_value = sum((ln["pending_value"] for ln in lines), ZERO)
    completion = (
        float((order_value - pending_value) / order_value * 100)
        if order_value > 0
        else 0.0
    )

    due = po.expected_delivery_date
    days_to = (due - today).days if due else None
    overdue = bool(due and due < today and pending_value > 0
                   and po.status not in (POStatus.completed, POStatus.cancelled))

    data = {
        "id": po.id,
        "po_number": po.po_number,
        "revision": po.revision,
        "po_date": po.po_date,
        "status": po.status,
        "customer_id": po.customer_id,
        "customer_name": po.customer.name if po.customer else "",
        "owner_id": po.owner_id,
        "owner_name": po.owner.name if po.owner else "",
        "expected_delivery_date": due,
        "order_value": m(order_value),
        "pending_value": m(pending_value),
        "completion_pct": round(completion, 1),
        "days_to_delivery": days_to,
        "is_overdue": overdue,
    }

    if not detail:
        return data

    invoiced = sum((m(inv.total_amount) for inv in po.invoices
                    if inv.status != InvoiceStatus.cancelled), ZERO)
    invoiced_basic = sum((m(inv.basic_amount) for inv in po.invoices
                          if inv.status != InvoiceStatus.cancelled), ZERO)
    received = ZERO
    for inv in po.invoices:
        received += sum((m(p.amount) for p in inv.payments), ZERO)

    # What's actually been shipped (pre-tax) vs what's already been billed for.
    # Negative means more has been invoiced than dispatched — flags exactly the
    # over-invoicing case that previously went unnoticed.
    dispatched_value = sum((ln["line_total"] - ln["pending_value"] for ln in lines), ZERO)
    to_invoice_balance = m(dispatched_value - invoiced_basic)

    data.update(
        {
            "payment_terms_days": po.payment_terms_days,
            "reference": po.reference,
            "notes": po.notes,
            "attachment_name": po.attachment_name,
            "attachment_url": po.attachment_url,
            "lines": lines,
            "dispatches": [serialise_dispatch(d) for d in
                           sorted(po.dispatches, key=lambda x: x.dispatch_date,
                                  reverse=True)],
            "invoices": [serialise_invoice(i) for i in po.invoices],
            "invoiced_value": m(invoiced),
            "received_value": m(received),
            "dispatched_value": m(dispatched_value),
            "to_invoice_balance": to_invoice_balance,
        }
    )
    return data


def serialise_dispatch(d: Dispatch) -> dict:
    value = ZERO
    lines = []
    for dl in d.lines:
        pl = dl.po_line
        value += m(Decimal(str(dl.qty)) * Decimal(str(pl.rate))) if pl else ZERO
        lines.append(
            {
                "id": dl.id,
                "po_line_id": dl.po_line_id,
                "description": pl.description if pl else "",
                "uom": pl.uom if pl else "",
                "qty": q(dl.qty),
            }
        )
    return {
        "id": d.id,
        "dispatch_no": d.dispatch_no,
        "po_id": d.po_id,
        "po_number": d.po.po_number if d.po else "",
        "customer_name": d.po.customer.name if d.po and d.po.customer else "",
        "dispatch_date": d.dispatch_date,
        "challan_no": d.challan_no,
        "eway_bill": d.eway_bill,
        "vehicle_no": d.vehicle_no,
        "transporter": d.transporter,
        "notes": d.notes,
        "created_by_id": d.created_by_id,
        "created_by_name": d.created_by.name if d.created_by else "",
        "value": m(value),
        "lines": lines,
    }


def serialise_invoice(inv: Invoice) -> dict:
    today = date.today()
    received = sum((m(p.amount) for p in inv.payments), ZERO)
    balance = m(inv.total_amount) - received
    overdue = (today - inv.due_date).days if (
        inv.due_date and balance > 0 and inv.due_date < today
    ) else 0
    return {
        "id": inv.id,
        "invoice_no": inv.invoice_no,
        "invoice_date": inv.invoice_date,
        "due_date": inv.due_date,
        "po_id": inv.po_id,
        "po_number": inv.po.po_number if inv.po else "",
        "customer_id": inv.customer_id,
        "customer_name": inv.customer.name if inv.customer else "",
        "dispatch_id": inv.dispatch_id,
        "basic_amount": m(inv.basic_amount),
        "tax_amount": m(inv.tax_amount),
        "total_amount": m(inv.total_amount),
        "status": inv.status,
        "notes": inv.notes,
        "amount_received": received,
        "balance": balance,
        "days_overdue": overdue,
        "payments": [
            {
                "id": p.id,
                "invoice_id": p.invoice_id,
                "payment_date": p.payment_date,
                "amount": m(p.amount),
                "mode": p.mode,
                "reference": p.reference,
            }
            for p in sorted(inv.payments, key=lambda x: x.payment_date)
        ],
    }


# ---------------------------------------------------------------- status rules


def recalc_po_status(db: Session, po: CustomerPO) -> None:
    """Move a PO between open / partial / completed based on dispatched qty.

    Manually-set terminal states (cancelled, on_hold, draft) are left alone.
    """
    if po.status in (POStatus.cancelled, POStatus.on_hold, POStatus.draft):
        return

    dispatched = dispatched_by_line(db, [po.id])
    total_ordered = sum((q(ln.qty_ordered) for ln in po.lines), ZERO)
    total_done = sum(
        (min(dispatched.get(ln.id, ZERO), q(ln.qty_ordered)) for ln in po.lines), ZERO
    )

    if total_ordered > 0 and total_done >= total_ordered:
        po.status = POStatus.completed
    elif total_done > 0:
        po.status = POStatus.partial
    else:
        po.status = POStatus.open


def invoiceable_balance(db: Session, po: CustomerPO, exclude_invoice_id: int | None = None) -> Decimal:
    """How much (pre-tax) is still available to invoice on this PO.

    Dispatched value minus what's already been invoiced (excluding cancelled
    invoices, and optionally excluding one invoice — used when editing that
    invoice's own amount, so it isn't compared against itself).
    """
    dispatched = dispatched_by_line(db, [po.id])
    dispatched_value = sum(
        (min(dispatched.get(ln.id, ZERO), q(ln.qty_ordered)) * Decimal(str(ln.rate))
         for ln in po.lines),
        ZERO,
    )
    invoiced_basic = sum(
        (m(inv.basic_amount) for inv in po.invoices
         if inv.status != InvoiceStatus.cancelled and inv.id != exclude_invoice_id),
        ZERO,
    )
    return m(dispatched_value - invoiced_basic)


def recalc_invoice_status(inv: Invoice) -> None:
    if inv.status == InvoiceStatus.cancelled:
        return
    received = sum((m(p.amount) for p in inv.payments), ZERO)
    total = m(inv.total_amount)
    if received <= ZERO:
        inv.status = InvoiceStatus.unpaid
    elif received < total:
        inv.status = InvoiceStatus.part_paid
    else:
        inv.status = InvoiceStatus.paid


def outstanding_for_customer(db: Session, customer_id: int) -> Decimal:
    total = db.scalar(
        select(func.coalesce(func.sum(Invoice.total_amount), 0)).where(
            Invoice.customer_id == customer_id,
            Invoice.status != InvoiceStatus.cancelled,
        )
    )
    paid = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0))
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .where(Invoice.customer_id == customer_id)
    )
    return m(total) - m(paid)
