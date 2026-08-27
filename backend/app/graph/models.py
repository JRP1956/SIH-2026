from datetime import datetime
from sqlalchemy import ForeignKey, Integer, String, Text, Float, Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base

class Contributor(Base):
    __tablename__ = "contributors"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    email: Mapped[str] = mapped_column(String(255), index=True)
    last_commit_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)

class CodeFile(Base):
    __tablename__ = "code_files"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(Text)
    is_orphan: Mapped[bool] = mapped_column(Boolean, default=False)

class AuthoredEdge(Base):
    __tablename__ = "authored_edges"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    scan_id: Mapped[int] = mapped_column(ForeignKey("scans.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("code_files.id", ondelete="CASCADE"), index=True)
    contributor_id: Mapped[int] = mapped_column(ForeignKey("contributors.id", ondelete="CASCADE"), index=True)
    lines_owned: Mapped[int] = mapped_column(Integer, default=0)
    ownership_percentage: Mapped[float] = mapped_column(Float, default=0.0)

class GithubInstallation(Base):
    __tablename__ = "github_installations"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    installation_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    account_login: Mapped[str] = mapped_column(String(255))
    access_token: Mapped[str | None] = mapped_column(String, default=None)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now())

class GithubInstallationRepo(Base):
    __tablename__ = "github_installation_repos"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    installation_id: Mapped[int] = mapped_column(ForeignKey("github_installations.installation_id", ondelete="CASCADE"), index=True)
    repo_key: Mapped[str] = mapped_column(String(255), unique=True, index=True)

class PRCache(Base):
    __tablename__ = "pr_cache"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    repo_key: Mapped[str] = mapped_column(String(255), index=True)
    pr_number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(500))
    author: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

class PRComment(Base):
    __tablename__ = "pr_comments"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    pr_id: Mapped[int] = mapped_column(ForeignKey("pr_cache.id", ondelete="CASCADE"), index=True)
    body: Mapped[str] = mapped_column(Text)
    author: Mapped[str] = mapped_column(String(255))

class CandidateRule(Base):
    __tablename__ = "candidate_rules"
    
    id: Mapped[int] = mapped_column(primary_key=True)
    repo_key: Mapped[str] = mapped_column(String(255), index=True)
    rule_text: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(50), default="pending")  # pending, accepted, rejected
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now())
