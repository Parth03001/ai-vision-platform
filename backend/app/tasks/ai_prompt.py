import torch
from PIL import Image
import numpy as np
import uuid
import json
from pathlib import Path
from transformers import (
    AutoProcessor, 
    AutoModelForZeroShotObjectDetection, 
    Sam2Model, 
    Sam2Processor,
    AutoModelForZeroShotImageClassification
)
import supervision as sv

from app.tasks.celery_app import celery_app
from app.config import settings
from app.connectors.statedb_connector import StateDBConnector

# ── Model Cache ───────────────────────────────────────────────────────
_MODELS = {
    "p_dino": None, "m_dino": None,
    "p_sam2": None, "m_sam2": None,
    "p_siglip": None, "m_siglip": None
}

def load_ai_models():
    global _MODELS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    
    if _MODELS["m_dino"] is None:
        print(f"Loading AI Prompt models to {device}...")
        
        # Get absolute path to the project root (D:\ai-vision-platform)
        # assuming this file is in backend/app/tasks/
        base_dir = Path(__file__).resolve().parents[3] 
        
        dino_path   = str(base_dir / "datavision_hf_models" / "grounding-dino-base")
        sam2_path   = str(base_dir / "datavision_hf_models" / "sam2-hiera-large")
        siglip_path = str(base_dir / "datavision_hf_models" / "siglip-so400m-patch14-384")

        print(f"  - Loading DINO from {dino_path}...")
        _MODELS["p_dino"] = AutoProcessor.from_pretrained(dino_path)
        _MODELS["m_dino"] = AutoModelForZeroShotObjectDetection.from_pretrained(dino_path).to(device)
        
        print(f"  - Loading SAM 2 from {sam2_path}...")
        _MODELS["p_sam2"] = Sam2Processor.from_pretrained(sam2_path)
        _MODELS["m_sam2"] = Sam2Model.from_pretrained(sam2_path).to(device)
        
        print(f"  - Loading SigLIP from {siglip_path}...")
        _MODELS["p_siglip"] = AutoProcessor.from_pretrained(siglip_path)
        _MODELS["m_siglip"] = AutoModelForZeroShotImageClassification.from_pretrained(siglip_path).to(device)
    
    return _MODELS, device

# ── Helpers ───────────────────────────────────────────────────────────

def verify_with_siglip(image, boxes, text_prompt, processor, model, device, threshold=0.7):
    if len(boxes) == 0: return []
    verified_indices = []
    candidate_labels = [f"a photo of {text_prompt}", "background", "something else"]
    
    for i, box in enumerate(boxes):
        x1, y1, x2, y2 = map(int, box)
        w, h = x2 - x1, y2 - y1
        x1_p, y1_p = max(0, x1 - int(w*0.2)), max(0, y1 - int(h*0.2))
        x2_p, y2_p = min(image.width, x2 + int(w*0.2)), min(image.height, y2 + int(h*0.2))
        
        crop = image.crop((x1_p, y1_p, x2_p, y2_p))
        inputs = processor(text=candidate_labels, images=crop, return_tensors="pt", padding=True).to(device)
        
        with torch.no_grad():
            outputs = model(**inputs)
            probs = outputs.logits_per_image.softmax(dim=1).cpu().numpy()[0]
            
        if probs[0] > threshold:
            verified_indices.append(i)
    return verified_indices

def refine_masks(image, boxes, processor, model, device):
    width, height = image.size
    inputs = processor(image, input_boxes=[boxes.tolist()], return_tensors="pt")
    inputs_gpu = {k: v.to(device) if isinstance(v, torch.Tensor) else v for k, v in inputs.items()}
    
    with torch.no_grad():
        outputs = model(**inputs_gpu, multimask_output=True)
    
    final_masks = []
    for i in range(len(boxes)):
        iou_scores = outputs.iou_scores[0, i].cpu().numpy()
        best_idx = 2 if iou_scores[2] > (np.max(iou_scores) - 0.15) else np.argmax(iou_scores)
        raw_mask = outputs.pred_masks[0, i, best_idx]
        mask_full = torch.nn.functional.interpolate(
            raw_mask.unsqueeze(0).unsqueeze(0), 
            size=(height, width), 
            mode="bilinear", 
            align_corners=False
        )[0, 0]
        final_masks.append((mask_full > 0.0).cpu().numpy().astype(bool))
    return np.array(final_masks)

# ── Tasks ─────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.ai_prompt.detect_with_prompt", bind=True)
def detect_with_prompt(self, project_id: str, image_id: str, prompt: str, clear_existing: bool = False):
    db = StateDBConnector()
    models, device = load_ai_models()
    
    # 1. Fetch image path
    with db.get_session() as conn:
        img_rows = db.execute_query(conn, "SELECT id, filepath FROM images WHERE id = :id", {"id": image_id})
        if not img_rows: return {"error": "Image not found"}
        img_row = img_rows[0]

    real_path = Path(".") / img_row["filepath"].lstrip("/")
    if not real_path.exists():
        real_path = settings.upload_dir.parent / Path(img_row["filepath"].lstrip("/"))
    
    if not real_path.exists(): return {"error": f"File not found: {real_path}"}

    image = Image.open(real_path).convert("RGB")
    w, h = image.size

    # 2. Stage 1: Discovery (DINO)
    discovery_prompt = f"{prompt} . object ."
    inputs_dino = models["p_dino"](images=image, text=discovery_prompt, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs_dino = models["m_dino"](**inputs_dino)
    
    results_dino = models["p_dino"].post_process_grounded_object_detection(
        outputs_dino, inputs_dino.input_ids, threshold=0.15, text_threshold=0.15,
        target_sizes=torch.Tensor([[h, w]]).to(device)
    )[0]
    
    boxes = results_dino["boxes"].cpu().numpy()
    scores = results_dino["scores"].cpu().numpy()
    
    if len(boxes) == 0: return {"status": "success", "count": 0}

    # 3. NMS & Size Filter
    predictions = np.concatenate([boxes, scores.reshape(-1, 1)], axis=1)
    keep = sv.box_non_max_suppression(predictions, iou_threshold=0.5)
    boxes = boxes[keep]
    
    img_area = w * h
    boxes = np.array([b for b in boxes if ((b[2]-b[0])*(b[3]-b[1])) < (img_area * 0.4)])
    
    if len(boxes) == 0: return {"status": "success", "count": 0}

    # 4. Stage 2: Verification (SigLIP)
    verified_idx = verify_with_siglip(image, boxes, prompt, models["p_siglip"], models["m_siglip"], device)
    if not verified_idx: return {"status": "success", "count": 0}
    verified_boxes = boxes[verified_idx]

    # 5. Stage 3: Segmentation (SAM 2)
    masks = refine_masks(image, verified_boxes, models["p_sam2"], models["m_sam2"], device)

    # 6. Save to DB
    with db.get_session() as conn:
        # ── 6a. Register class if new ──────────────────────────────
        proj_rows = db.execute_query(
            conn, 
            "SELECT classes FROM projects WHERE id = :id", 
            {"id": project_id}
        )
        if proj_rows:
            raw = proj_rows[0].get("classes")
            current_classes = []
            if isinstance(raw, str): current_classes = json.loads(raw)
            elif isinstance(raw, list): current_classes = raw
            
            if prompt not in current_classes:
                current_classes.append(prompt)
                db.execute_update(
                    conn,
                    "UPDATE projects SET classes = CAST(:cls AS JSONB) WHERE id = :id",
                    {"cls": json.dumps(current_classes), "id": project_id}
                )

        # ── 6b. Save annotations ──────────────────────────────────
        if clear_existing:
            db.execute_update(conn, "DELETE FROM annotations WHERE image_id = :id", {"id": image_id})
        
        ann_rows = []
        for i in range(len(verified_boxes)):
            # Convert box to normalized xywh for platform consistency
            box = verified_boxes[i]
            # detection_anything uses absolute xyxy
            # Platform uses normalized xywh: [center_x, center_y, width, height]
            nx = ((box[0] + box[2]) / 2) / w
            ny = ((box[1] + box[3]) / 2) / h
            nw = (box[2] - box[0]) / w
            nh = (box[3] - box[1]) / h
            
            ann_rows.append({
                "id": str(uuid.uuid4()),
                "image_id": image_id,
                "class_name": prompt,
                "bbox": json.dumps([float(nx), float(ny), float(nw), float(nh)]),
                "source": "ai_prompt"
            })
        
        db.execute_many(
            conn,
            "INSERT INTO annotations (id, image_id, class_name, bbox, source) "
            "VALUES (:id, :image_id, :class_name, CAST(:bbox AS JSONB), :source)",
            ann_rows
        )
        db.execute_update(conn, "UPDATE images SET status = 'annotated' WHERE id = :id", {"id": image_id})

    return {"status": "success", "count": len(ann_rows)}

@celery_app.task(name="app.tasks.ai_prompt.bulk_detect_with_prompt", bind=True)
def bulk_detect_with_prompt(self, project_id: str, prompt: str, image_ids: list = None):
    db = StateDBConnector()
    
    if not image_ids:
        with db.get_session() as conn:
            rows = db.execute_query(
                conn, 
                "SELECT id FROM images WHERE project_id = :pid AND status = 'pending'",
                {"pid": project_id}
            )
            image_ids = [r["id"] for r in rows]
    
    if not image_ids: return {"status": "success", "count": 0}

    total = len(image_ids)
    processed = 0
    total_found = 0

    for i, img_id in enumerate(image_ids):
        self.update_state(state="STARTED", meta={"current": i+1, "total": total})
        res = detect_with_prompt(project_id, img_id, prompt, clear_existing=False)
        if "count" in res:
            total_found += res["count"]
        processed += 1
    
    return {"status": "success", "processed": processed, "total_found": total_found}
