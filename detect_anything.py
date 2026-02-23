import torch
from PIL import Image
import numpy as np
import cv2
import argparse
import sys
import os
from transformers import (
    AutoProcessor, 
    AutoModelForZeroShotObjectDetection, 
    Sam2Model, 
    Sam2Processor,
    AutoModelForZeroShotImageClassification
)
import supervision as sv

# --- CONFIGURATION ---
DINO_PATH = r"datavision_hf_models\grounding-dino-base"
SAM2_PATH = r"datavision_hf_models\sam2-hiera-large"
SIGLIP_PATH = r"datavision_hf_models\siglip-so400m-patch14-384"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

import traceback

def load_models():
    """Load all models once."""
    print(f"Loading models to {DEVICE}...")
    try:
        print("  - Loading DINO...")
        p_dino = AutoProcessor.from_pretrained(DINO_PATH)
        m_dino = AutoModelForZeroShotObjectDetection.from_pretrained(DINO_PATH).to(DEVICE)
        
        print("  - Loading SAM 2...")
        p_sam2 = Sam2Processor.from_pretrained(SAM2_PATH)
        m_sam2 = Sam2Model.from_pretrained(SAM2_PATH).to(DEVICE)
        
        print("  - Loading SigLIP...")
        p_siglip = AutoProcessor.from_pretrained(SIGLIP_PATH)
        m_siglip = AutoModelForZeroShotImageClassification.from_pretrained(SIGLIP_PATH).to(DEVICE)
        
        return p_dino, m_dino, p_sam2, m_sam2, p_siglip, m_siglip
    except Exception as e:
        print(f"Error loading models: {e}")
        traceback.print_exc()
        print("\nPlease ensure model paths in script configuration are correct.")
        sys.exit(1)

def verify_with_google_siglip(image, boxes, text_prompt, processor_siglip, model_siglip, threshold=0.75):
    """
    Verify candidates using Google SigLIP.
    """
    if len(boxes) == 0:
        return []
    
    print(f"Verifying {len(boxes)} candidates with SigLIP (Target: '{text_prompt}')...")
    
    verified_indices = []
    # Create dynamic verification labels
    # We compare the target against generic negatives to gauge relative confidence
    candidate_labels = [
        f"a photo of {text_prompt}", 
        "a photo of the background", 
        "a photo of something else",
        "a photo of a noisy region"
    ]
    
    for i, box in enumerate(boxes):
        x1, y1, x2, y2 = map(int, box)
        # Pad crop by 20%
        w, h = x2 - x1, y2 - y1
        x1_p, y1_p = max(0, x1 - int(w*0.2)), max(0, y1 - int(h*0.2))
        x2_p, y2_p = min(image.width, x2 + int(w*0.2)), min(image.height, y2 + int(h*0.2))
        
        crop = image.crop((x1_p, y1_p, x2_p, y2_p))
        
        inputs = processor_siglip(text=candidate_labels, images=crop, return_tensors="pt", padding=True).to(DEVICE)
        
        with torch.no_grad():
            outputs = model_siglip(**inputs)
            probs = outputs.logits_per_image.softmax(dim=1).cpu().numpy()[0]
            
        siglip_score = probs[0] # Probability of matching the target prompt
        
        if siglip_score > threshold:
            # print(f"  [Match] Object {i} Score: {siglip_score:.3f}")
            verified_indices.append(i)
        else:
            # print(f"  [Reject] Object {i} Score: {siglip_score:.3f}")
            pass
            
    return verified_indices

def refine_masks_sam2(image, boxes, processor_sam2, model_sam2):
    """Generate high-quality masks using SAM 2."""
    width, height = image.size
    inputs_sam2 = processor_sam2(image, input_boxes=[boxes.tolist()], return_tensors="pt")
    inputs_sam2_gpu = {k: v.to(DEVICE) if isinstance(v, torch.Tensor) else v for k, v in inputs_sam2.items()}
    
    with torch.no_grad():
        outputs_sam2 = model_sam2(**inputs_sam2_gpu, multimask_output=True)
    
    final_masks = []
    for i in range(len(boxes)):
        iou_scores = outputs_sam2.iou_scores[0, i].cpu().numpy()
        # Intelligent level selection: prefer whole object (level 2) unless confidence is low
        best_idx = 2 if iou_scores[2] > (np.max(iou_scores) - 0.15) else np.argmax(iou_scores)
        raw_mask = outputs_sam2.pred_masks[0, i, best_idx]
        mask_full = torch.nn.functional.interpolate(
            raw_mask.unsqueeze(0).unsqueeze(0), 
            size=(height, width), 
            mode="bilinear", 
            align_corners=False
        )[0, 0]
        final_masks.append((mask_full > 0.0).cpu().numpy().astype(bool))
        
    return np.array(final_masks)

def process_image(image_path, prompt, output_path, models):
    p_dino, m_dino, p_sam2, m_sam2, p_siglip, m_siglip = models
    
    if not os.path.exists(image_path):
        print(f"Error: Image not found at {image_path}")
        return

    print(f"Processing: {image_path}")
    image = Image.open(image_path).convert("RGB")
    
    # 1. Automatic Prompt Decomposition
    # Strategy: Use a generic noun for discovery, then the full detailed prompt for verification.
    # Simple heuristic: Split by first noun or use the whole prompt if short.
    # For now, we'll use a broad "objects" or "entities" discovery approach if prompt is complex,
    # or just use the prompt itself with lower threshold.
    
    # Discovery Prompt: simplified version
    # Ensure prompt is a string and strip whitespace
    safe_prompt = str(prompt).strip() if prompt else "object"
    discovery_prompt = f"{safe_prompt} . object ."
    
    print(f"Stage 1: Discovery (Prompt: '{discovery_prompt}')")
    inputs_dino = p_dino(images=image, text=discovery_prompt, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs_dino = m_dino(**inputs_dino)
    
    # Low threshold for high recall
    results_dino = p_dino.post_process_grounded_object_detection(
        outputs_dino, inputs_dino.input_ids, threshold=0.10, text_threshold=0.10,
        target_sizes=torch.Tensor([[image.height, image.width]]).to(DEVICE)
    )[0]
    
    boxes = results_dino["boxes"].cpu().numpy()
    scores = results_dino["scores"].cpu().numpy()
    
    if len(boxes) == 0:
        print("No candidates found in Stage 1.")
        return

    # 2. NMS (Overlap Removal)
    # Standard 0.5 IOU threshold for generic use
    predictions = np.concatenate([boxes, scores.reshape(-1, 1)], axis=1)
    mask_to_keep = sv.box_non_max_suppression(predictions, iou_threshold=0.5)
    boxes = boxes[mask_to_keep]
    
    # 3. Size Filtering
    # Remove boxes > 30% of image area (likely background/crowd noise)
    img_area = image.width * image.height
    filtered_boxes = []
    for box in boxes:
        x1, y1, x2, y2 = box
        if ((x2 - x1) * (y2 - y1)) < (img_area * 0.3): 
            filtered_boxes.append(box)
    boxes = np.array(filtered_boxes)
    
    if len(boxes) == 0:
        print("All candidates filtered by size (too large).")
        return

    # 4. Google SigLIP Verification
    # Use the EXACT user prompt for strict verification
    verified_indices = verify_with_google_siglip(image, boxes, prompt, p_siglip, m_siglip, threshold=0.7)
    
    if len(verified_indices) > 0:
        verified_boxes = boxes[verified_indices]
        
        # 5. SAM 2 Segmentation
        print(f"Stage 3: Segmenting {len(verified_boxes)} verified objects...")
        masks = refine_masks_sam2(image, verified_boxes, p_sam2, m_sam2)
        
        # 6. Visualization
        detections = sv.Detections(
            xyxy=verified_boxes, 
            mask=masks,
            class_id=np.arange(len(verified_boxes))
        )
        annotated = np.array(image)
        annotated = sv.MaskAnnotator(opacity=0.6).annotate(scene=annotated, detections=detections)
        annotated = sv.BoxAnnotator(thickness=3).annotate(scene=annotated, detections=detections)
        annotated = sv.LabelAnnotator(text_scale=0.8).annotate(
            scene=annotated, 
            detections=detections, 
            labels=[f"Obj {i}" for i in range(len(verified_boxes))]
        )
        
        cv2.imwrite(output_path, cv2.cvtColor(annotated, cv2.COLOR_RGB2BGR))
        print(f"SUCCESS: Saved result to {output_path}")
    else:
        print("No objects passed verification.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generic Grounded SAM 2 + SigLIP Detector")
    parser.add_argument("image_path", help="Path to input image")
    parser.add_argument("prompt", help="Text prompt to detect (e.g., 'cat', 'red car')")
    parser.add_argument("--output", default="detection_result.png", help="Path to save output image")
    
    args = parser.parse_args()
    
    models = load_models()
    process_image(args.image_path, args.prompt, args.output, models)
