from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.image import Image
from app.schemas.base import ImageResponse
from app.config import settings
from typing import List
import shutil
import os
import uuid
from PIL import Image as PILImage

router = APIRouter(prefix="/images", tags=["images"])

@router.post("/upload/{project_id}", response_model=List[ImageResponse])
async def upload_images(
    project_id: str,
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db)
):
    project_dir = settings.upload_dir / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    
    uploaded_images = []
    for file in files:
        file_ext = os.path.splitext(file.filename)[1]
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = project_dir / unique_filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        with PILImage.open(file_path) as img:
            width, height = img.size
            
        db_image = Image(
            project_id=project_id,
            filename=file.filename,
            filepath=f"/uploads/{project_id}/{unique_filename}",
            width=width,
            height=height
        )
        db.add(db_image)
        uploaded_images.append(db_image)
        
    await db.commit()
    for img in uploaded_images:
        await db.refresh(img)
        
    return uploaded_images

@router.get("/project/{project_id}", response_model=List[ImageResponse])
async def list_project_images(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Image).where(Image.project_id == project_id))
    return result.scalars().all()
