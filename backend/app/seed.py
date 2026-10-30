"""Create tables, the first admin user, and optionally demo data.

    python -m app.seed          # tables + admin only
    python -m app.seed --demo   # plus sample customers, items and orders
"""

from __future__ import annotations

import random
import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from .auth import hash_password
from .config import settings
from .db import Base, SessionLocal, engine
from .models import (
    Customer,
    CustomerPO,
    Dispatch,
    DispatchLine,
    Invoice,
    Item,
    POLine,
    POStatus,
    Role,
    User,
)
from .services.core import m, next_dispatch_no, recalc_invoice_status, recalc_po_status


def ensure_admin(db) -> User:
    admin = db.scalar(select(User).where(User.email == settings.seed_admin_email))
    if admin:
        print(f"Admin already exists: {admin.email}")
        return admin
    admin = User(
        name="System Admin",
        email=settings.seed_admin_email,
        password_hash=hash_password(settings.seed_admin_password),
        role=Role.admin,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    print(f"Created admin: {admin.email}")
    return admin


DEMO_USERS = [
    ("Priya Nair", "priya@example.com", Role.staff),
    ("Rahul Menon", "rahul@example.com", Role.staff),
    ("Sunil Kamble", "sunil@example.com", Role.stores),
    ("Anita Desai", "anita@example.com", Role.manager),
]

DEMO_CUSTOMERS = [
    ("CUS-001", "Meridian Engineering Works", 45, "27AABCM1234K1Z5"),
    ("CUS-002", "Kalpataru Industries", 30, "27AAECK5678L1Z2"),
    ("CUS-003", "Deccan Auto Components", 60, "29AADCD9012M1Z8"),
    ("CUS-004", "Northline Fabricators", 30, "07AAFCN3456N1Z1"),
    ("CUS-005", "Sterling Pumps & Valves", 45, "24AAGCS7890P1Z7"),
]

DEMO_ITEMS = [
    ("MS-FLG-150", "MS Flange 150mm ANSI B16.5", "NOS", 2450, "73072100"),
    ("SS-VLV-080", "SS 316 Gate Valve 80mm", "NOS", 8900, "84818030"),
    ("CI-HSG-220", "Cast Iron Pump Housing 220 Series", "NOS", 14500, "84139190"),
    ("MS-BRK-045", "MS Mounting Bracket Type-45", "NOS", 720, "73269099"),
    ("AL-CVR-100", "Aluminium Cover Plate 100mm", "NOS", 1180, "76109000"),
    ("SS-SHF-062", "SS Drive Shaft 62mm", "NOS", 5400, "84831091"),
]


def seed_demo(db, admin: User) -> None:
    if db.scalar(select(Customer).limit(1)):
        print("Demo data already present — skipping.")
        return

    random.seed(7)
    users = [admin]
    for name, email, role in DEMO_USERS:
        user = User(
            name=name,
            email=email,
            role=role,
            password_hash=hash_password("password123"),
        )
        db.add(user)
        users.append(user)
    db.flush()

    staff = [u for u in users if u.role in (Role.staff, Role.manager, Role.admin)]
    stores = next(u for u in users if u.role == Role.stores)

    customers = []
    for code, name, terms, gstin in DEMO_CUSTOMERS:
        c = Customer(
            code=code,
            name=name,
            gstin=gstin,
            payment_terms_days=terms,
            contact_person="Purchase Dept",
            email=f"purchase@{code.lower()}.example.com",
            phone="+91 22 4000 0000",
            billing_address="MIDC Industrial Area\nMaharashtra",
            shipping_address="MIDC Industrial Area\nMaharashtra",
            credit_limit=Decimal("2500000"),
        )
        db.add(c)
        customers.append(c)

    items = []
    for code, name, uom, rate, hsn in DEMO_ITEMS:
        it = Item(
            code=code,
            name=name,
            uom=uom,
            default_rate=Decimal(rate),
            hsn_code=hsn,
            tax_rate=Decimal("18"),
        )
        db.add(it)
        items.append(it)
    db.flush()

    today = date.today()
    invoice_seq = 1

    for n in range(28):
        customer = random.choice(customers)
        owner = random.choice(staff)
        po_date = today - timedelta(days=random.randint(0, 75))
        delivery = po_date + timedelta(days=random.randint(15, 55))

        po = CustomerPO(
            po_number=f"{customer.code[-3:]}/PO/{2600 + n}",
            po_date=po_date,
            customer_id=customer.id,
            owner_id=owner.id,
            expected_delivery_date=delivery,
            payment_terms_days=customer.payment_terms_days,
            reference=f"Quotation QT-{1400 + n}",
        )
        for line_no, item in enumerate(random.sample(items, random.randint(1, 4)), 1):
            po.lines.append(
                POLine(
                    line_no=line_no,
                    item_id=item.id,
                    description=item.name,
                    uom=item.uom,
                    qty_ordered=Decimal(random.choice([10, 20, 25, 40, 50, 100])),
                    rate=item.default_rate,
                    tax_rate=item.tax_rate,
                    required_date=delivery,
                )
            )
        db.add(po)
        db.flush()

        # Dispatch against roughly two thirds of the orders.
        if random.random() < 0.65:
            dispatch = Dispatch(
                dispatch_no=next_dispatch_no(db),
                po_id=po.id,
                dispatch_date=min(po_date + timedelta(days=random.randint(10, 40)), today),
                challan_no=f"DC/{2600 + n}",
                vehicle_no=f"MH-04-{random.randint(1000, 9999)}",
                transporter="Sharma Roadways",
                created_by_id=stores.id,
            )
            basic = Decimal("0")
            for line in po.lines:
                full = random.random() < 0.6
                qty = line.qty_ordered if full else (line.qty_ordered / 2)
                dispatch.lines.append(DispatchLine(po_line_id=line.id, qty=qty))
                basic += m(Decimal(qty) * line.rate)
            db.add(dispatch)
            db.flush()
            recalc_po_status(db, po)

            if random.random() < 0.75:
                tax = m(basic * Decimal("0.18"))
                inv_date = dispatch.dispatch_date + timedelta(days=1)
                invoice = Invoice(
                    invoice_no=f"INV/26-27/{invoice_seq:04d}",
                    invoice_date=inv_date,
                    due_date=inv_date + timedelta(days=customer.payment_terms_days),
                    po_id=po.id,
                    customer_id=customer.id,
                    dispatch_id=dispatch.id,
                    basic_amount=basic,
                    tax_amount=tax,
                    total_amount=basic + tax,
                )
                db.add(invoice)
                db.flush()
                invoice_seq += 1
                recalc_invoice_status(invoice)

    db.commit()
    print("Demo data created. Staff logins use password: password123")


def main() -> None:
    Base.metadata.create_all(bind=engine)
    print("Tables ready.")
    db = SessionLocal()
    try:
        admin = ensure_admin(db)
        if "--demo" in sys.argv:
            seed_demo(db, admin)
    finally:
        db.close()


if __name__ == "__main__":
    main()
