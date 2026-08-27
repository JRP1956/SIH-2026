from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import Base

database_url = settings.database_url
if database_url.startswith("postgresql://"):
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
engine = create_engine(
    database_url, 
    pool_pre_ping=True,
    connect_args={"prepare_threshold": None}
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


import os
from alembic import command
from alembic.config import Config

from sqlalchemy import inspect

def sync_schema(engine, config: Config) -> None:
    inspector = inspect(engine)
    has_alembic = inspector.has_table("alembic_version")
    has_users = inspector.has_table("users")
    
    if has_users and not has_alembic:
        # Pre-migration DB: tables exist but no alembic history.
        # Stamp it as 'head' so we don't try to CREATE TABLE again.
        command.stamp(config, "head")
    else:
        # Fresh DB or already Alembic-managed DB.
        command.upgrade(config, "head")

def init_db() -> None:
    """Initialize DB and run migrations."""
    if os.environ.get("RUN_MIGRATIONS", "true").lower() == "true":
        # NOTE: safe with a single backend replica. For multiple replicas,
        # move to init container or deploy step to avoid concurrent upgrade races.
        alembic_cfg = Config("alembic.ini")
        sync_schema(engine, alembic_cfg)


def get_db() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
