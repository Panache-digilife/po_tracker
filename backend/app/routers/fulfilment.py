from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user, require_manager, require_stores
from ..db import get_db
from ..deps import assert_can_view_po, scope_pos
from ..models import (
    Customer,
    CustomerPO,
    Dispatch,
    DispatchLine,
    Invoice,
    InvoiceStatus,
    Payment,
    POLine,
    POStatus,
    Role,
    User,
)
from ..schemas import (
    DispatchCreate,
    DispatchOut,
    InvoiceCreate,
    InvoiceOut,
    InvoiceUpdate,
    PaymentCreate,
    PaymentOut,
)
from ..services.core import (
    ZERO,
    audit,
    dispatched_by_line,
    invoiceable_balance,
    m,
    next_dispatch_no,
    next_invoice_no,
    q,
    recalc_invoice_status,
    recalc_po_status,
    serialise_dispatch,
    serialise_invoice,
)

router = APIRouter(tags=["fulfilment"])


# ---------------------------------------------------------------- dispatches


@router.get("/dispatches", response_model=list[DispatchOut])
def list_dispatches(
    po_id: int | None = None,
    owner_id: int | None = None,
    search: str | None = None,
    limit: int = Query(200, le=1000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(Dispatch)
        .options(
            selectinload(Dispatch.lines).selectinload(DispatchLine.po_line),
            selectinload(Dispatch.po).selectinload(CustomerPO.customer),
            selectinload(Dispatch.created_by),
        )
        .join(CustomerPO, CustomerPO.id == Dispatch.po_id)
    )
    stmt = scope_pos(stmt, user)
    if po_id:
        stmt = stmt.where(Dispatch.po_id == po_id)
    if owner_id:
        stmt = stmt.where(CustomerPO.owner_id == owner_id)
    if search:
        pattern = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Dispatch.dispatch_no).like(pattern),
                func.lower(func.coalesce(Dispatch.challan_no, "")).like(pattern),
                func.lower(CustomerPO.po_number).like(pattern),
            )
        )
    rows = db.scalars(
        stmt.order_by(Dispatch.dispatch_date.desc(), Dispatch.id.desc()).limit(limit)
    ).all()
    return [serialise_dispatch(d) for d in rows]


@router.post("/dispatches", response_model=DispatchOut, status_code=201)
def create_dispatch(
    payload: DispatchCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_stores),
):
    """Recording a dispatch is deliberately kept away from the `staff` role.

    The person who enters the order should not be the one confirming that the
    goods left the building — otherwise pending quantities drift away from
    physical reality with nothing to catch it.
    """
    po = db.scalar(
        select(CustomerPO)
        .options(selectinload(CustomerPO.lines))
        .where(CustomerPO.id == payload.po_id)
    )
    if not po:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found")
    if po.status in (POStatus.cancelled, POStatus.draft):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This order is not live. Reopen it before recording a dispatch.",
        )

    already = dispatched_by_line(db, [po.id])
    lines_by_id = {ln.id: ln for ln in po.lines}

    dispatch = Dispatch(
        dispatch_no=next_dispatch_no(db),
        po_id=po.id,
        dispatch_date=payload.dispatch_date,
        challan_no=payload.challan_no,
        eway_bill=payload.eway_bill,
        vehicle_no=payload.vehicle_no,
        transporter=payload.transporter,
        notes=payload.notes,
        created_by_id=user.id,
    )

    for item in payload.lines:
        line = lines_by_id.get(item.po_line_id)
        if not line:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "A line does not belong to this order"
            )
        pending = q(line.qty_ordered) - already.get(line.id, ZERO)
        if q(item.qty) > pending:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"'{line.description}' has only {pending} pending — "
                f"cannot dispatch {q(item.qty)}",
            )
        dispatch.lines.append(DispatchLine(po_line_id=line.id, qty=item.qty))

    if not dispatch.lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Add at least one line")

    db.add(dispatch)
    db.flush()
    recalc_po_status(db, po)
    audit(db, "dispatches", dispatch.id, "create",
          f"{dispatch.dispatch_no} against {po.po_number}", user)
    db.commit()

    db.refresh(dispatch)
    return serialise_dispatch(dispatch)


@router.delete("/dispatches/{dispatch_id}", status_code=204)
def delete_dispatch(
    dispatch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    dispatch = db.get(Dispatch, dispatch_id)
    if not dispatch:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dispatch not found")
    if any(inv.dispatch_id == dispatch.id for inv in dispatch.po.invoices):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "An invoice is raised against this dispatch. Cancel the invoice first.",
        )
    po = dispatch.po
    audit(db, "dispatches", dispatch.id, "delete", dispatch.dispatch_no, user)
    db.delete(dispatch)
    db.flush()
    recalc_po_status(db, po)
    db.commit()


# ---------------------------------------------------------------- invoices


@router.get("/invoices/next-no")
def get_next_invoice_no(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    return {"invoice_no": next_invoice_no(db)}


@router.get("/invoices", response_model=list[InvoiceOut])
def list_invoices(
    po_id: int | None = None,
    customer_id: int | None = None,
    owner_id: int | None = None,
    status_filter: str | None = Query(None, alias="status"),
    overdue: bool = False,
    search: str | None = None,
    limit: int = Query(300, le=1000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(Invoice)
        .options(
            selectinload(Invoice.payments),
            selectinload(Invoice.customer),
            selectinload(Invoice.po),
        )
        .join(CustomerPO, CustomerPO.id == Invoice.po_id)
    )
    stmt = scope_pos(stmt, user)
    if po_id:
        stmt = stmt.where(Invoice.po_id == po_id)
    if customer_id:
        stmt = stmt.where(Invoice.customer_id == customer_id)
    if owner_id:
        stmt = stmt.where(CustomerPO.owner_id == owner_id)
    if status_filter and status_filter != "all":
        if status_filter == "outstanding":
            stmt = stmt.where(
                Invoice.status.in_([InvoiceStatus.unpaid, InvoiceStatus.part_paid])
            )
        else:
            stmt = stmt.where(Invoice.status == InvoiceStatus(status_filter))
    if overdue:
        stmt = stmt.where(
            Invoice.due_date < date.today(),
            Invoice.status.in_([InvoiceStatus.unpaid, InvoiceStatus.part_paid]),
        )
    if search:
        pattern = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Invoice.invoice_no).like(pattern),
                func.lower(CustomerPO.po_number).like(pattern),
            )
        )
    rows = db.scalars(
        stmt.order_by(Invoice.invoice_date.desc(), Invoice.id.desc()).limit(limit)
    ).all()
    return [serialise_invoice(i) for i in rows]


@router.post("/invoices", response_model=InvoiceOut, status_code=201)
def create_invoice(
    payload: InvoiceCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    po = db.get(CustomerPO, payload.po_id)
    if not po:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found")
    assert_can_view_po(po, user)

    if db.scalar(select(Invoice).where(Invoice.invoice_no == payload.invoice_no)):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "That invoice number is already recorded"
        )

    balance = invoiceable_balance(db, po)
    if m(payload.basic_amount) > balance + Decimal("0.01"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Only {balance} is left to invoice on this order — "
            f"{m(payload.basic_amount)} would exceed what's been dispatched.",
        )

    due = payload.due_date or (
        payload.invoice_date + timedelta(days=po.payment_terms_days)
    )
    total = m(payload.basic_amount) + m(payload.tax_amount)

    invoice = Invoice(
        invoice_no=payload.invoice_no,
        invoice_date=payload.invoice_date,
        due_date=due,
        po_id=po.id,
        customer_id=po.customer_id,
        dispatch_id=payload.dispatch_id,
        basic_amount=payload.basic_amount,
        tax_amount=payload.tax_amount,
        total_amount=total,
        notes=payload.notes,
    )
    db.add(invoice)
    db.flush()
    audit(db, "invoices", invoice.id, "create",
          f"{invoice.invoice_no} for {total}", user)
    db.commit()
    db.refresh(invoice)
    return serialise_invoice(invoice)


@router.patch("/invoices/{invoice_id}", response_model=InvoiceOut)
def update_invoice(
    invoice_id: int,
    payload: InvoiceUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    invoice = db.get(Invoice, invoice_id)
    if not invoice:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    data = payload.model_dump(exclude_unset=True)

    if "basic_amount" in data and invoice.po:
        balance = invoiceable_balance(db, invoice.po, exclude_invoice_id=invoice.id)
        if m(data["basic_amount"]) > balance + Decimal("0.01"):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Only {balance} is left to invoice on this order — "
                f"{m(data['basic_amount'])} would exceed what's been dispatched.",
            )

    for field, value in data.items():
        setattr(invoice, field, value)
    invoice.total_amount = m(invoice.basic_amount) + m(invoice.tax_amount)
    if "status" not in data:
        recalc_invoice_status(invoice)
    audit(db, "invoices", invoice.id, "update", ", ".join(data.keys()), user)
    db.commit()
    db.refresh(invoice)
    return serialise_invoice(invoice)


# ---------------------------------------------------------------- payments


@router.get("/payments", response_model=list[PaymentOut])
def list_payments(
    invoice_id: int | None = None,
    limit: int = Query(300, le=1000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(Payment)
        .join(Invoice, Invoice.id == Payment.invoice_id)
        .join(CustomerPO, CustomerPO.id == Invoice.po_id)
    )
    stmt = scope_pos(stmt, user)
    if invoice_id:
        stmt = stmt.where(Payment.invoice_id == invoice_id)
    return db.scalars(
        stmt.order_by(Payment.payment_date.desc()).limit(limit)
    ).all()


@router.post("/payments", response_model=InvoiceOut, status_code=201)
def record_payment(
    payload: PaymentCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    invoice = db.scalar(
        select(Invoice)
        .options(selectinload(Invoice.payments))
        .where(Invoice.id == payload.invoice_id)
    )
    if not invoice:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")

    received = sum((m(p.amount) for p in invoice.payments), ZERO)
    balance = m(invoice.total_amount) - received
    if m(payload.amount) > balance:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Balance on this invoice is {balance}. Enter that or less.",
        )

    payment = Payment(
        invoice_id=invoice.id,
        payment_date=payload.payment_date,
        amount=payload.amount,
        mode=payload.mode,
        reference=payload.reference,
        recorded_by_id=user.id,
    )
    db.add(payment)
    invoice.payments.append(payment)
    db.flush()
    recalc_invoice_status(invoice)
    audit(db, "payments", payment.id, "create",
          f"{payload.amount} against {invoice.invoice_no}", user)
    db.commit()
    db.refresh(invoice)
    return serialise_invoice(invoice)
