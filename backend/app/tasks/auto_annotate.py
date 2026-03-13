from .celery_app import celery_app
from ultralytics import YOLO
from pathlib import Path
from ..config import settings
from ..connectors.statedb_connector import StateDBConnector
import uuid
import json


@celery_app.task(name="app.tasks.auto_annotate.auto_annotate_remaining", bind=True)
def auto_annotate_remaining(self, project_id: str, image_ids: list = None, conf: float = 0.1):
    """
    Synchronous Celery task — uses StateDBConnector (psycopg2) instead of the
    async SQLAlchemy engine so there is no asyncio event-loop conflict.
    """
    db = StateDBConnector()

    # ── 1. Check seed model (no DB needed) ──────────────────────────
    model_path = settings.model_dir / project_id / "seed_best.pt"
    if not model_path.exists():
        return {"error": "Seed model not found. Train the seed model first."}

    model = YOLO(str(model_path))
    class_map = model.names  # {cls_idx: 'class_name', ...}

    # ── 2. Fetch images to annotate ─────────────────────────────────
    with db.get_session() as conn:
        proj_rows = db.execute_query(
            conn,
            "SELECT id FROM projects WHERE id = :project_id",
            {"project_id": project_id},
        )
        if not proj_rows:
            return {"error": "Project not found"}

        if image_ids:
            placeholders = ", ".join(f":id_{i}" for i in range(len(image_ids)))
            id_params = {f"id_{i}": v for i, v in enumerate(image_ids)}
            id_params["project_id"] = project_id
            img_rows = db.execute_query(
                conn,
                f"SELECT id, filename, filepath FROM images "
                f"WHERE id IN ({placeholders}) AND project_id = :project_id",
                id_params,
            )
        else:
            img_rows = db.execute_query(
                conn,
                "SELECT id, filename, filepath FROM images "
                "WHERE project_id = :project_id AND status = 'pending'",
                {"project_id": project_id},
            )
    # connection returned to pool here

    if not img_rows:
        return {"error": "No images to annotate"}

    total = len(img_rows)
    total_annotated = 0

    self.update_state(
        state="STARTED",
        meta={
            "current": 0,
            "total": total,
            "current_image": None,
            "annotated_count": 0,
            "conf": conf,
        },
    )

    # ── 3. Predict → save annotations (one connection for all writes) ─
    with db.get_session() as conn:
        for idx, img in enumerate(img_rows):

            # Resolve filesystem path
            real_path = Path(".") / img["filepath"].lstrip("/")
            if not real_path.exists():
                real_path = settings.upload_dir.parent / Path(img["filepath"].lstrip("/"))

            label = img.get("filename") or img["filepath"]

            if not real_path.exists():
                self.update_state(
                    state="STARTED",
                    meta={
                        "current": idx + 1,
                        "total": total,
                        "current_image": label,
                        "annotated_count": total_annotated,
                        "conf": conf,
                    },
                )
                continue

            # Per-image progress
            self.update_state(
                state="STARTED",
                meta={
                    "current": idx + 1,
                    "total": total,
                    "current_image": label,
                    "annotated_count": total_annotated,
                    "conf": conf,
                },
            )

            # Run YOLO prediction
            try:
                results = model.predict(str(real_path), conf=conf, verbose=False)
            except Exception:
                continue

            # Build annotation rows for this image
            ann_rows = []
            for r in results:
                for box in r.boxes:
                    cls_idx = int(box.cls[0].cpu().numpy())
                    class_name = class_map.get(cls_idx)
                    if not class_name:
                        continue
                    xywhn = box.xywhn[0].cpu().numpy().tolist()
                    ann_rows.append({
                        "ann_id":     str(uuid.uuid4()),
                        "image_id":   img["id"],
                        "class_name": class_name,
                        # Pass as JSON string; PostgreSQL casts to JSONB
                        "bbox_json":  json.dumps(xywhn),
                    })

            if ann_rows:
                db.execute_many(
                    conn,
                    "INSERT INTO annotations (id, image_id, class_name, bbox, source) "
                    "VALUES (:ann_id, :image_id, :class_name, CAST(:bbox_json AS JSONB), 'auto')",
                    ann_rows,
                )
                db.execute_update(
                    conn,
                    "UPDATE images SET status = 'annotated' WHERE id = :id",
                    {"id": img["id"]},
                )
                total_annotated += 1
    # all changes committed here

    return {
        "status": "success",
        "annotated_count": total_annotated,
        "total": total,
        "conf_used": conf,
    }
