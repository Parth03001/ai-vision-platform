"""
deps.py — Shared FastAPI dependency helpers for authorization.
"""
from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models.project import Project
from ..models.user import User
from .auth import get_current_user


async def get_project_for_user(
    project_id: str,
    current_user: User,
    db: AsyncSession,
) -> Project:
    """
    Fetch a project by ID and verify it belongs to *current_user*.

    Raises 404 if the project doesn't exist (no information leakage about
    other users' projects).
    """
    result = await db.execute(
        select(Project).where(
            Project.id == project_id,
            Project.user_id == current_user.id,
        )
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
