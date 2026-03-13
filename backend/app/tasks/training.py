from .celery_app import celery_app
from ultralytics import YOLO
import os
import shutil
import time
from pathlib import Path
from ..config import settings
from ..connectors.statedb_connector import StateDBConnector
from collections import defaultdict
import yaml
import json


# ── Shared helpers ────────────────────────────────────────────────

def _fetch_training_data(db, conn, project_id: str, status_filter: str = "annotated"):
    """Read project + images (filtered by status) + all annotations in one session."""
    proj_rows = db.execute_query(
        conn,
        "SELECT id, classes FROM projects WHERE id = :project_id",
        {"project_id": project_id},
    )
    if not proj_rows:
        return None, None, None, None

    raw_classes = proj_rows[0].get("classes")
    if isinstance(raw_classes, str):
        classes = json.loads(raw_classes) if raw_classes else []
    elif isinstance(raw_classes, list):
        classes = raw_classes
    else:
        classes = []

    img_rows = db.execute_query(
        conn,
        "SELECT id, filename, filepath FROM images "
        "WHERE project_id = :project_id AND status = :status",
        {"project_id": project_id, "status": status_filter},
    )
    if not img_rows:
        return proj_rows[0], classes, [], []

    image_ids = [img["id"] for img in img_rows]

    if not classes:
        placeholders = ", ".join(f":id_{i}" for i in range(len(image_ids)))
        params = {f"id_{i}": v for i, v in enumerate(image_ids)}
        class_rows = db.execute_query(
            conn,
            f"SELECT DISTINCT class_name FROM annotations "
            f"WHERE image_id IN ({placeholders})",
            params,
        )
        classes = [row["class_name"] for row in class_rows]

    placeholders = ", ".join(f":id_{i}" for i in range(len(image_ids)))
    params = {f"id_{i}": v for i, v in enumerate(image_ids)}
    ann_rows = db.execute_query(
        conn,
        f"SELECT image_id, class_name, bbox FROM annotations "
        f"WHERE image_id IN ({placeholders})",
        params,
    )
    return proj_rows[0], classes, img_rows, ann_rows


def _group_annotations(ann_rows):
    """Group raw annotation rows by image_id, normalising bbox type."""
    anns_by_image = defaultdict(list)
    for row in ann_rows:
        raw_bbox = row.get("bbox")
        bbox = json.loads(raw_bbox) if isinstance(raw_bbox, str) else raw_bbox
        anns_by_image[row["image_id"]].append({
            "class_name": row["class_name"],
            "bbox": bbox,
        })
    return anns_by_image


def _build_yolo_dataset(img_rows, anns_by_image, classes, project_id):
    """Build YOLO dataset directory on disk; return the path."""
    dataset_path = Path(f"./temp_dataset_{project_id}")
    dataset_path.mkdir(exist_ok=True)
    (dataset_path / "images").mkdir(exist_ok=True)
    (dataset_path / "labels").mkdir(exist_ok=True)

    for img in img_rows:
        real_path = Path(".") / img["filepath"].lstrip("/")
        if not real_path.exists():
            real_path = settings.upload_dir.parent / Path(img["filepath"].lstrip("/"))

        dest_name = os.path.basename(img["filepath"])
        shutil.copy(real_path, dataset_path / "images" / dest_name)

        label_file = dataset_path / "labels" / (os.path.splitext(dest_name)[0] + ".txt")
        with open(label_file, "w") as f:
            for ann in anns_by_image.get(img["id"], []):
                if ann["bbox"] and ann["class_name"] in classes:
                    cls_idx = classes.index(ann["class_name"])
                    bbox = ann["bbox"]
                    f.write(f"{cls_idx} {bbox[0]} {bbox[1]} {bbox[2]} {bbox[3]}\n")

    data_yaml = {
        "path": str(dataset_path.absolute()),
        "train": "images",
        "val":   "images",
        "nc":    len(classes),
        "names": classes,
    }
    with open(dataset_path / "data.yaml", "w") as f:
        yaml.dump(data_yaml, f)

    return dataset_path


def _make_epoch_callback(celery_task, total_epochs, epoch_history, epoch_start_times):
    """Return an on_fit_epoch_end callback that pushes live metrics to Celery."""
    def on_fit_epoch_end(trainer):
        epoch = trainer.epoch + 1

        losses = {}
        try:
            if hasattr(trainer, "loss_items") and trainer.loss_items is not None:
                vals = trainer.loss_items
                vals = vals.tolist() if hasattr(vals, "tolist") else list(vals)
                names = getattr(trainer, "loss_names", ["box_loss", "cls_loss", "dfl_loss"])
                for name, v in zip(names, vals):
                    losses[name] = round(float(v), 4)
        except Exception:
            pass

        metrics = {}
        try:
            if hasattr(trainer, "metrics") and trainer.metrics:
                for k, v in trainer.metrics.items():
                    clean = k.replace("metrics/", "").replace("(B)", "")
                    metrics[clean] = round(float(v), 4)
        except Exception:
            pass

        now = time.time()
        epoch_start_times.append(now)
        eta_seconds = None
        if len(epoch_start_times) >= 2:
            avg = (epoch_start_times[-1] - epoch_start_times[0]) / max(
                len(epoch_start_times) - 1, 1
            )
            eta_seconds = round(avg * (total_epochs - epoch))

        entry = {"epoch": epoch, **losses, **metrics}
        epoch_history.append(entry)

        try:
            celery_task.update_state(
                state="STARTED",
                meta={
                    "epoch":        epoch,
                    "total_epochs": total_epochs,
                    "eta_seconds":  eta_seconds,
                    "history":      epoch_history,
                },
            )
        except Exception:
            pass

    return on_fit_epoch_end


# ══════════════════════════════════════════════════════════════════
#  Seed Training Task
# ══════════════════════════════════════════════════════════════════

@celery_app.task(name="app.tasks.training.train_seed_model", bind=True)
def train_seed_model(
    self,
    project_id: str,
    model_name: str = "yolo11n.pt",
    epochs: int = 50,
    imgsz: int = 640,
):
    """
    Quick seed-training on manually annotated images.
    Synchronous — uses StateDBConnector (psycopg2), no asyncio event-loop conflict.

    Phases
    ------
    1. DB reads  — project + images (annotated) + annotations
    2. Dataset   — build YOLO directory on disk
    3. Training  — YOLO model.train()
    4. Cleanup   — copy seed_best.pt, remove temp dataset
    """
    db = StateDBConnector()

    # ── Phase 1: DB reads ────────────────────────────────────────
    with db.get_session() as conn:
        proj, classes, img_rows, ann_rows = _fetch_training_data(
            db, conn, project_id, status_filter="annotated"
        )

    if proj is None:
        return {"error": "Project not found"}
    if not img_rows:
        return {"error": "No annotated images found"}

    anns_by_image = _group_annotations(ann_rows)

    # ── Phase 2: Build dataset ───────────────────────────────────
    dataset_path = _build_yolo_dataset(img_rows, anns_by_image, classes, project_id)

    # ── Phase 3: Train ───────────────────────────────────────────
    total_epochs   = epochs
    epoch_history  = []
    epoch_start_times = []

    model = YOLO(model_name)
    model.add_callback(
        "on_fit_epoch_end",
        _make_epoch_callback(self, total_epochs, epoch_history, epoch_start_times),
    )

    self.update_state(
        state="STARTED",
        meta={"epoch": 0, "total_epochs": total_epochs, "eta_seconds": None,
              "history": [], "model_name": model_name},
    )

    results = model.train(
        data=str(dataset_path / "data.yaml"),
        epochs=total_epochs,
        imgsz=imgsz,
        lr0=settings.seed_learning_rate,
        project=str(settings.model_dir / project_id),
        name="seed_model",
        verbose=False,
    )

    # ── Phase 4: Persist + cleanup ───────────────────────────────
    best_model_path = results.save_dir / "weights" / "best.pt"
    target_path = settings.model_dir / project_id / "seed_best.pt"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(best_model_path, target_path)
    shutil.rmtree(dataset_path)

    final_metrics = epoch_history[-1] if epoch_history else {}

    return {
        "status":     "success",
        "model_path": str(target_path),
        "model_name": model_name,
        "metrics":    final_metrics,
        "history":    epoch_history,
    }


# ══════════════════════════════════════════════════════════════════
#  Main Training Task
# ══════════════════════════════════════════════════════════════════

@celery_app.task(name="app.tasks.training.train_main_model", bind=True)
def train_main_model(
    self,
    project_id: str,
    model_name: str = "yolo11n.pt",
    epochs: int = 100,
    use_seed_weights: bool = True,
    imgsz: int = 640,
):
    """
    Full/main training on ALL annotated images (manual + auto-annotated).
    When use_seed_weights=True, fine-tunes from the existing seed_best.pt;
    otherwise trains from the selected YOLO architecture.

    Phases
    ------
    1. DB reads  — project + ALL annotated images + annotations
    2. Dataset   — build YOLO directory on disk
    3. Training  — YOLO model.train()
    4. Cleanup   — copy main_best.pt, remove temp dataset
    """
    db = StateDBConnector()

    # ── Phase 1: DB reads ────────────────────────────────────────
    with db.get_session() as conn:
        proj, classes, img_rows, ann_rows = _fetch_training_data(
            db, conn, project_id, status_filter="annotated"
        )

    if proj is None:
        return {"error": "Project not found"}
    if not img_rows:
        return {"error": "No annotated images found"}

    # Resolve pretrained weights
    if use_seed_weights:
        seed_path = settings.model_dir / project_id / "seed_best.pt"
        if not seed_path.exists():
            return {"error": "Seed model not found — train seed model first, or disable 'Use seed weights'."}
        pretrained = str(seed_path)
    else:
        pretrained = model_name

    anns_by_image = _group_annotations(ann_rows)

    # ── Phase 2: Build dataset ───────────────────────────────────
    dataset_path = _build_yolo_dataset(
        img_rows, anns_by_image, classes, f"{project_id}_main"
    )

    # ── Phase 3: Train ───────────────────────────────────────────
    total_epochs   = epochs
    epoch_history  = []
    epoch_start_times = []

    model = YOLO(pretrained)
    model.add_callback(
        "on_fit_epoch_end",
        _make_epoch_callback(self, total_epochs, epoch_history, epoch_start_times),
    )

    self.update_state(
        state="STARTED",
        meta={"epoch": 0, "total_epochs": total_epochs, "eta_seconds": None,
              "history": [], "model_name": model_name,
              "use_seed_weights": use_seed_weights},
    )

    results = model.train(
        data=str(dataset_path / "data.yaml"),
        epochs=total_epochs,
        imgsz=imgsz,
        project=str(settings.model_dir / project_id),
        name="main_model",
        verbose=False,
    )

    # ── Phase 4: Persist + cleanup ───────────────────────────────
    best_model_path = results.save_dir / "weights" / "best.pt"
    target_path = settings.model_dir / project_id / "main_best.pt"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(best_model_path, target_path)
    shutil.rmtree(dataset_path)

    final_metrics = epoch_history[-1] if epoch_history else {}

    return {
        "status":           "success",
        "model_path":       str(target_path),
        "model_name":       model_name,
        "use_seed_weights": use_seed_weights,
        "metrics":          final_metrics,
        "history":          epoch_history,
    }
