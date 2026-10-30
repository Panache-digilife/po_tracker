"""Daily reminder digests.

Run once each morning from a Render Cron Job:

    python -m app.jobs.reminders

Design notes:
  * One email per person per day listing everything they own, not one email
    per line. The second version gets filtered to trash within a fortnight.
  * Every send is written to reminder_log with a unique constraint on
    (entity_type, entity_id, rule, fire_date), so re-running the job — which
    you will do while testing — cannot double-send.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..db import SessionLocal
from ..models import (
    CustomerPO,
    Invoice,
    InvoiceStatus,
    POStatus,
    ReminderLog,
    User,
)
from ..services.core import ZERO, dispatched_by_line, m, q, qty_str

log = logging.getLogger("reminders")

DELIVERY_WARNING_DAYS = 7
PAYMENT_WARNING_DAYS = 5


def money(value: Decimal) -> str:
    return f"₹{value:,.2f}"


def already_sent(db: Session, entity_type: str, entity_id: int,
                 rule: str, today: date) -> bool:
    return db.scalar(
        select(ReminderLog).where(
            ReminderLog.entity_type == entity_type,
            ReminderLog.entity_id == entity_id,
            ReminderLog.rule == rule,
            ReminderLog.fire_date == today,
        )
    ) is not None


def collect(db: Session, today: date) -> dict[int, list[dict]]:
    """Group everything due into a per-owner digest."""
    digests: dict[int, list[dict]] = defaultdict(list)

    pos = db.scalars(
        select(CustomerPO)
        .options(
            selectinload(CustomerPO.lines),
            selectinload(CustomerPO.customer),
        )
        .where(CustomerPO.status.in_([POStatus.open, POStatus.partial]))
    ).all()
    dispatched = dispatched_by_line(db, [p.id for p in pos])

    for po in pos:
        for line in po.lines:
            pending = q(line.qty_ordered) - min(
                dispatched.get(line.id, ZERO), q(line.qty_ordered)
            )
            if pending <= 0:
                continue
            due = line.required_date or po.expected_delivery_date
            if not due:
                continue

            days = (due - today).days
            if days < 0:
                rule = "delivery_overdue"
                label = f"Overdue by {abs(days)} day{'s' if abs(days) != 1 else ''}"
            elif days <= DELIVERY_WARNING_DAYS:
                rule = "delivery_due"
                label = "Due today" if days == 0 else f"Due in {days} days"
            else:
                continue

            if already_sent(db, "po_line", line.id, rule, today):
                continue

            digests[po.owner_id].append(
                {
                    "entity_type": "po_line",
                    "entity_id": line.id,
                    "rule": rule,
                    "urgent": days < 0,
                    "headline": f"{po.po_number} — {line.description}",
                    "detail": (
                        f"{po.customer.name if po.customer else ''} · "
                        f"{qty_str(pending)} {line.uom} pending · {label}"
                    ),
                    "link": f"{settings.app_base_url}/app.html#/orders/{po.id}",
                }
            )

    invoices = db.scalars(
        select(Invoice)
        .options(
            selectinload(Invoice.payments),
            selectinload(Invoice.customer),
            selectinload(Invoice.po),
        )
        .where(Invoice.status.in_([InvoiceStatus.unpaid, InvoiceStatus.part_paid]))
    ).all()

    for inv in invoices:
        received = sum((m(p.amount) for p in inv.payments), ZERO)
        balance = m(inv.total_amount) - received
        if balance <= 0:
            continue

        days = (inv.due_date - today).days
        if days < 0:
            rule = "payment_overdue"
            label = f"Overdue by {abs(days)} days"
        elif days <= PAYMENT_WARNING_DAYS:
            rule = "payment_due"
            label = "Due today" if days == 0 else f"Due in {days} days"
        else:
            continue

        if already_sent(db, "invoice", inv.id, rule, today):
            continue

        owner_id = inv.po.owner_id if inv.po else None
        if not owner_id:
            continue

        digests[owner_id].append(
            {
                "entity_type": "invoice",
                "entity_id": inv.id,
                "rule": rule,
                "urgent": days < 0,
                "headline": f"Invoice {inv.invoice_no}",
                "detail": (
                    f"{inv.customer.name if inv.customer else ''} · "
                    f"{money(balance)} outstanding · {label}"
                ),
                "link": f"{settings.app_base_url}/app.html#/invoices",
            }
        )

    return digests


def render_email(user: User, items: list[dict], today: date) -> str:
    urgent = [i for i in items if i["urgent"]]
    upcoming = [i for i in items if not i["urgent"]]

    def block(title: str, rows: list[dict], colour: str) -> str:
        if not rows:
            return ""
        lis = "".join(
            f"""<li style="margin:0 0 14px;padding:0 0 0 14px;
                     border-left:3px solid {colour};">
                  <a href="{r['link']}" style="color:#12305C;text-decoration:none;
                     font-weight:600;font-size:15px;">{r['headline']}</a>
                  <div style="color:#5A6673;font-size:13px;margin-top:3px;">
                    {r['detail']}</div>
                </li>"""
            for r in rows
        )
        return f"""
          <p style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;
             color:#5A6673;margin:26px 0 12px;">{title} ({len(rows)})</p>
          <ul style="list-style:none;padding:0;margin:0;">{lis}</ul>"""

    return f"""
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;
                max-width:560px;margin:0 auto;padding:28px;">
      <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;
         color:#5A6673;margin:0;">{settings.company_name} · Order book</p>
      <h1 style="font-size:22px;color:#12305C;margin:6px 0 4px;">
        {len(items)} item{'s' if len(items) != 1 else ''} need your attention</h1>
      <p style="color:#5A6673;font-size:13px;margin:0;">{today:%A, %d %B %Y}</p>
      {block("Overdue", urgent, "#C8372D")}
      {block("Coming up", upcoming, "#E8A317")}
      <p style="color:#8A94A0;font-size:12px;margin-top:32px;
         border-top:1px solid #E3E7EC;padding-top:14px;">
        Sent because you own these orders. Open the order book to update them.</p>
    </div>"""


def send_email(to: str, subject: str, html: str) -> bool:
    if not settings.resend_api_key:
        log.warning("RESEND_API_KEY not set — would have emailed %s: %s", to, subject)
        return False
    try:
        response = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.mail_from,
                "to": [to],
                "subject": subject,
                "html": html,
            },
            timeout=20,
        )
        response.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        log.error("Email to %s failed: %s", to, exc)
        return False


def run() -> None:
    today = date.today()
    db = SessionLocal()
    try:
        digests = collect(db, today)
        if not digests:
            log.info("Nothing due today.")
            return

        for owner_id, items in digests.items():
            user = db.get(User, owner_id)
            if not user or not user.is_active:
                continue

            overdue = sum(1 for i in items if i["urgent"])
            subject = (
                f"{overdue} overdue · {len(items)} open items"
                if overdue
                else f"{len(items)} items due this week"
            )

            sent = send_email(user.email, subject, render_email(user, items, today))

            for item in items:
                db.add(
                    ReminderLog(
                        entity_type=item["entity_type"],
                        entity_id=item["entity_id"],
                        rule=item["rule"],
                        fire_date=today,
                        sent_to_id=user.id,
                    )
                )
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
            log.info("%s: %d items, delivered=%s", user.email, len(items), sent)
    finally:
        db.close()


if __name__ == "__main__":
    run()
