from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.annotation import Annotation
from app.models.image import Image
from app.schemas.base import AnnotationCreate, AnnotationResponse
from typing import List

router = APIRouter(prefix="/annotations", tags=["annotations"])

@router.post("", response_model=AnnotationResponse)
async def create_annotation(data: AnnotationCreate, db: AsyncSession = Depends(get_db)):
    annotation = Annotation(
        image_id=data.image_id,
        class_name=data.class_name,
        bbox=data.bbox,
        source=data.source
    )
    db.add(annotation)
    
    # Update image status to annotated
    result = await db.execute(select(Image).where(Image.id == data.image_id))
    image = result.scalar_one_or_none()
    if image:
        image.status = "annotated"
        
    await db.commit()
    await db.refresh(annotation)
    return annotation

@router.get("/image/{image_id}", response_model=List[AnnotationResponse])
async def list_image_annotations(image_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Annotation).where(Annotation.image_id == image_id))
    return result.scalars().all()
