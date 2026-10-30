from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..db import get_db
from ..deps import assert_can_edit_po, assert_can_view_po, scope_pos
from ..models import Customer, CustomerPO, POLine, POStatus, Role, User
from ..schemas import POCreate, PODetail, POSummary, POUpdate
from ..services.core import (
    ZERO,
    audit,
    dispatched_by_line,
    q,
    recalc_po_status,
    serialise_po,
)

router = APIRouter(prefix="/pos", tags=["purchase orders"])


def _load(db: Session, po_id: int) -> CustomerPO:
    po = db.scalar(
        select(CustomerPO)
        .options(
            selectinload(CustomerPO.lines),
            selectinload(CustomerPO.customer),
            selectinload(CustomerPO.owner),
            selectinload(CustomerPO.dispatches),
            selectinload(CustomerPO.invoices),
        )
        .where(CustomerPO.id == po_id)
    )
    if not po:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found")
    return po


def _apply_lines(db: Session, po: CustomerPO, lines: list) -> None:
    """Replace the line set, keeping ids where the client sent them.

    Lines that already have dispatches recorded against them cannot be removed
    or reduced below what has gone out — that would leave dispatch history
    pointing at nothing.
    """
    dispatched = dispatched_by_line(db, [po.id]) if po.id else {}
    incoming_ids = {ln.id for ln in lines if ln.id}

    for existing in list(po.lines):
        if existing.id not in incoming_ids:
            if dispatched.get(existing.id, ZERO) > ZERO:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Line '{existing.description}' already has dispatches "
                    "and cannot be removed. Cancel the dispatch first.",
                )
            po.lines.remove(existing)

    by_id = {ln.id: ln for ln in po.lines if ln.id}
    for index, payload in enumerate(lines, start=1):
        if payload.id and payload.id in by_id:
            line = by_id[payload.id]
            already = dispatched.get(line.id, ZERO)
            if q(payload.qty_ordered) < already:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"'{line.description}' already has {already} dispatched. "
                    "Ordered quantity cannot go below that.",
                )
            line.line_no = index
            line.item_id = payload.item_id
            line.description = payload.description
            line.uom = payload.uom
            line.qty_ordered = payload.qty_ordered
            line.rate = payload.rate
            line.tax_rate = payload.tax_rate
            line.required_date = payload.required_date
        else:
            po.lines.append(
                POLine(
                    line_no=index,
                    item_id=payload.item_id,
                    description=payload.description,
                    uom=payload.uom,
                    qty_ordered=payload.qty_ordered,
                    rate=payload.rate,
                    tax_rate=payload.tax_rate,
                    required_date=payload.required_date,
                )
            )


@router.get("", response_model=list[POSummary])
def list_pos(
    search: str | None = None,
    status_filter: str | None = Query(None, alias="status"),
    customer_id: int | None = None,
    owner_id: int | None = None,
    mine: bool = False,
    overdue: bool = False,
    due_within: int | None = None,
    limit: int = Query(200, le=1000),
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
        .join(Customer, Customer.id == CustomerPO.customer_id)
    )
    stmt = scope_pos(stmt, user)

    if mine:
        stmt = stmt.where(CustomerPO.owner_id == user.id)
    if owner_id:
        stmt = stmt.where(CustomerPO.owner_id == owner_id)
    if customer_id:
        stmt = stmt.where(CustomerPO.customer_id == customer_id)
    if status_filter and status_filter != "all":
        if status_filter == "live":
            stmt = stmt.where(CustomerPO.status.in_([POStatus.open, POStatus.partial]))
        else:
            stmt = stmt.where(CustomerPO.status == POStatus(status_filter))
    if search:
        pattern = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(CustomerPO.po_number).like(pattern),
                func.lower(Customer.name).like(pattern),
                func.lower(func.coalesce(CustomerPO.reference, "")).like(pattern),
            )
        )
    if overdue:
        stmt = stmt.where(
            CustomerPO.expected_delivery_date < date.today(),
            CustomerPO.status.in_([POStatus.open, POStatus.partial]),
        )
    if due_within is not None:
        horizon = date.today() + timedelta(days=due_within)
        stmt = stmt.where(
            CustomerPO.expected_delivery_date <= horizon,
            CustomerPO.expected_delivery_date >= date.today(),
            CustomerPO.status.in_([POStatus.open, POStatus.partial]),
        )

    pos = db.scalars(
        stmt.order_by(CustomerPO.po_date.desc(), CustomerPO.id.desc()).limit(limit)
    ).all()
    dispatched = dispatched_by_line(db, [p.id for p in pos])
    return [serialise_po(p, dispatched) for p in pos]


@router.post("", response_model=PODetail, status_code=201)
def create_po(
    payload: POCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not db.get(Customer, payload.customer_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Select a valid customer")
    if not payload.lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Add at least one order line")

    owner_id = payload.owner_id or user.id
    if owner_id != user.id and not user.sees_everything:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only managers can assign orders to others"
        )

    clash = db.scalar(
        select(CustomerPO).where(
            CustomerPO.customer_id == payload.customer_id,
            CustomerPO.po_number == payload.po_number,
            CustomerPO.revision == 0,
        )
    )
    if clash:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"PO {payload.po_number} already exists for this customer",
        )

    po = CustomerPO(
        po_number=payload.po_number,
        po_date=payload.po_date,
        customer_id=payload.customer_id,
        owner_id=owner_id,
        expected_delivery_date=payload.expected_delivery_date,
        payment_terms_days=payload.payment_terms_days,
        reference=payload.reference,
        notes=payload.notes,
        attachment_name=payload.attachment_name,
        attachment_url=payload.attachment_url,
        status=payload.status,
    )
    db.add(po)
    _apply_lines(db, po, payload.lines)
    db.flush()
    audit(db, "customer_pos", po.id, "create",
          f"{po.po_number} / {len(po.lines)} lines", user)
    db.commit()

    po = _load(db, po.id)
    return serialise_po(po, dispatched_by_line(db, [po.id]), detail=True)


@router.get("/{po_id}", response_model=PODetail)
def get_po(
    po_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    po = _load(db, po_id)
    assert_can_view_po(po, user)
    return serialise_po(po, dispatched_by_line(db, [po.id]), detail=True)


@router.patch("/{po_id}", response_model=PODetail)
def update_po(
    po_id: int,
    payload: POUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    po = _load(db, po_id)
    assert_can_edit_po(po, user)

    data = payload.model_dump(exclude_unset=True)
    lines = data.pop("lines", None)

    if "owner_id" in data and not user.sees_everything:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only managers can reassign an order"
        )

    for field, value in data.items():
        setattr(po, field, value)

    if lines is not None:
        _apply_lines(db, po, payload.lines)

    if "status" not in data:
        recalc_po_status(db, po)

    audit(db, "customer_pos", po.id, "update", ", ".join(data.keys()) or "lines", user)
    db.commit()

    po = _load(db, po.id)
    return serialise_po(po, dispatched_by_line(db, [po.id]), detail=True)


@router.post("/{po_id}/amend", response_model=PODetail, status_code=201)
def amend_po(
    po_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Customers revise orders constantly. Snapshot the current version rather
    than editing over the top of it, so the original stays auditable."""
    original = _load(db, po_id)
    assert_can_edit_po(original, user)

    latest_rev = db.scalar(
        select(func.max(CustomerPO.revision)).where(
            CustomerPO.customer_id == original.customer_id,
            CustomerPO.po_number == original.po_number,
        )
    ) or 0

    copy = CustomerPO(
        po_number=original.po_number,
        revision=latest_rev + 1,
        po_date=original.po_date,
        customer_id=original.customer_id,
        owner_id=original.owner_id,
        expected_delivery_date=original.expected_delivery_date,
        payment_terms_days=original.payment_terms_days,
        reference=original.reference,
        notes=original.notes,
        status=POStatus.open,
    )
    for ln in original.lines:
        copy.lines.append(
            POLine(
                line_no=ln.line_no,
                item_id=ln.item_id,
                description=ln.description,
                uom=ln.uom,
                qty_ordered=ln.qty_ordered,
                rate=ln.rate,
                tax_rate=ln.tax_rate,
                required_date=ln.required_date,
            )
        )
    original.status = POStatus.cancelled
    original.notes = f"{original.notes or ''}\nSuperseded by revision {latest_rev + 1}".strip()

    db.add(copy)
    db.flush()
    audit(db, "customer_pos", copy.id, "amend",
          f"revision {copy.revision} of {copy.po_number}", user)
    db.commit()

    copy = _load(db, copy.id)
    return serialise_po(copy, dispatched_by_line(db, [copy.id]), detail=True)


@router.delete("/{po_id}", status_code=204)
def cancel_po(
    po_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Orders are cancelled, never deleted — history stays intact."""
    po = _load(db, po_id)
    assert_can_edit_po(po, user)
    if po.dispatches:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This order already has dispatches. Put it on hold instead of cancelling.",
        )
    po.status = POStatus.cancelled
    audit(db, "customer_pos", po.id, "cancel", po.po_number, user)
    db.commit()
