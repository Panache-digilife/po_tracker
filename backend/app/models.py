from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

MONEY = Numeric(14, 2)
QTY = Numeric(14, 3)


class Role(str, enum.Enum):
    admin = "admin"       # everything, plus masters and users
    manager = "manager"   # sees every PO, can edit and close
    stores = "stores"     # confirms dispatches against any PO
    staff = "staff"       # sees and owns only their own POs


class POStatus(str, enum.Enum):
    draft = "draft"
    open = "open"
    partial = "partial"
    completed = "completed"
    on_hold = "on_hold"
    cancelled = "cancelled"


class InvoiceStatus(str, enum.Enum):
    unpaid = "unpaid"
    part_paid = "part_paid"
    paid = "paid"
    cancelled = "cancelled"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role, native_enum=False), default=Role.staff)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    @property
    def sees_everything(self) -> bool:
        return self.role in (Role.admin, Role.manager)


class Customer(Base, TimestampMixin):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    gstin: Mapped[str | None] = mapped_column(String(20))
    contact_person: Mapped[str | None] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(180))
    phone: Mapped[str | None] = mapped_column(String(40))
    billing_address: Mapped[str | None] = mapped_column(Text)
    shipping_address: Mapped[str | None] = mapped_column(Text)
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    credit_limit: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    pos: Mapped[list[CustomerPO]] = relationship(back_populates="customer")


class Item(Base, TimestampMixin):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    uom: Mapped[str] = mapped_column(String(20), default="NOS")
    hsn_code: Mapped[str | None] = mapped_column(String(20))
    default_rate: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class CustomerPO(Base, TimestampMixin):
    """A purchase order received FROM a customer. Our sales order."""

    __tablename__ = "customer_pos"
    __table_args__ = (
        UniqueConstraint("customer_id", "po_number", "revision", name="uq_customer_po"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    po_number: Mapped[str] = mapped_column(String(60), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    po_date: Mapped[date] = mapped_column(Date)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    expected_delivery_date: Mapped[date | None] = mapped_column(Date, index=True)
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    status: Mapped[POStatus] = mapped_column(
        Enum(POStatus, native_enum=False), default=POStatus.open, index=True
    )
    reference: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    attachment_name: Mapped[str | None] = mapped_column(String(255))
    attachment_url: Mapped[str | None] = mapped_column(String(500))

    customer: Mapped[Customer] = relationship(back_populates="pos")
    owner: Mapped[User] = relationship()
    lines: Mapped[list[POLine]] = relationship(
        back_populates="po", cascade="all, delete-orphan", order_by="POLine.line_no"
    )
    dispatches: Mapped[list[Dispatch]] = relationship(
        back_populates="po", cascade="all, delete-orphan"
    )
    invoices: Mapped[list[Invoice]] = relationship(back_populates="po")


class POLine(Base):
    __tablename__ = "po_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(
        ForeignKey("customer_pos.id", ondelete="CASCADE"), index=True
    )
    line_no: Mapped[int] = mapped_column(Integer, default=1)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"))
    description: Mapped[str] = mapped_column(String(300))
    uom: Mapped[str] = mapped_column(String(20), default="NOS")
    qty_ordered: Mapped[Decimal] = mapped_column(QTY)
    rate: Mapped[Decimal] = mapped_column(MONEY)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("18"))
    required_date: Mapped[date | None] = mapped_column(Date, index=True)

    po: Mapped[CustomerPO] = relationship(back_populates="lines")
    item: Mapped[Item | None] = relationship()
    dispatch_lines: Mapped[list[DispatchLine]] = relationship(back_populates="po_line")


class Dispatch(Base, TimestampMixin):
    __tablename__ = "dispatches"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_no: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    po_id: Mapped[int] = mapped_column(
        ForeignKey("customer_pos.id", ondelete="CASCADE"), index=True
    )
    dispatch_date: Mapped[date] = mapped_column(Date, index=True)
    challan_no: Mapped[str | None] = mapped_column(String(60))
    eway_bill: Mapped[str | None] = mapped_column(String(60))
    vehicle_no: Mapped[str | None] = mapped_column(String(40))
    transporter: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    po: Mapped[CustomerPO] = relationship(back_populates="dispatches")
    created_by: Mapped[User] = relationship()
    lines: Mapped[list[DispatchLine]] = relationship(
        back_populates="dispatch", cascade="all, delete-orphan"
    )


class DispatchLine(Base):
    __tablename__ = "dispatch_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_id: Mapped[int] = mapped_column(
        ForeignKey("dispatches.id", ondelete="CASCADE"), index=True
    )
    po_line_id: Mapped[int] = mapped_column(ForeignKey("po_lines.id"), index=True)
    qty: Mapped[Decimal] = mapped_column(QTY)

    dispatch: Mapped[Dispatch] = relationship(back_populates="lines")
    po_line: Mapped[POLine] = relationship(back_populates="dispatch_lines")


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_no: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    invoice_date: Mapped[date] = mapped_column(Date, index=True)
    due_date: Mapped[date] = mapped_column(Date, index=True)
    po_id: Mapped[int] = mapped_column(ForeignKey("customer_pos.id"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    dispatch_id: Mapped[int | None] = mapped_column(ForeignKey("dispatches.id"))
    basic_amount: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    tax_amount: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    total_amount: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"))
    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus, native_enum=False), default=InvoiceStatus.unpaid, index=True
    )
    notes: Mapped[str | None] = mapped_column(Text)

    po: Mapped[CustomerPO] = relationship(back_populates="invoices")
    customer: Mapped[Customer] = relationship()
    payments: Mapped[list[Payment]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan"
    )


class Payment(Base, TimestampMixin):
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), index=True
    )
    payment_date: Mapped[date] = mapped_column(Date, index=True)
    amount: Mapped[Decimal] = mapped_column(MONEY)
    mode: Mapped[str] = mapped_column(String(40), default="NEFT")
    reference: Mapped[str | None] = mapped_column(String(120))
    recorded_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    invoice: Mapped[Invoice] = relationship(back_populates="payments")


class ReminderLog(Base):
    __tablename__ = "reminder_log"
    __table_args__ = (
        UniqueConstraint("entity_type", "entity_id", "rule", "fire_date",
                         name="uq_reminder_once"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[int] = mapped_column(Integer)
    rule: Mapped[str] = mapped_column(String(60))
    fire_date: Mapped[date] = mapped_column(Date)
    sent_to_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    table_name: Mapped[str] = mapped_column(String(60), index=True)
    row_id: Mapped[int] = mapped_column(Integer, index=True)
    action: Mapped[str] = mapped_column(String(20))
    detail: Mapped[str | None] = mapped_column(Text)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
