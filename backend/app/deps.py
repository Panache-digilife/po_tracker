"""Row-level access control.

Every list query for POs and anything hanging off them goes through `scope_pos`.
Keeping it in exactly one place is what makes it auditable — the moment this
logic gets copy-pasted inline into endpoints, a leak becomes inevitable.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import Select

from .models import CustomerPO, Role, User


def scope_pos(stmt: Select, user: User) -> Select:
    if user.sees_everything or user.role == Role.stores:
        return stmt
    return stmt.where(CustomerPO.owner_id == user.id)


def assert_can_view_po(po: CustomerPO, user: User) -> None:
    if user.sees_everything or user.role == Role.stores:
        return
    if po.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This order belongs to someone else")


def assert_can_edit_po(po: CustomerPO, user: User) -> None:
    if user.sees_everything:
        return
    if user.role == Role.staff and po.owner_id == user.id:
        return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "You cannot edit this order")
