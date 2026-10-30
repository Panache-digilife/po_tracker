import os
from functools import lru_cache


class Settings:
    """Runtime configuration, read from environment variables."""

    def __init__(self) -> None:
        self.database_url = self._normalise(
            os.getenv("DATABASE_URL", "sqlite:///./po_tracker.db")
        )
        self.jwt_secret = os.getenv("JWT_SECRET", "change-me-in-production")
        self.jwt_algorithm = "HS256"
        self.access_token_hours = int(os.getenv("ACCESS_TOKEN_HOURS", "10"))

        origins = os.getenv("CORS_ORIGINS", "*")
        self.cors_origins = [o.strip() for o in origins.split(",") if o.strip()]

        self.company_name = os.getenv("COMPANY_NAME", "Your Company Pvt Ltd")
        self.company_gstin = os.getenv("COMPANY_GSTIN", "")

        # Outbound mail (Resend). Reminders are skipped when unset.
        self.resend_api_key = os.getenv("RESEND_API_KEY", "")
        self.mail_from = os.getenv("MAIL_FROM", "orders@example.com")
        self.app_base_url = os.getenv("APP_BASE_URL", "http://localhost:5173")

        # Google Gemini — used for PO PDF extraction
        self.google_api_key = os.getenv("GOOGLE_API_KEY", "")

        self.seed_admin_email = os.getenv("SEED_ADMIN_EMAIL", "admin@example.com")
        self.seed_admin_password = os.getenv("SEED_ADMIN_PASSWORD", "changeme123")

    @staticmethod
    def _normalise(url: str) -> str:
        # Render hands out postgres:// which SQLAlchemy 2.x no longer accepts.
        if url.startswith("postgres://"):
            return url.replace("postgres://", "postgresql+psycopg://", 1)
        if url.startswith("postgresql://"):
            return url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
