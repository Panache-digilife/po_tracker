from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from .models import InvoiceStatus, POStatus, Role


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserBase(BaseModel):
    name: str
    email: EmailStr
    role: Role = Role.staff
    is_active: bool = True


class UserCreate(UserBase):
    password: str = Field(min_length=8)


class UserUpdate(BaseModel):
    name: str | None = None
    role: Role | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8)
    current_password: str | None = None


class UserOut(ORMModel, UserBase):
    id: int


# ---------------------------------------------------------------- masters


class CustomerBase(BaseModel):
    code: str | None = None
    name: str
    gstin: str | None = None
    contact_person: str | None = None
    email: str | None = None
    phone: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    payment_terms_days: int = 30
    credit_limit: Decimal = Decimal("0")
    is_active: bool = True


class CustomerCreate(CustomerBase):
    pass


class CustomerUpdate(BaseModel):
    name: str | None = None
    gstin: str | None = None
    contact_person: str | None = None
    email: str | None = None
    phone: str | None = None
    billing_address: str | None = None
    shipping_address: str | None = None
    payment_terms_days: int | None = None
    credit_limit: Decimal | None = None
    is_active: bool | None = None


class CustomerOut(ORMModel, CustomerBase):
    id: int


class CustomerWithStats(CustomerOut):
    open_pos: int = 0
    pending_value: Decimal = Decimal("0")
    outstanding: Decimal = Decimal("0")


class ItemBase(BaseModel):
    code: str
    name: str
    uom: str = "NOS"
    hsn_code: str | None = None
    default_rate: Decimal = Decimal("0")
    tax_rate: Decimal = Decimal("18")
    is_active: bool = True


class ItemCreate(ItemBase):
    pass


class ItemUpdate(BaseModel):
    name: str | None = None
    uom: str | None = None
    hsn_code: str | None = None
    default_rate: Decimal | None = None
    tax_rate: Decimal | None = None
    is_active: bool | None = None


class ItemOut(ORMModel, ItemBase):
    id: int


# ---------------------------------------------------------------- purchase orders


class POLineIn(BaseModel):
    id: int | None = None
    item_id: int | None = None
    description: str
    uom: str = "NOS"
    qty_ordered: Decimal = Field(gt=0)
    rate: Decimal = Field(ge=0)
    tax_rate: Decimal = Decimal("18")
    required_date: date | None = None


class POLineOut(ORMModel):
    id: int
    line_no: int
    item_id: int | None
    description: str
    uom: str
    qty_ordered: Decimal
    rate: Decimal
    tax_rate: Decimal
    required_date: date | None
    qty_dispatched: Decimal = Decimal("0")
    qty_pending: Decimal = Decimal("0")
    line_total: Decimal = Decimal("0")
    pending_value: Decimal = Decimal("0")


class POBase(BaseModel):
    po_number: str
    po_date: date
    customer_id: int
    expected_delivery_date: date | None = None
    payment_terms_days: int = 30
    reference: str | None = None
    notes: str | None = None
    attachment_name: str | None = None
    attachment_url: str | None = None


class POCreate(POBase):
    owner_id: int | None = None
    status: POStatus = POStatus.open
    lines: list[POLineIn] = []


class POUpdate(BaseModel):
    po_number: str | None = None
    po_date: date | None = None
    customer_id: int | None = None
    owner_id: int | None = None
    expected_delivery_date: date | None = None
    payment_terms_days: int | None = None
    reference: str | None = None
    notes: str | None = None
    status: POStatus | None = None
    attachment_name: str | None = None
    attachment_url: str | None = None
    lines: list[POLineIn] | None = None


class POSummary(ORMModel):
    id: int
    po_number: str
    revision: int
    po_date: date
    status: POStatus
    customer_id: int
    customer_name: str = ""
    owner_id: int
    owner_name: str = ""
    expected_delivery_date: date | None
    order_value: Decimal = Decimal("0")
    pending_value: Decimal = Decimal("0")
    completion_pct: float = 0.0
    days_to_delivery: int | None = None
    is_overdue: bool = False


class PODetail(POSummary):
    payment_terms_days: int
    reference: str | None
    notes: str | None
    attachment_name: str | None
    attachment_url: str | None
    lines: list[POLineOut] = []
    dispatches: list[DispatchOut] = []
    invoices: list[InvoiceOut] = []
    invoiced_value: Decimal = Decimal("0")
    received_value: Decimal = Decimal("0")
    dispatched_value: Decimal = Decimal("0")
    to_invoice_balance: Decimal = Decimal("0")


# ---------------------------------------------------------------- dispatch


class DispatchLineIn(BaseModel):
    po_line_id: int
    qty: Decimal = Field(gt=0)


class DispatchLineOut(ORMModel):
    id: int
    po_line_id: int
    description: str = ""
    uom: str = ""
    qty: Decimal


class DispatchCreate(BaseModel):
    po_id: int
    dispatch_date: date
    challan_no: str | None = None
    eway_bill: str | None = None
    vehicle_no: str | None = None
    transporter: str | None = None
    notes: str | None = None
    lines: list[DispatchLineIn]


class DispatchOut(ORMModel):
    id: int
    dispatch_no: str
    po_id: int
    po_number: str = ""
    customer_name: str = ""
    dispatch_date: date
    challan_no: str | None
    eway_bill: str | None
    vehicle_no: str | None
    transporter: str | None
    notes: str | None
    created_by_id: int
    created_by_name: str = ""
    value: Decimal = Decimal("0")
    lines: list[DispatchLineOut] = []


# ---------------------------------------------------------------- invoicing


class InvoiceCreate(BaseModel):
    invoice_no: str
    invoice_date: date
    po_id: int
    dispatch_id: int | None = None
    basic_amount: Decimal = Field(ge=0)
    tax_amount: Decimal = Field(default=Decimal("0"), ge=0)
    due_date: date | None = None
    notes: str | None = None


class InvoiceUpdate(BaseModel):
    invoice_date: date | None = None
    due_date: date | None = None
    basic_amount: Decimal | None = None
    tax_amount: Decimal | None = None
    status: InvoiceStatus | None = None
    notes: str | None = None


class PaymentOut(ORMModel):
    id: int
    invoice_id: int
    payment_date: date
    amount: Decimal
    mode: str
    reference: str | None


class InvoiceOut(ORMModel):
    id: int
    invoice_no: str
    invoice_date: date
    due_date: date
    po_id: int
    po_number: str = ""
    customer_id: int
    customer_name: str = ""
    dispatch_id: int | None
    basic_amount: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    status: InvoiceStatus
    notes: str | None
    amount_received: Decimal = Decimal("0")
    balance: Decimal = Decimal("0")
    days_overdue: int = 0
    payments: list[PaymentOut] = []


class PaymentCreate(BaseModel):
    invoice_id: int
    payment_date: date
    amount: Decimal = Field(gt=0)
    mode: str = "NEFT"
    reference: str | None = None


# ---------------------------------------------------------------- reporting


class DashboardStats(BaseModel):
    open_pos: int
    order_book_value: Decimal
    pending_value: Decimal
    overdue_lines: int
    dispatches_this_month: int
    invoiced_this_month: Decimal
    outstanding_receivables: Decimal
    overdue_receivables: Decimal


class AgeingBucket(BaseModel):
    label: str
    count: int
    value: Decimal


class ActionItem(BaseModel):
    kind: str
    entity_id: int
    title: str
    subtitle: str
    due_date: date | None
    days: int
    severity: str


class AuditOut(ORMModel):
    id: int
    table_name: str
    row_id: int
    action: str
    detail: str | None
    user_id: int | None
    user_name: str = ""
    at: datetime


PODetail.model_rebuild()
TokenResponse.model_rebuild()
