from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), default=None)
    github_id: Mapped[str | None] = mapped_column(String(64), unique=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Scan(Base):
    __tablename__ = "scans"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    repo_key: Mapped[str] = mapped_column(String(255), index=True)
    mode: Mapped[str] = mapped_column(String(16), default="full")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    security_score: Mapped[int | None] = mapped_column(Integer, default=None)
    vibe_debt_score: Mapped[int | None] = mapped_column(Integer, default=None)
    ai_available: Mapped[bool] = mapped_column(default=False)
    error: Mapped[str | None] = mapped_column(String(500), default=None)
    # How to fetch the code at scan time.
    # git (clone a URL) | zip (extract an upload) | local (copy a directory, tests only)
    source_type: Mapped[str] = mapped_column(String(8), default="git")
    source_ref: Mapped[str] = mapped_column(Text)  # clone URL, or temp zip path
    base_ref: Mapped[str | None] = mapped_column(String(255), default=None)
    head_ref: Mapped[str | None] = mapped_column(String(255), default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    findings: Mapped[list["Finding"]] = relationship(
        back_populates="scan", cascade="all, delete-orphan"
    )


class Finding(Base):
    __tablename__ = "findings"

    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id"), index=True)
    tool: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(16), default="security")
    file: Mapped[str] = mapped_column(Text)
    line: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(Text)
    license_id: Mapped[str | None] = mapped_column(String(64), default=None)
    ai_explanation: Mapped[str | None] = mapped_column(Text, default=None)
    ai_fix: Mapped[str | None] = mapped_column(Text, default=None)
    extra: Mapped[dict | None] = mapped_column("metadata", JSONB, default=None)

    scan: Mapped["Scan"] = relationship(back_populates="findings")
