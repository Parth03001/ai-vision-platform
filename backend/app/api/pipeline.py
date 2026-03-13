from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
from ..tasks.training import train_seed_model, train_main_model
from ..tasks.auto_annotate import auto_annotate_remaining
from ..tasks.ai_prompt import detect_with_prompt, bulk_detect_with_prompt
from ..tasks.celery_app import celery_app
from ..database import get_db
from ..models.image import Image
from ..models.annotation import Annotation
from ..models.project import Project
from ..models.training_job import TrainingJob
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from celery.result import AsyncResult
from ..config import settings

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


# ── Available YOLO models ─────────────────────────────────────────

YOLO_MODELS = [
    # YOLO11 (latest Ultralytics)
    {"value": "yolo11n.pt", "label": "YOLO11 Nano — fastest",        "family": "YOLO11"},
    {"value": "yolo11s.pt", "label": "YOLO11 Small",                  "family": "YOLO11"},
    {"value": "yolo11m.pt", "label": "YOLO11 Medium",                 "family": "YOLO11"},
    {"value": "yolo11l.pt", "label": "YOLO11 Large",                  "family": "YOLO11"},
    {"value": "yolo11x.pt", "label": "YOLO11 XL — best accuracy",    "family": "YOLO11"},
    # YOLOv10
    {"value": "yolov10n.pt", "label": "YOLOv10 Nano",                 "family": "YOLOv10"},
    {"value": "yolov10s.pt", "label": "YOLOv10 Small",                "family": "YOLOv10"},
    {"value": "yolov10m.pt", "label": "YOLOv10 Medium",               "family": "YOLOv10"},
    {"value": "yolov10b.pt", "label": "YOLOv10 Base",                 "family": "YOLOv10"},
    {"value": "yolov10l.pt", "label": "YOLOv10 Large",                "family": "YOLOv10"},
    {"value": "yolov10x.pt", "label": "YOLOv10 XL",                   "family": "YOLOv10"},
    # YOLOv9
    {"value": "yolov9c.pt", "label": "YOLOv9 C",                      "family": "YOLOv9"},
    {"value": "yolov9e.pt", "label": "YOLOv9 E — high accuracy",      "family": "YOLOv9"},
    # YOLOv8
    {"value": "yolov8n.pt", "label": "YOLOv8 Nano",                   "family": "YOLOv8"},
    {"value": "yolov8s.pt", "label": "YOLOv8 Small",                  "family": "YOLOv8"},
    {"value": "yolov8m.pt", "label": "YOLOv8 Medium",                 "family": "YOLOv8"},
    {"value": "yolov8l.pt", "label": "YOLOv8 Large",                  "family": "YOLOv8"},
    {"value": "yolov8x.pt", "label": "YOLOv8 XL",                     "family": "YOLOv8"},
]


@router.get("/available-models")
async def get_available_models():
    """Return the list of supported YOLO model weights for the UI dropdowns."""
    # Group by family for the frontend <optgroup>
    families: dict = {}
    for m in YOLO_MODELS:
        families.setdefault(m["family"], []).append(
            {"value": m["value"], "label": m["label"]}
        )
    return {"models": YOLO_MODELS, "families": families}


# ── Training ──────────────────────────────────────────────────────

class TrainSeedRequest(BaseModel):
    model_name: str = "yolo11n.pt"
    epochs: int = 50
    imgsz: int = 640


@router.post("/train-seed/{project_id}")
async def start_seed_training(project_id: str, body: TrainSeedRequest = None):
    req = body or TrainSeedRequest()
    task = train_seed_model.delay(project_id, req.model_name, req.epochs, req.imgsz)
    return {"task_id": task.id, "status": "queued"}


class TrainMainRequest(BaseModel):
    model_name: str = "yolo11n.pt"
    epochs: int = 100
    use_seed_weights: bool = True
    imgsz: int = 640


@router.post("/train-main/{project_id}")
async def start_main_training(project_id: str, body: TrainMainRequest = None):
    req = body or TrainMainRequest()
    task = train_main_model.delay(
        project_id, req.model_name, req.epochs, req.use_seed_weights, req.imgsz
    )
    return {"task_id": task.id, "status": "queued"}


# ── Auto-annotate ────────────────────────────────────────────────

class AutoAnnotateRequest(BaseModel):
    image_ids: Optional[List[str]] = None  # None = all pending
    conf: float = 0.1                      # detection confidence threshold


@router.post("/auto-annotate/{project_id}")
async def start_auto_annotation(project_id: str, body: AutoAnnotateRequest = None):
    ids  = body.image_ids if body else None
    conf = body.conf if body else 0.1
    task = auto_annotate_remaining.delay(project_id, ids, conf)
    return {"task_id": task.id, "status": "queued"}


# ── AI Prompt ───────────────────────────────────────────────────

class AIPromptRequest(BaseModel):
    project_id: str
    image_id: str
    prompt: str
    clear_existing: bool = False

class AIBulkPromptRequest(BaseModel):
    project_id: str
    prompt: str
    image_ids: Optional[List[str]] = None

@router.post("/ai-prompt")
async def trigger_ai_prompt(body: AIPromptRequest):
    """Detect objects in a single image using a text prompt."""
    task = detect_with_prompt.delay(
        body.project_id, body.image_id, body.prompt, body.clear_existing
    )
    return {"task_id": task.id}

@router.post("/ai-bulk-prompt")
async def trigger_ai_bulk_prompt(body: AIBulkPromptRequest):
    """Detect objects in multiple images using a text prompt."""
    task = bulk_detect_with_prompt.delay(
        body.project_id, body.prompt, body.image_ids
    )
    return {"task_id": task.id}


@router.get("/pending-images/{project_id}")
async def get_pending_images(project_id: str, db: AsyncSession = Depends(get_db)):
    """Return pending images AND annotated-but-empty images (status=annotated, 0 bbox records)."""
    from sqlalchemy import func, outerjoin
    from sqlalchemy.orm import aliased

    # Images that are pending
    pending_q = await db.execute(
        select(Image).where(Image.project_id == project_id, Image.status == "pending")
    )
    pending_images = pending_q.scalars().all()

    # Images marked annotated but with ZERO annotation records (stale from previous runs)
    annotated_q = await db.execute(
        select(Image).where(Image.project_id == project_id, Image.status == "annotated")
    )
    all_annotated = annotated_q.scalars().all()

    empty_annotated = []
    for img in all_annotated:
        count_q = await db.execute(
            select(func.count(Annotation.id)).where(Annotation.image_id == img.id)
        )
        count = count_q.scalar()
        if count == 0:
            # Reset to pending so they can be re-annotated
            img.status = "pending"
            empty_annotated.append(img)

    if empty_annotated:
        await db.commit()

    images = pending_images + empty_annotated
    return [
        {
            "id": img.id,
            "filename": img.filename,
            "filepath": img.filepath,
            "width": img.width,
            "height": img.height,
        }
        for img in images
    ]


@router.get("/model-status/{project_id}")
async def get_model_status(project_id: str):
    """Check whether trained seed/main models exist for this project."""
    seed_path = settings.model_dir / project_id / "seed_best.pt"
    main_path = settings.model_dir / project_id / "main_best.pt"
    return {
        # Legacy field kept for backward-compat with AutoAnnotatePanel
        "has_seed_model":  seed_path.exists(),
        "model_path":      str(seed_path) if seed_path.exists() else None,
        # New fields
        "seed_model_path": str(seed_path) if seed_path.exists() else None,
        "has_main_model":  main_path.exists(),
        "main_model_path": str(main_path) if main_path.exists() else None,
    }


@router.get("/model-details/{project_id}")
async def get_model_details(project_id: str, db: AsyncSession = Depends(get_db)):
    """
    Return rich details about trained models for a project:
    - File existence + size
    - Last successful training job (metrics, model name, dates)
    """
    seed_path = settings.model_dir / project_id / "seed_best.pt"
    main_path = settings.model_dir / project_id / "main_best.pt"

    def file_info(path):
        if not path.exists():
            return {"exists": False, "file_size_mb": None, "modified_at": None}
        stat = path.stat()
        return {
            "exists": True,
            "file_size_mb": round(stat.st_size / (1024 * 1024), 2),
            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        }

    async def latest_job(job_type: str):
        q = (
            select(TrainingJob)
            .where(TrainingJob.project_id == project_id, TrainingJob.job_type == job_type)
            .order_by(desc(TrainingJob.created_at))
            .limit(1)
        )
        result = await db.execute(q)
        job = result.scalar_one_or_none()
        if not job:
            return None
        return {
            "id": job.id,
            "status": job.status,
            "result_meta": job.result_meta or {},
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        }

    seed_info = file_info(seed_path)
    main_info = file_info(main_path)
    seed_job  = await latest_job("seed_training")
    main_job  = await latest_job("main_training")

    return {
        "seed": {**seed_info, "last_job": seed_job},
        "main": {**main_info, "last_job": main_job},
    }


@router.get("/download-model/{project_id}/{model_type}")
async def download_model(project_id: str, model_type: str):
    """
    Stream the trained model weights file as a download.
    model_type: 'seed' | 'main'
    """
    if model_type not in ("seed", "main"):
        raise HTTPException(status_code=400, detail="model_type must be 'seed' or 'main'")

    filename = f"{model_type}_best.pt"
    path = settings.model_dir / project_id / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{model_type} model not found for this project")

    return FileResponse(
        path=str(path),
        media_type="application/octet-stream",
        filename=filename,
    )


# ── Dataset stats ────────────────────────────────────────────────

@router.get("/training-stats/{project_id}")
async def get_training_stats(project_id: str, db: AsyncSession = Depends(get_db)):
    all_imgs = await db.execute(select(Image).where(Image.project_id == project_id))
    images = all_imgs.scalars().all()

    total = len(images)
    annotated = [img for img in images if img.status == "annotated"]
    pending = [img for img in images if img.status == "pending"]

    annotated_ids = [img.id for img in annotated]
    class_counts = {}
    if annotated_ids:
        anns = await db.execute(
            select(Annotation.class_name, func.count(Annotation.id))
            .where(Annotation.image_id.in_(annotated_ids))
            .group_by(Annotation.class_name)
        )
        class_counts = {row[0]: row[1] for row in anns.fetchall()}

    total_anns = sum(class_counts.values())

    return {
        "total_images": total,
        "annotated_images": len(annotated),
        "pending_images": len(pending),
        "total_annotations": total_anns,
        "class_breakdown": class_counts,
        "ready_to_train": len(annotated) > 0,
    }


# ── Task status ───────────────────────────────────────────────────

@router.get("/task-status/{task_id}")
async def get_task_status(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    response = {
        "task_id": task_id,
        "status": result.state,
        "result": None,
        "meta": None,
        "error": None,
    }
    if result.state == "SUCCESS":
        response["result"] = result.result
    elif result.state == "STARTED":
        try:
            response["meta"] = result.info
        except Exception:
            pass
    elif result.state == "FAILURE":
        response["error"] = str(result.result)
    return response


# ── Persistent job records ────────────────────────────────────────

class JobCreateRequest(BaseModel):
    task_id: str
    project_id: str
    job_type: str = "seed_training"
    conf_used: Optional[float] = None
    result_meta: Optional[dict] = None


class JobUpdateRequest(BaseModel):
    status: Optional[str] = None
    result_meta: Optional[dict] = None
    finished_at: Optional[str] = None  # ISO-8601 string


@router.post("/jobs")
async def create_job(body: JobCreateRequest, db: AsyncSession = Depends(get_db)):
    """Persist a newly-submitted Celery job so it survives page reloads."""
    job = TrainingJob(
        id=body.task_id,
        project_id=body.project_id,
        job_type=body.job_type,
        status="pending",
        result_meta=body.result_meta or {},
        conf_used=body.conf_used,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return {"id": job.id, "created": True}


@router.get("/jobs/{project_id}")
async def list_jobs(
    project_id: str,
    job_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Return all persisted jobs for a project, oldest first."""
    q = select(TrainingJob).where(TrainingJob.project_id == project_id)
    if job_type:
        q = q.where(TrainingJob.job_type == job_type)
    q = q.order_by(TrainingJob.created_at.asc())

    result = await db.execute(q)
    jobs = result.scalars().all()

    return [
        {
            "id": job.id,
            "project_id": job.project_id,
            "job_type": job.job_type,
            "status": job.status,
            "result_meta": job.result_meta or {},
            "conf_used": job.conf_used,
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        }
        for job in jobs
    ]


@router.patch("/jobs/{task_id}")
async def update_job(
    task_id: str,
    body: JobUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update status and/or result_meta for a job."""
    result = await db.execute(
        select(TrainingJob).where(TrainingJob.id == task_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {task_id} not found")

    if body.status is not None:
        job.status = body.status
    if body.result_meta is not None:
        job.result_meta = body.result_meta
    if body.finished_at is not None:
        # Strip timezone info — the column is TIMESTAMP WITHOUT TIME ZONE.
        # The frontend sends ISO strings with a "Z" suffix (UTC-aware), which
        # asyncpg rejects when the column is tz-naive.
        job.finished_at = datetime.fromisoformat(body.finished_at).replace(tzinfo=None)

    await db.commit()
    return {"id": job.id, "status": job.status}
