from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import (
    create_access_token,
    get_current_user,
    hash_password,
    require_admin,
    verify_password,
)
from ..db import get_db
from ..models import User
from ..schemas import (
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..services.core import audit

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect"
        )
    if not user.is_active:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This account has been deactivated"
        )
    return TokenResponse(access_token=create_access_token(user), user=user)


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # Everyone needs the name list to assign owners; only admin can mutate.
    return db.scalars(select(User).order_by(User.name)).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    email = payload.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "That email is already in use")
    user = User(
        name=payload.name,
        email=email,
        role=payload.role,
        is_active=payload.is_active,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.flush()
    audit(db, "users", user.id, "create", f"{user.email} as {user.role.value}", admin)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    is_self = current_user.id == user_id
    is_admin = current_user.role.value == "admin"

    # Non-admins can only update their own password
    if not is_admin:
        if not is_self:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only change your own password")
        allowed = {"password", "current_password"}
        if set(payload.model_dump(exclude_unset=True).keys()) - allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role does not have access to this action")

    data = payload.model_dump(exclude_unset=True)
    current_password = data.pop("current_password", None)

    if password := data.pop("password", None):
        # If changing own password, verify current password first
        if is_self and not is_admin:
            if not current_password:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is required")
            if not verify_password(current_password, user.password_hash):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
        user.password_hash = hash_password(password)

    for field, value in data.items():
        setattr(user, field, value)

    if is_self and data.get("is_active") is False:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "You cannot deactivate your own account"
        )

    audit(db, "users", user.id, "update", ", ".join(data.keys()) or "password", current_user)
    db.commit()
    db.refresh(user)
    return user
