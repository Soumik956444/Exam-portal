import os
from pathlib import Path
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent

class Settings(BaseSettings):
    mongodb_url: str = Field(default="mongodb://localhost:27017", validation_alias="MONGODB_URL")
    mongodb_uri: str | None = Field(default=None, validation_alias="MONGODB_URI")
    mongodb_db_name: str = "mern-auth"
    jwt_secret: str = "change-me-in-production"
    access_token_minutes: int = 1440  # 24 hours / 1 day
    refresh_token_days: int = 30
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    sender_email: str = "no-reply@secureexamportal.com"
    admin_email: str = "admin@example.com"
    admin_password: str = "ChangeThisAdminPassword!"
    student_email: str = "student@example.com"
    student_password: str = "ChangeMe123!"
    upload_dir: str = str(BASE_DIR / "uploads")
    max_upload_mb: int = 10
    gemini_api_key: str = ""
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def resolve_aliases_and_smtp(self):
        # If MONGODB_URI is provided, use it for mongodb_url
        if self.mongodb_uri:
            self.mongodb_url = self.mongodb_uri
        elif os.environ.get("MONGODB_URI"):
            self.mongodb_url = os.environ["MONGODB_URI"]

        # Auto-configure SMTP host if user provided Brevo or Gmail credentials
        if not self.smtp_host and self.smtp_user:
            if "brevo.com" in self.smtp_user or "sendinblue" in self.smtp_user:
                self.smtp_host = "smtp-relay.brevo.com"
            elif "@gmail.com" in self.smtp_user:
                self.smtp_host = "smtp.gmail.com"

        return self

settings = Settings()


