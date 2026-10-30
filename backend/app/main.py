from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .db import Base, engine
from .routers import auth_users, extract, fulfilment, masters, pos, reports

logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="Order Book API",
    description="Customer purchase order tracking for manufacturers.",
    version="1.0.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_users.router, prefix="/api")
app.include_router(masters.router, prefix="/api")
app.include_router(pos.router, prefix="/api")
app.include_router(fulfilment.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
app.include_router(extract.router, prefix="/api")


@app.on_event("startup")
def create_tables_and_admin():
    """Runs once each time the server process starts.

    Safe to run on every boot: table creation is a no-op if tables already
    exist, and the admin account is only created if it isn't there yet.
    This replaces a separate seed step, since the free Render tier has no
    shell and no pre-deploy command.
    """
    from .seed import ensure_admin
    from .db import SessionLocal

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        ensure_admin(db)
    finally:
        db.close()


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok"}


@app.get("/api/config", tags=["system"])
def config():
    return {
        "company_name": settings.company_name,
        "company_gstin": settings.company_gstin,
    }


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    logging.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Something went wrong on our side. Try again."},
    )
