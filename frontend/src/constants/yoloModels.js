/**
 * Supported YOLO model weights.
 * Ultralytics auto-downloads them on first use.
 *
 * Grouped for <optgroup> rendering; ordered newest → oldest within each family.
 */
export const YOLO_MODEL_GROUPS = [
    {
        family: "YOLO11",
        note: "Latest — recommended",
        models: [
            { value: "yolo11n.pt", label: "YOLO11 Nano — fastest ⚡",     params: "2.6M"  },
            { value: "yolo11s.pt", label: "YOLO11 Small",                  params: "9.4M"  },
            { value: "yolo11m.pt", label: "YOLO11 Medium",                 params: "20.1M" },
            { value: "yolo11l.pt", label: "YOLO11 Large",                  params: "25.3M" },
            { value: "yolo11x.pt", label: "YOLO11 XL — best accuracy 🏆", params: "56.9M" },
        ],
    },
    {
        family: "YOLOv10",
        models: [
            { value: "yolov10n.pt", label: "YOLOv10 Nano",   params: "2.3M"  },
            { value: "yolov10s.pt", label: "YOLOv10 Small",  params: "7.2M"  },
            { value: "yolov10m.pt", label: "YOLOv10 Medium", params: "15.4M" },
            { value: "yolov10b.pt", label: "YOLOv10 Base",   params: "19.1M" },
            { value: "yolov10l.pt", label: "YOLOv10 Large",  params: "24.4M" },
            { value: "yolov10x.pt", label: "YOLOv10 XL",     params: "29.5M" },
        ],
    },
    {
        family: "YOLOv9",
        models: [
            { value: "yolov9c.pt", label: "YOLOv9 C",                    params: "25.3M" },
            { value: "yolov9e.pt", label: "YOLOv9 E — high accuracy",    params: "57.3M" },
        ],
    },
    {
        family: "YOLOv8",
        models: [
            { value: "yolov8n.pt", label: "YOLOv8 Nano",   params: "3.2M"  },
            { value: "yolov8s.pt", label: "YOLOv8 Small",  params: "11.2M" },
            { value: "yolov8m.pt", label: "YOLOv8 Medium", params: "25.9M" },
            { value: "yolov8l.pt", label: "YOLOv8 Large",  params: "43.7M" },
            { value: "yolov8x.pt", label: "YOLOv8 XL",     params: "68.2M" },
        ],
    },
];

/** Flat list of all models (same data, useful for lookup) */
export const YOLO_MODELS_FLAT = YOLO_MODEL_GROUPS.flatMap(g =>
    g.models.map(m => ({ ...m, family: g.family }))
);

/** Default model for seed training (light & fast) */
export const DEFAULT_SEED_MODEL = "yolo11n.pt";

/** Default model for main training (slightly larger for accuracy) */
export const DEFAULT_MAIN_MODEL = "yolo11s.pt";
