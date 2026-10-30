from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_manager, require_staff
from ..db import get_db
from ..models import Customer, CustomerPO, Item, POStatus, User
from ..schemas import (
    CustomerCreate,
    CustomerOut,
    CustomerUpdate,
    CustomerWithStats,
    ItemCreate,
    ItemOut,
    ItemUpdate,
)
from ..services.core import (
    ZERO,
    audit,
    dispatched_by_line,
    outstanding_for_customer,
    q,
    m,
)

router = APIRouter(tags=["masters"])


# ---------------------------------------------------------------- customers


@router.get("/customers", response_model=list[CustomerWithStats])
def list_customers(
    search: str | None = None,
    active_only: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Customer)
    if active_only:
        stmt = stmt.where(Customer.is_active.is_(True))
    if search:
        pattern = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Customer.name).like(pattern),
                func.lower(Customer.code).like(pattern),
            )
        )
    customers = db.scalars(stmt.order_by(Customer.name)).all()

    results = []
    for c in customers:
        open_pos = db.scalars(
            select(CustomerPO).where(
                CustomerPO.customer_id == c.id,
                CustomerPO.status.in_([POStatus.open, POStatus.partial]),
            )
        ).all()
        dispatched = dispatched_by_line(db, [p.id for p in open_pos])
        pending = ZERO
        for po in open_pos:
            for ln in po.lines:
                done = min(dispatched.get(ln.id, ZERO), q(ln.qty_ordered))
                pending += m((q(ln.qty_ordered) - done) * Decimal(str(ln.rate)))

        row = CustomerWithStats.model_validate(c)
        row.open_pos = len(open_pos)
        row.pending_value = pending
        row.outstanding = outstanding_for_customer(db, c.id)
        results.append(row)
    return results


@router.post("/customers", response_model=CustomerOut, status_code=201)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    # Auto-generate code if not provided
    if not payload.code:
        all_codes = db.scalars(select(Customer.code)).all()
        numeric_codes = [int(c) for c in all_codes if c and c.isdigit()]
        next_num = max(numeric_codes, default=0) + 1
        payload = payload.model_copy(update={'code': str(next_num).zfill(3)})

    if db.scalar(select(Customer).where(Customer.code == payload.code)):
        raise HTTPException(status.HTTP_409_CONFLICT, "That customer code already exists")
    customer = Customer(**payload.model_dump())
    db.add(customer)
    db.flush()
    audit(db, "customers", customer.id, "create", customer.name, user)
    db.commit()
    db.refresh(customer)
    return customer


@router.get("/customers/{customer_id}", response_model=CustomerOut)
def get_customer(
    customer_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customer = db.get(Customer, customer_id)
    if not customer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    return customer


@router.patch("/customers/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    customer = db.get(Customer, customer_id)
    if not customer:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(customer, field, value)
    audit(db, "customers", customer.id, "update", ", ".join(data.keys()), user)
    db.commit()
    db.refresh(customer)
    return customer


# ---------------------------------------------------------------- items


@router.get("/items", response_model=list[ItemOut])
def list_items(
    search: str | None = None,
    active_only: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Item)
    if active_only:
        stmt = stmt.where(Item.is_active.is_(True))
    if search:
        pattern = f"%{search.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Item.name).like(pattern),
                func.lower(Item.code).like(pattern),
            )
        )
    return db.scalars(stmt.order_by(Item.code)).all()


@router.post("/items", response_model=ItemOut, status_code=201)
def create_item(
    payload: ItemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    if db.scalar(select(Item).where(Item.code == payload.code)):
        raise HTTPException(status.HTTP_409_CONFLICT, "That item code already exists")
    item = Item(**payload.model_dump())
    db.add(item)
    db.flush()
    audit(db, "items", item.id, "create", item.code, user)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/items/{item_id}", response_model=ItemOut)
def update_item(
    item_id: int,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
):
    item = db.get(Item, item_id)
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(item, field, value)
    audit(db, "items", item.id, "update", ", ".join(data.keys()), user)
    db.commit()
    db.refresh(item)
    return item
