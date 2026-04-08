"""
migrations.py
~~~~~~~~~~~~~
Lightweight schema-migration helper for the AI Vision Platform.

SQLAlchemy's ``checkfirst=True`` only creates *missing tables* — it never
alters existing columns.  This module fills that gap by running a sequence of
idempotent ``ALTER TABLE`` statements at application startup, after the core
tables have been created.

All statements use ``IF NOT EXISTS`` / ``IF EXISTS`` guards so they are safe
to run on every startup regardless of whether the migration has been applied
before.
"""

from __future__ import annotations

import logging
from typing import Sequence

import psycopg2
from psycopg2 import sql as psql

from ..config import get_settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Migration registry
# Each entry is a (description, sql_string) tuple.
# SQL must be idempotent (use ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
# EXISTS, etc.).
# ---------------------------------------------------------------------------

_MIGRATIONS: Sequence[tuple[str, str]] = [
    (
        "Add user_id column to projects (owner FK)",
        """
        ALTER TABLE projects
            ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)
            REFERENCES users(id) ON DELETE CASCADE;
        """,
    ),
    (
        "Index projects.user_id for fast per-user listing",
        """
        CREATE INDEX IF NOT EXISTS ix_projects_user_id ON projects (user_id);
        """,
    ),
]


def run_migrations() -> None:
    """
    Execute all pending schema migrations against the application database.

    Uses a raw psycopg2 connection (synchronous) so it can be called from
    the ``StateDBManager`` synchronous bootstrap, which runs in a thread
    executor during FastAPI startup.
    """
    cfg = get_settings()
    dsn = (
        f"host={cfg.postgres_host} port={cfg.postgres_port} "
        f"dbname={cfg.postgres_db} "
        f"user={cfg.postgres_user} password={cfg.postgres_password}"
    )

    try:
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        cursor = conn.cursor()

        for description, statement in _MIGRATIONS:
            try:
                cursor.execute(statement)
                logger.info("Migration OK: %s", description)
            except Exception as exc:
                # Log but continue — a failing migration might just mean the
                # change is already in place or not applicable.
                logger.warning("Migration skipped (%s): %s", description, exc)

        cursor.close()
        conn.close()
        logger.info("migrations: all migrations processed.")

    except Exception as exc:
        logger.error("migrations: could not connect to run migrations: %s", exc)
        raise
