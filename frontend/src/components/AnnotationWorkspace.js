import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Stage, Layer, Rect, Text, Image } from 'react-konva';
import useImage from 'use-image';
import TrainingPanel from './TrainingPanel';
import AutoAnnotatePanel from './AutoAnnotatePanel';
import MainTrainingPanel from './MainTrainingPanel';
import LabelsPanel from './LabelsPanel';
import ModelsPanel from './ModelsPanel';
import './AnnotationWorkspace.css';

const API_URL = "http://localhost:8000/api/v1";

const KonvaImage = ({ src }) => {
    const [image] = useImage(src, 'anonymous');
    return <Image image={image} />;
};

// ── Class Picker ────────────────────────────────────────────────
const ClassPicker = ({ classes, usedClasses, onConfirm, onCancel }) => {
    const [customClass, setCustomClass] = useState('');
    const inputRef = useRef(null);

    // Merge project classes + already-used classes, dedupe, keep order
    const presetSet = new Set(classes);
    const usedOnly = usedClasses.filter(c => !presetSet.has(c));
    const allOptions = [...classes, ...usedOnly]; // presets first, then extra used ones

    useEffect(() => {
        if (allOptions.length === 0 && inputRef.current) {
            inputRef.current.focus();
        }
    }, []); // eslint-disable-line

    const handleConfirmCustom = () => {
        if (customClass.trim()) onConfirm(customClass.trim());
    };

    return (
        <div className="class-picker-overlay" onClick={onCancel}>
            <div className="class-picker" onClick={e => e.stopPropagation()}>
                <div className="class-picker-header">
                    <span>Select Class</span>
                    <button className="class-picker-close" onClick={onCancel}>✕</button>
                </div>

                {allOptions.length > 0 && (
                    <div className="class-picker-list">
                        {classes.length > 0 && (
                            <p className="class-picker-section-label">Project Classes</p>
                        )}
                        {classes.map(cls => (
                            <button
                                key={cls}
                                className="class-picker-item"
                                onClick={() => onConfirm(cls)}
                            >
                                <span className="class-picker-dot" />
                                {cls}
                            </button>
                        ))}

                        {usedOnly.length > 0 && (
                            <>
                                <p className="class-picker-section-label class-picker-section-label--used">
                                    Recently Used
                                </p>
                                {usedOnly.map(cls => (
                                    <button
                                        key={cls}
                                        className="class-picker-item class-picker-item--used"
                                        onClick={() => onConfirm(cls)}
                                    >
                                        <span className="class-picker-dot class-picker-dot--used" />
                                        {cls}
                                    </button>
                                ))}
                            </>
                        )}
                    </div>
                )}

                <div className="class-picker-custom">
                    <input
                        ref={inputRef}
                        className="class-picker-input"
                        placeholder={allOptions.length > 0 ? 'Or type a new class…' : 'Type a class name…'}
                        value={customClass}
                        onChange={e => setCustomClass(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') handleConfirmCustom();
                            if (e.key === 'Escape') onCancel();
                        }}
                    />
                    <button
                        className="class-picker-confirm"
                        onClick={handleConfirmCustom}
                        disabled={!customClass.trim()}
                    >
                        Add
                    </button>
                </div>
            </div>
        </div>
    );
};

// ── Main Workspace ──────────────────────────────────────────────
const AnnotationWorkspace = ({ project, onProjectUpdated }) => {
    const [images, setImages] = useState([]);
    const [annotations, setAnnotations] = useState([]);
    const [currentImage, setCurrentImage] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [newAnnotation, setNewAnnotation] = useState(null);
    const [pendingAnnotation, setPendingAnnotation] = useState(null); // bbox waiting for class
    const [error, setError] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null); // 0-100 during upload
    const [uploadFileCount, setUploadFileCount] = useState(0);
    const [isDragOver, setIsDragOver] = useState(false);
    const [statusMsg, setStatusMsg] = useState(null);
    const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
    const [allUsedClasses, setAllUsedClasses] = useState([]); // persists across image switches
    const [showTrainingPanel, setShowTrainingPanel] = useState(false);
    const [showAutoAnnotatePanel, setShowAutoAnnotatePanel] = useState(false);
    const [showMainTrainingPanel, setShowMainTrainingPanel] = useState(false);
    const [showLabelsPanel, setShowLabelsPanel] = useState(false);
    const [showModelsPanel, setShowModelsPanel] = useState(false);
    // Local copy of classes so edits from LabelsPanel are reflected instantly
    const [localClasses, setLocalClasses] = useState(project.classes || []);
    const canvasAreaRef = useRef(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (project) {
            axios.get(`${API_URL}/images/project/${project.id}`)
                .then(res => setImages(res.data))
                .catch(() => setError("Failed to load images."));
        }
    }, [project]);

    const showStatus = (msg) => {
        setStatusMsg(msg);
        setTimeout(() => setStatusMsg(null), 3500);
    };

    const handleImageClick = (image) => {
        setCurrentImage(image);
        setPendingAnnotation(null);
        setNewAnnotation(null);
        axios.get(`${API_URL}/annotations/image/${image.id}`)
            .then(res => {
                setAnnotations(res.data);
                // Merge any classes from this image into the workspace-wide used list
                if (res.data.length > 0) {
                    setAllUsedClasses(prev => {
                        const combined = [...new Set([...prev, ...res.data.map(a => a.class_name)])];
                        return combined;
                    });
                }
            })
            .catch(() => setAnnotations([]));
    };

    // Core upload logic — accepts a plain JS array of File objects
    const uploadFiles = (files) => {
        if (!files.length) return;

        const formData = new FormData();
        for (const file of files) {
            formData.append("files", file);
        }

        setUploading(true);
        setUploadProgress(0);
        setUploadFileCount(files.length);

        // Do NOT set Content-Type — axios detects FormData and lets the
        // browser attach the correct multipart boundary automatically.
        axios.post(`${API_URL}/images/upload/${project.id}`, formData, {
            onUploadProgress: (evt) => {
                if (evt.total) {
                    setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
                }
            },
        })
            .then(res => {
                setImages(prev => [...prev, ...res.data]);
                showStatus(`✓ ${res.data.length} image${res.data.length !== 1 ? 's' : ''} uploaded`);
            })
            .catch((err) => {
                const detail = err.response?.data?.detail;
                setError(detail ? String(detail) : "Upload failed. Please try again.");
            })
            .finally(() => {
                setUploading(false);
                setUploadProgress(null);
                setUploadFileCount(0);
                // Reset input AFTER request completes so File objects stay readable
                if (fileInputRef.current) fileInputRef.current.value = '';
            });
    };

    // File input onChange
    const handleFileUpload = (e) => {
        const selected = Array.from(e.target.files || []);
        // Don't clear input value here — do it in .finally() above
        uploadFiles(selected);
    };

    // Drag & drop handlers on the image list
    const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
    const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); };
    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        if (uploading) return;
        const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (dropped.length) uploadFiles(dropped);
    };

    const handleMouseDown = (e) => {
        if (pendingAnnotation) return; // class picker is open
        const pos = e.target.getStage().getPointerPosition();
        const x = pos.x / scale;
        const y = pos.y / scale;
        setIsDrawing(true);
        setNewAnnotation({ x, y, width: 0, height: 0 });
    };

    const handleMouseMove = (e) => {
        if (!isDrawing) return;
        const pos = e.target.getStage().getPointerPosition();
        const x = pos.x / scale;
        const y = pos.y / scale;
        setNewAnnotation(prev => ({
            ...prev,
            width: x - prev.x,
            height: y - prev.y,
        }));
    };

    const handleMouseUp = () => {
        setIsDrawing(false);
        if (!newAnnotation || Math.abs(newAnnotation.width) < 5 || Math.abs(newAnnotation.height) < 5) {
            setNewAnnotation(null);
            return;
        }
        // Normalise so x/y is always top-left
        const x = newAnnotation.width < 0 ? newAnnotation.x + newAnnotation.width : newAnnotation.x;
        const y = newAnnotation.height < 0 ? newAnnotation.y + newAnnotation.height : newAnnotation.y;
        const w = Math.abs(newAnnotation.width);
        const h = Math.abs(newAnnotation.height);
        setPendingAnnotation({ x, y, width: w, height: h });
    };

    const handleClassConfirm = (className) => {
        const ann = pendingAnnotation;
        setPendingAnnotation(null);
        setNewAnnotation(null);
        const bbox = [
            (ann.x + ann.width / 2) / currentImage.width,
            (ann.y + ann.height / 2) / currentImage.height,
            ann.width / currentImage.width,
            ann.height / currentImage.height,
        ];
        axios.post(`${API_URL}/annotations`, {
            image_id: currentImage.id,
            class_name: className,
            bbox,
        })
            .then(res => {
                setAnnotations(prev => [...prev, res.data]);
                // Update status in sidebar without a network round-trip
                setImages(prev => prev.map(img =>
                    img.id === currentImage.id ? { ...img, status: 'annotated' } : img
                ));
                // Persist class name across image switches
                setAllUsedClasses(prev =>
                    prev.includes(className) ? prev : [...prev, className]
                );
                showStatus(`Annotation added: ${className}`);
            })
            .catch(() => setError("Failed to save annotation."));
    };

    const handleClassCancel = () => {
        setPendingAnnotation(null);
        setNewAnnotation(null);
    };

    // startSeedTraining replaced by TrainingPanel

    const startAutoAnnotation = () => setShowAutoAnnotatePanel(true);

    // Measure canvas area on mount and resize
    useEffect(() => {
        const measure = () => {
            if (canvasAreaRef.current) {
                const w = canvasAreaRef.current.clientWidth - 48;
                const h = canvasAreaRef.current.clientHeight - 96;
                setCanvasSize({ w: Math.max(w, 300), h: Math.max(h, 300) });
            }
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    // Fit image inside available canvas area, preserving aspect ratio
    const scale = currentImage
        ? Math.min(1, canvasSize.w / currentImage.width, canvasSize.h / currentImage.height)
        : 1;
    const stageW = currentImage ? Math.round(currentImage.width * scale) : canvasSize.w;
    const stageH = currentImage ? Math.round(currentImage.height * scale) : canvasSize.h;

    // The box to draw while mouse is held or while picker is open
    const drawnBox = pendingAnnotation || newAnnotation;

    return (
        <div className="workspace">
            {/* ── Sidebar ── */}
            <aside className="workspace-sidebar">
                <div className="sidebar-section sidebar-actions">
                    <p className="sidebar-label">Pipeline</p>
                    <button className="btn-action" onClick={() => setShowTrainingPanel(true)}>
                        🚀 Train Seed Model
                    </button>
                    <button className="btn-action btn-action-secondary" onClick={startAutoAnnotation}>
                        ✨ Auto-Annotate
                    </button>
                    <button className="btn-action btn-action-main" onClick={() => setShowMainTrainingPanel(true)}>
                        🎯 Train Main Model
                    </button>
                    <button className="btn-action btn-action-labels" onClick={() => setShowLabelsPanel(true)}>
                        🏷️ Edit Labels
                    </button>
                    <button className="btn-action btn-action-models" onClick={() => setShowModelsPanel(true)}>
                        📦 View Models
                    </button>
                </div>

                <div className="sidebar-section">
                    <p className="sidebar-label">Images ({images.length})</p>
                    <label className={`upload-btn ${uploading ? 'uploading' : ''}`}>
                        {uploading
                            ? `Uploading ${uploadFileCount} file${uploadFileCount !== 1 ? 's' : ''}…`
                            : '+ Upload Images'}
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="image/*"
                            style={{ display: 'none' }}
                            onChange={handleFileUpload}
                            disabled={uploading}
                        />
                    </label>

                    {/* Progress bar — visible only while uploading */}
                    {uploading && (
                        <div className="upload-progress-wrap">
                            <div className="upload-progress-bar">
                                <div
                                    className="upload-progress-fill"
                                    style={{ width: `${uploadProgress ?? 0}%` }}
                                />
                            </div>
                            <span className="upload-progress-pct">
                                {uploadProgress ?? 0}%
                            </span>
                        </div>
                    )}
                </div>

                {/* Image list — also the drag & drop target */}
                <div
                    className={`image-list ${isDragOver ? 'drag-over' : ''}`}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    {images.length === 0 ? (
                        <div className="sidebar-empty-drop">
                            <p className="sidebar-empty">No images yet.</p>
                            <p className="drop-hint">↑ Upload or drop images here</p>
                        </div>
                    ) : (
                        <>
                            {images.map(img => (
                                <div
                                    key={img.id}
                                    className={`image-item ${currentImage?.id === img.id ? 'active' : ''}`}
                                    onClick={() => handleImageClick(img)}
                                >
                                    <span className="image-item-dot"></span>
                                    <span className="image-item-name">{img.filename}</span>
                                    <span className={`image-item-status status-${img.status}`}>
                                        {img.status}
                                    </span>
                                </div>
                            ))}
                            {/* Drop overlay shown on top of the list while dragging */}
                            {isDragOver && (
                                <div className="drop-overlay">
                                    <span className="drop-overlay-icon">⬆</span>
                                    <span>Drop to add images</span>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </aside>

            {/* ── Canvas Area ── */}
            <div className="workspace-canvas-area" ref={canvasAreaRef}>
                {error && (
                    <div className="error-banner">
                        <span className="error-icon">⚠</span>
                        {error}
                        <button className="error-dismiss" onClick={() => setError(null)}>✕</button>
                    </div>
                )}

                {statusMsg && <div className="status-toast">{statusMsg}</div>}

                {currentImage ? (
                    <div className="canvas-wrapper">
                        <div className="canvas-toolbar">
                            <span className="canvas-filename">{currentImage.filename}</span>
                            <span className="canvas-dims">{currentImage.width} × {currentImage.height}px</span>
                            <span className="canvas-hint">Draw a box to annotate</span>
                            <span className="canvas-ann-count">
                                {annotations.length} annotation{annotations.length !== 1 ? 's' : ''}
                            </span>
                        </div>

                        <div className="canvas-center">
                            <Stage
                                className="canvas-stage"
                                width={stageW}
                                height={stageH}
                                scaleX={scale}
                                scaleY={scale}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                            >
                                <Layer>
                                    <KonvaImage
                                        src={`${API_URL.replace("/api/v1", "")}${currentImage.filepath}`}
                                    />
                                    {annotations.map(ann => {
                                        const bx = (ann.bbox[0] - ann.bbox[2] / 2) * currentImage.width;
                                        const by = (ann.bbox[1] - ann.bbox[3] / 2) * currentImage.height;
                                        const bw = ann.bbox[2] * currentImage.width;
                                        const bh = ann.bbox[3] * currentImage.height;
                                        // manual = rose red, auto = violet
                                        const color = ann.source === 'auto' ? '#a78bfa' : '#f43f5e';
                                        const fontSize = Math.max(10, 13 / scale);
                                        const padX = 4 / scale;
                                        const padY = 2 / scale;
                                        const labelH = fontSize + padY * 2;
                                        return (
                                            <React.Fragment key={ann.id}>
                                                <Rect
                                                    x={bx} y={by} width={bw} height={bh}
                                                    stroke={color}
                                                    strokeWidth={1.5 / scale}
                                                    fill={ann.source === 'auto'
                                                        ? 'rgba(167,139,250,0.07)'
                                                        : 'rgba(244,63,94,0.07)'}
                                                />
                                                {/* Label background */}
                                                <Rect
                                                    x={bx} y={by - labelH}
                                                    width={Math.min(bw, (ann.class_name.length * fontSize * 0.6) + padX * 2 + (ann.source === 'auto' ? 30/scale : 0))}
                                                    height={labelH}
                                                    fill={color}
                                                    cornerRadius={2 / scale}
                                                />
                                                <Text
                                                    x={bx + padX}
                                                    y={by - labelH + padY}
                                                    text={`${ann.class_name}${ann.source === 'auto' ? ' ✦' : ''}`}
                                                    fontSize={fontSize}
                                                    fontFamily="sans-serif"
                                                    fill="#fff"
                                                    fontStyle="bold"
                                                />
                                            </React.Fragment>
                                        );
                                    })}
                                    {drawnBox && (
                                        <Rect
                                            x={drawnBox.x}
                                            y={drawnBox.y}
                                            width={drawnBox.width}
                                            height={drawnBox.height}
                                            stroke="#6366f1"
                                            strokeWidth={2 / scale}
                                            dash={[6 / scale, 3 / scale]}
                                            fill="rgba(99,102,241,0.08)"
                                        />
                                    )}
                                </Layer>
                            </Stage>

                            {/* Class picker floats over the canvas */}
                            {pendingAnnotation && (
                                <ClassPicker
                                    classes={localClasses}
                                    usedClasses={allUsedClasses}
                                    onConfirm={handleClassConfirm}
                                    onCancel={handleClassCancel}
                                />
                            )}
                        </div>

                        {annotations.length > 0 && (
                            <div className="annotations-list">
                                <p className="sidebar-label" style={{ marginBottom: 8 }}>Annotations</p>
                                {annotations.map(ann => (
                                    <div key={ann.id} className="annotation-row">
                                        <span className="annotation-dot"></span>
                                        <span className="annotation-class">{ann.class_name}</span>
                                        <span className={`annotation-source source-${ann.source}`}>
                                            {ann.source}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="canvas-placeholder">
                        <div className="placeholder-icon">🖼️</div>
                        <h3>Select an image</h3>
                        <p>Choose an image from the sidebar to start annotating.</p>
                    </div>
                )}
            </div>
            {showTrainingPanel && (
                <TrainingPanel
                    project={project}
                    onClose={() => setShowTrainingPanel(false)}
                />
            )}
            {showAutoAnnotatePanel && (
                <AutoAnnotatePanel
                    project={project}
                    onClose={() => setShowAutoAnnotatePanel(false)}
                    onAnnotationsUpdated={() => {
                        // Refresh image list so status changes are reflected
                        axios.get(`${API_URL}/images/project/${project.id}`)
                            .then(res => setImages(res.data))
                            .catch(() => {});
                    }}
                />
            )}
            {showMainTrainingPanel && (
                <MainTrainingPanel
                    project={project}
                    onClose={() => setShowMainTrainingPanel(false)}
                />
            )}
            {showLabelsPanel && (
                <LabelsPanel
                    project={{ ...project, classes: localClasses }}
                    onClose={() => setShowLabelsPanel(false)}
                    onLabelsUpdated={(updatedClasses) => {
                        setLocalClasses(updatedClasses);
                        // Remove any used-class entries that were deleted or renamed
                        setAllUsedClasses(prev =>
                            prev.filter(c => updatedClasses.includes(c))
                        );
                        // Propagate to parent (App.js) so project card stays in sync
                        if (onProjectUpdated) {
                            onProjectUpdated({ ...project, classes: updatedClasses });
                        }
                    }}
                />
            )}
            {showModelsPanel && (
                <ModelsPanel
                    project={project}
                    onClose={() => setShowModelsPanel(false)}
                    onGoToTrain={(type) => {
                        if (type === 'seed') setShowTrainingPanel(true);
                        else setShowMainTrainingPanel(true);
                    }}
                />
            )}
        </div>
    );
};

export default AnnotationWorkspace;
