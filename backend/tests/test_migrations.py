import pytest
from sqlalchemy import create_engine, inspect
from testcontainers.postgres import PostgresContainer
from alembic.config import Config
from alembic import command
import os

from app.models import Base

@pytest.fixture(scope="module")
def postgres_container():
    with PostgresContainer("postgres:16-alpine") as postgres:
        yield postgres

def test_migrations_match_models(postgres_container):
    """
    Test that running alembic upgrade head on a fresh database produces a schema
    that matches the SQLAlchemy models (Base.metadata).
    """
    db_url = postgres_container.get_connection_url().replace("postgresql+psycopg2://", "postgresql+psycopg://")
    
    # Patch settings before alembic is invoked
    from app.config import settings
    settings.database_url = db_url

    alembic_cfg = Config("alembic.ini")
    command.upgrade(alembic_cfg, "head")

    engine = create_engine(db_url)
    inspector = inspect(engine)
    
    # Get all table names in DB vs Base.metadata
    db_tables = set(inspector.get_table_names())
    model_tables = set(Base.metadata.tables.keys())
    
    # Exclude alembic_version table
    db_tables.discard("alembic_version")
    
    assert db_tables == model_tables, f"Tables mismatch. DB has {db_tables}, models have {model_tables}"

    # For each table, assert column names match
    for table_name in model_tables:
        db_columns = {col["name"] for col in inspector.get_columns(table_name)}
        model_columns = {col.name for col in Base.metadata.tables[table_name].columns}
        assert db_columns == model_columns, f"Columns mismatch in table {table_name}. DB has {db_columns}, models have {model_columns}"

def test_legacy_db_stamped():
    """
    Test that sync_schema correctly detects a legacy pre-migration DB
    and stamps it with 'head' rather than trying to recreate the tables.
    """
    with PostgresContainer("postgres:16-alpine") as postgres:
        db_url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql+psycopg://")
        
        # Patch settings
        from app.config import settings
        settings.database_url = db_url

        engine = create_engine(db_url)
        
        # 1. Simulate old DB by creating tables using Base.metadata
        Base.metadata.create_all(engine)
        
        # 2. Run sync_schema
        alembic_cfg = Config("alembic.ini")
        from app.db import sync_schema
        sync_schema(engine, alembic_cfg)
        
        # 3. Assert alembic_version exists and tables match
        inspector = inspect(engine)
        db_tables = set(inspector.get_table_names())
        model_tables = set(Base.metadata.tables.keys())
        
        assert "alembic_version" in db_tables, "alembic_version should be created by stamp"
        db_tables.discard("alembic_version")
        
        assert db_tables == model_tables, f"Tables mismatch. DB has {db_tables}, models have {model_tables}"
