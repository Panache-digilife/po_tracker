from __future__ import annotations

import base64
import json
import re

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from ..auth import get_current_user
from ..config import settings
from ..models import User

router = APIRouter(prefix="/extract", tags=["extract"])

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/gemini-3.5-flash-lite:generateContent"
)

PROMPT = """You are extracting purchase order data from this document.

Return ONLY a valid JSON object — no markdown, no explanation, no backticks. 
Exactly this structure:

{
  "po_number": "string or null",
  "po_date": "YYYY-MM-DD or null",
  "customer_name": "full legal company name or null",
  "payment_terms_days": 30,
  "notes": "delivery address or special instructions or null",
  "lines": [
    {
      "description": "item/product description",
      "uom": "NOS",
      "qty": 1,
      "rate": 0.0
    }
  ]
}

Rules:
- po_date must be YYYY-MM-DD format
- uom: use NOS if not specified, otherwise use exactly what's in the doc
- rate: the unit price (not total). If only total and qty are given, divide them. If not found use 0
- qty: always a number
- Extract ALL line items you can find
- customer_name: the company that ISSUED this PO (the buyer), not the supplier"""


@router.post("/po-pdf")
async def extract_po_pdf(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
) -> dict:
    if not settings.google_api_key:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "PDF extraction is not configured. Add GOOGLE_API_KEY to environment variables.",
        )

    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext == "pdf":
        mime_type = "application/pdf"
    elif ext in ("jpg", "jpeg"):
        mime_type = "image/jpeg"
    elif ext == "png":
        mime_type = "image/png"
    else:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Upload a PDF, JPG, or PNG of the PO document.",
        )

    content = await file.read()
    b64 = base64.b64encode(content).decode()

    payload = {
        "contents": [{
            "parts": [
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": b64,
                    }
                },
                {"text": PROMPT},
            ]
        }],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 2048,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                GEMINI_URL,
                params={"key": settings.google_api_key},
                json=payload,
            )
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        detail = e.response.text[:300]
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Gemini API error: {detail}",
        )
    except httpx.RequestError as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Could not reach Gemini API: {e}",
        )

    try:
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        # Strip any accidental markdown fences
        clean = re.sub(r"```(?:json)?|```", "", raw).strip()
        extracted = json.loads(clean)
    except Exception:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Could not parse Gemini response. Try a clearer PDF.",
        )

    return extracted
