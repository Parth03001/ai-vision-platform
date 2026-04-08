from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..database import get_db
from ..models.annotation import Annotation
from ..models.image import Image
from ..models.user import User
from ..schemas.base import AnnotationCreate, AnnotationResponse
from ..api.auth import get_current_user
from ..api.deps import get_project_for_user
from typing import List
from pydantic import BaseModel

class ClassifyBody(BaseModel):
    class_name: str

router = APIRouter(prefix="/annotations", tags=["annotations"])


async def _verify_image_ownership(image_id: str, current_user: User, db: AsyncSession) -> Image:
    """Fetch an image and verify its project belongs to current_user."""
    image = await db.get(Image, image_id)
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    await get_project_for_user(image.project_id, current_user, db)
    return image


@router.post("", response_model=AnnotationResponse)
async def create_annotation(
    data: AnnotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    image = await _verify_image_ownership(data.image_id, current_user, db)

    annotation = Annotation(
        image_id=data.image_id,
        class_name=data.class_name,
        bbox=data.bbox,
        source=data.source,
    )
    db.add(annotation)
    image.status = "annotated"
    await db.commit()
    await db.refresh(annotation)
    return annotation


@router.get("/image/{image_id}", response_model=List[AnnotationResponse])
async def list_image_annotations(
    image_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _verify_image_ownership(image_id, current_user, db)
    result = await db.execute(select(Annotation).where(Annotation.image_id == image_id))
    return result.scalars().all()


@router.patch("/{annotation_id}/classify", response_model=AnnotationResponse)
async def classify_annotation(
    annotation_id: str,
    data: ClassifyBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign a class name to an AI-detected annotation and promote it to manual."""
    result = await db.execute(select(Annotation).where(Annotation.id == annotation_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await _verify_image_ownership(ann.image_id, current_user, db)
    ann.class_name = data.class_name
    ann.source = "manual"
    await db.commit()
    await db.refresh(ann)
    return ann


@router.patch("/{annotation_id}/verify")
async def verify_annotation(
    annotation_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark an AI annotation as verified by changing source to 'manual'."""
    result = await db.execute(select(Annotation).where(Annotation.id == annotation_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await _verify_image_ownership(ann.image_id, current_user, db)
    ann.source = "manual"
    await db.commit()
    return {"status": "verified", "id": annotation_id}


@router.delete("/{annotation_id}")
async def delete_annotation(
    annotation_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete an annotation (used for 'Reject')."""
    result = await db.execute(select(Annotation).where(Annotation.id == annotation_id))
    ann = result.scalar_one_or_none()
    if not ann:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await _verify_image_ownership(ann.image_id, current_user, db)

    image_id = ann.image_id
    await db.delete(ann)

    count_res = await db.execute(
        select(Annotation).where(Annotation.image_id == image_id)
    )
    if not count_res.scalars().first():
        img_res = await db.execute(select(Image).where(Image.id == image_id))
        img = img_res.scalar_one_or_none()
        if img:
            img.status = "pending"

    await db.commit()
    return {"status": "deleted"}
