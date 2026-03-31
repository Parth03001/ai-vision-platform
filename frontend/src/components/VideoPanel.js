import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

const API_URL = "http://localhost:8000/api/v1";

// How often to poll for extraction progress (ms)
const POLL_INTERVAL = 2500;

function formatDuration(seconds) {
    if (!seconds) return '—';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
}

function formatSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }) {
    const map = {
        uploaded:   { label: 'Uploaded',    cls: 'vp-badge vp-badge--uploaded' },
        extracting: { label: 'Extracting…', cls: 'vp-badge vp-badge--extracting' },
        done:       { label: 'Done',         cls: 'vp-badge vp-badge--done' },
        failed:     { label: 'Failed',       cls: 'vp-badge vp-badge--failed' },
    };
    const { label, cls } = map[status] || { label: status, cls: 'vp-badge' };
    return <span className={cls}>{label}</span>;
}

export default function VideoPanel({ project, onClose, onFramesExtracted }) {
    const [videos, setVideos]               = useState([]);
    const [loading, setLoading]             = useState(true);
    const [uploading, setUploading]         = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [error, setError]                 = useState(null);
    const [successMsg, setSuccessMsg]       = useState(null);

    // Per-video extraction config  { [videoId]: { sampleEveryN, maxFrames } }
    const [extractConfig, setExtractConfig] = useState({});

    // IDs of videos currently being polled
    const pollingRef = useRef({});

    const fileInputRef = useRef(null);

    // ── Load videos ────────────────────────────────────────────────
    const fetchVideos = useCallback(async () => {
        try {
            const res = await axios.get(`${API_URL}/videos/project/${project.id}`);
            setVideos(res.data);
        } catch {
            // silently ignore — error shown on initial load only
        }
    }, [project.id]);

    useEffect(() => {
        setLoading(true);
        fetchVideos().finally(() => setLoading(false));
    }, [fetchVideos]);

    // ── Poll extracting videos ─────────────────────────────────────
    useEffect(() => {
        const extractingIds = videos
            .filter(v => v.status === 'extracting')
            .map(v => v.id);

        // Start polling for new extracting videos
        extractingIds.forEach(id => {
            if (pollingRef.current[id]) return; // already polling

            pollingRef.current[id] = setInterval(async () => {
                try {
                    const res = await axios.get(`${API_URL}/videos/${id}`);
                    const updated = res.data;
                    setVideos(prev => prev.map(v => v.id === id ? updated : v));

                    if (updated.status !== 'extracting') {
                        clearInterval(pollingRef.current[id]);
                        delete pollingRef.current[id];
                        if (updated.status === 'done' && onFramesExtracted) {
                            onFramesExtracted(updated.frames_extracted);
                        }
                    }
                } catch {
                    clearInterval(pollingRef.current[id]);
                    delete pollingRef.current[id];
                }
            }, POLL_INTERVAL);
        });

        // Clear stale intervals for videos no longer extracting
        Object.keys(pollingRef.current).forEach(id => {
            if (!extractingIds.includes(id)) {
                clearInterval(pollingRef.current[id]);
                delete pollingRef.current[id];
            }
        });
    }, [videos, onFramesExtracted]);

    // Cleanup all intervals on unmount
    useEffect(() => {
        return () => {
            Object.values(pollingRef.current).forEach(clearInterval);
        };
    }, []);

    // ── Upload ─────────────────────────────────────────────────────
    const handleFileChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';

        setUploading(true);
        setUploadProgress(0);
        setError(null);

        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await axios.post(
                `${API_URL}/videos/upload/${project.id}`,
                formData,
                {
                    headers: { 'Content-Type': 'multipart/form-data' },
                    onUploadProgress: (e) => {
                        if (e.total) {
                            setUploadProgress(Math.round((e.loaded / e.total) * 100));
                        }
                    },
                }
            );
            setVideos(prev => [res.data, ...prev]);
            showSuccess('Video uploaded! Configure frame extraction below.');
        } catch (err) {
            const msg = err.response?.data?.detail || 'Upload failed.';
            setError(msg);
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    // ── Extract frames ─────────────────────────────────────────────
    const handleExtract = async (video) => {
        const cfg = extractConfig[video.id] || {};
        const sampleEveryN = Math.max(1, parseInt(cfg.sampleEveryN ?? 30, 10));
        const maxFrames    = Math.max(0, parseInt(cfg.maxFrames    ?? 300, 10));

        setError(null);
        try {
            const res = await axios.post(
                `${API_URL}/videos/${video.id}/extract-frames`,
                { sample_every_n: sampleEveryN, max_frames: maxFrames }
            );
            setVideos(prev => prev.map(v => v.id === video.id ? res.data : v));
            showSuccess('Frame extraction started! Images will appear in the sidebar.');
        } catch (err) {
            const msg = err.response?.data?.detail || 'Failed to start extraction.';
            setError(msg);
        }
    };

    // ── Delete video ───────────────────────────────────────────────
    const handleDelete = async (videoId) => {
        if (!window.confirm('Delete this video and all its extracted frames?')) return;
        try {
            await axios.delete(`${API_URL}/videos/${videoId}`);
            setVideos(prev => prev.filter(v => v.id !== videoId));
            showSuccess('Video and extracted frames deleted.');
            if (onFramesExtracted) onFramesExtracted(0);
        } catch {
            setError('Failed to delete video.');
        }
    };

    // ── Helpers ────────────────────────────────────────────────────
    const showSuccess = (msg) => {
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(null), 4000);
    };

    const updateConfig = (videoId, key, value) => {
        setExtractConfig(prev => ({
            ...prev,
            [videoId]: { ...(prev[videoId] || {}), [key]: value },
        }));
    };

    // ── Render ─────────────────────────────────────────────────────
    return (
        <div className="panel-overlay" onClick={onClose}>
            <div className="panel-modal vp-modal" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="panel-header">
                    <div className="panel-header-left">
                        <span className="panel-icon">🎬</span>
                        <div>
                            <h2 className="panel-title">Video Import</h2>
                            <p className="panel-subtitle">
                                Upload videos → extract frames → annotate & train
                            </p>
                        </div>
                    </div>
                    <button className="panel-close" onClick={onClose}>✕</button>
                </div>

                {/* How it works */}
                <div className="vp-howto">
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">1</span>
                        <span>Upload a video file (MP4, AVI, MOV, MKV…)</span>
                    </div>
                    <span className="vp-howto-arrow">→</span>
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">2</span>
                        <span>Set frame sampling rate &amp; extract</span>
                    </div>
                    <span className="vp-howto-arrow">→</span>
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">3</span>
                        <span>Frames appear in image list — annotate &amp; train!</span>
                    </div>
                </div>

                {/* Toast messages */}
                {error && (
                    <div className="vp-error">
                        <span>⚠ {error}</span>
                        <button onClick={() => setError(null)}>✕</button>
                    </div>
                )}
                {successMsg && <div className="vp-success">✓ {successMsg}</div>}

                {/* Upload zone */}
                <div className="vp-upload-zone" onClick={() => !uploading && fileInputRef.current?.click()}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/mp4,video/avi,video/quicktime,video/x-matroska,video/webm,video/x-m4v,.mp4,.avi,.mov,.mkv,.webm,.m4v,.flv"
                        style={{ display: 'none' }}
                        onChange={handleFileChange}
                        disabled={uploading}
                    />
                    {uploading ? (
                        <div className="vp-uploading">
                            <div className="vp-progress-bar">
                                <div className="vp-progress-fill" style={{ width: `${uploadProgress}%` }} />
                            </div>
                            <span className="vp-upload-pct">{uploadProgress}% uploading…</span>
                        </div>
                    ) : (
                        <>
                            <span className="vp-upload-icon">📹</span>
                            <span className="vp-upload-label">Click to upload a video</span>
                            <span className="vp-upload-hint">MP4 · AVI · MOV · MKV · WebM</span>
                        </>
                    )}
                </div>

                {/* Video list */}
                <div className="vp-list">
                    {loading ? (
                        <div className="vp-list-empty">Loading…</div>
                    ) : videos.length === 0 ? (
                        <div className="vp-list-empty">No videos uploaded yet.</div>
                    ) : (
                        videos.map(video => {
                            const cfg = extractConfig[video.id] || {};
                            const isExtracting = video.status === 'extracting';
                            const isDone       = video.status === 'done';

                            return (
                                <div key={video.id} className="vp-card">
                                    {/* Card header */}
                                    <div className="vp-card-header">
                                        <div className="vp-card-info">
                                            <span className="vp-card-name" title={video.original_filename}>
                                                {video.original_filename}
                                            </span>
                                            <div className="vp-card-meta">
                                                {video.duration && (
                                                    <span>{formatDuration(video.duration)}</span>
                                                )}
                                                {video.fps && (
                                                    <span>{video.fps.toFixed(1)} fps</span>
                                                )}
                                                {video.width && video.height && (
                                                    <span>{video.width}×{video.height}</span>
                                                )}
                                                <span>{formatSize(video.file_size)}</span>
                                            </div>
                                        </div>
                                        <div className="vp-card-actions">
                                            <StatusBadge status={video.status} />
                                            <button
                                                className="vp-btn-delete"
                                                onClick={() => handleDelete(video.id)}
                                                title="Delete video and frames"
                                                disabled={isExtracting}
                                            >
                                                🗑
                                            </button>
                                        </div>
                                    </div>

                                    {/* Extraction progress bar */}
                                    {isExtracting && (
                                        <div className="vp-extraction-progress">
                                            <div className="vp-extraction-bar">
                                                <div className="vp-extraction-fill vp-extraction-fill--animated" />
                                            </div>
                                            <span className="vp-extraction-label">
                                                {video.frames_extracted > 0
                                                    ? `${video.frames_extracted} frames extracted so far…`
                                                    : 'Starting extraction…'}
                                            </span>
                                        </div>
                                    )}

                                    {/* Done summary */}
                                    {isDone && (
                                        <div className="vp-done-summary">
                                            ✓ {video.frames_extracted} frames extracted and added to the image list
                                        </div>
                                    )}

                                    {/* Extraction controls (shown for uploaded/done/failed) */}
                                    {!isExtracting && (
                                        <div className="vp-extract-controls">
                                            <div className="vp-extract-field">
                                                <label className="vp-extract-label">
                                                    Sample every N frames
                                                    <span className="vp-extract-hint">
                                                        (e.g. 30 = ~1 frame/sec at 30fps)
                                                    </span>
                                                </label>
                                                <input
                                                    type="number"
                                                    className="vp-extract-input"
                                                    min="1"
                                                    max="3000"
                                                    value={cfg.sampleEveryN ?? 30}
                                                    onChange={e => updateConfig(video.id, 'sampleEveryN', e.target.value)}
                                                />
                                            </div>
                                            <div className="vp-extract-field">
                                                <label className="vp-extract-label">
                                                    Max frames
                                                    <span className="vp-extract-hint">(0 = no limit)</span>
                                                </label>
                                                <input
                                                    type="number"
                                                    className="vp-extract-input"
                                                    min="0"
                                                    max="10000"
                                                    value={cfg.maxFrames ?? 300}
                                                    onChange={e => updateConfig(video.id, 'maxFrames', e.target.value)}
                                                />
                                            </div>
                                            <button
                                                className="vp-btn-extract"
                                                onClick={() => handleExtract(video)}
                                            >
                                                {isDone ? '↺ Re-extract Frames' : '▶ Extract Frames'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <style>{`
                .vp-modal {
                    width: 680px;
                    max-width: 96vw;
                    max-height: 88vh;
                    display: flex;
                    flex-direction: column;
                }

                /* How-it-works strip */
                .vp-howto {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: #1e1e2e;
                    border: 1px solid #2a2a3e;
                    border-radius: 8px;
                    padding: 12px 16px;
                    margin: 0 24px 16px;
                    font-size: 12px;
                    color: #a1a1b5;
                    flex-shrink: 0;
                }
                .vp-howto-step {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .vp-howto-num {
                    background: #6366f1;
                    color: #fff;
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    font-size: 11px;
                    flex-shrink: 0;
                }
                .vp-howto-arrow { color: #4b4b6a; font-size: 14px; flex-shrink: 0; }

                /* Error / success toasts */
                .vp-error {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background: #2d1515;
                    border: 1px solid #7f1d1d;
                    border-radius: 6px;
                    padding: 10px 14px;
                    margin: 0 24px 12px;
                    color: #fca5a5;
                    font-size: 13px;
                    flex-shrink: 0;
                }
                .vp-error button {
                    background: none;
                    border: none;
                    color: #fca5a5;
                    cursor: pointer;
                    padding: 0;
                }
                .vp-success {
                    background: #0d2d1a;
                    border: 1px solid #166534;
                    border-radius: 6px;
                    padding: 10px 14px;
                    margin: 0 24px 12px;
                    color: #86efac;
                    font-size: 13px;
                    flex-shrink: 0;
                }

                /* Upload zone */
                .vp-upload-zone {
                    margin: 0 24px 16px;
                    border: 2px dashed #3a3a5c;
                    border-radius: 10px;
                    padding: 24px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    transition: border-color 0.2s, background 0.2s;
                    flex-shrink: 0;
                }
                .vp-upload-zone:hover {
                    border-color: #6366f1;
                    background: #1a1a2e;
                }
                .vp-upload-icon { font-size: 32px; }
                .vp-upload-label { font-size: 14px; color: #d1d1e9; font-weight: 500; }
                .vp-upload-hint  { font-size: 12px; color: #6b6b8a; }

                /* Upload progress */
                .vp-uploading {
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                }
                .vp-progress-bar {
                    width: 100%;
                    height: 6px;
                    background: #2a2a3e;
                    border-radius: 4px;
                    overflow: hidden;
                }
                .vp-progress-fill {
                    height: 100%;
                    background: #6366f1;
                    border-radius: 4px;
                    transition: width 0.2s;
                }
                .vp-upload-pct { font-size: 12px; color: #a1a1b5; }

                /* Video list */
                .vp-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0 24px 24px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .vp-list-empty {
                    text-align: center;
                    color: #6b6b8a;
                    font-size: 13px;
                    padding: 32px 0;
                }

                /* Video card */
                .vp-card {
                    background: #1a1a2e;
                    border: 1px solid #2a2a3e;
                    border-radius: 10px;
                    padding: 14px 16px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .vp-card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 12px;
                }
                .vp-card-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
                .vp-card-name {
                    font-size: 14px;
                    font-weight: 600;
                    color: #e2e2f0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 380px;
                }
                .vp-card-meta {
                    display: flex;
                    gap: 10px;
                    font-size: 12px;
                    color: #6b6b8a;
                }
                .vp-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

                /* Status badges */
                .vp-badge {
                    font-size: 11px;
                    font-weight: 600;
                    padding: 3px 9px;
                    border-radius: 12px;
                    white-space: nowrap;
                }
                .vp-badge--uploaded   { background: #1e2d4a; color: #93c5fd; border: 1px solid #1d4ed8; }
                .vp-badge--extracting { background: #2d2217; color: #fcd34d; border: 1px solid #b45309; }
                .vp-badge--done       { background: #0d2d1a; color: #86efac; border: 1px solid #166534; }
                .vp-badge--failed     { background: #2d1515; color: #fca5a5; border: 1px solid #7f1d1d; }

                /* Delete button */
                .vp-btn-delete {
                    background: none;
                    border: 1px solid #3a3a5c;
                    border-radius: 6px;
                    color: #6b6b8a;
                    cursor: pointer;
                    padding: 4px 8px;
                    font-size: 14px;
                    transition: background 0.15s, color 0.15s, border-color 0.15s;
                }
                .vp-btn-delete:hover:not(:disabled) {
                    background: #2d1515;
                    color: #fca5a5;
                    border-color: #7f1d1d;
                }
                .vp-btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }

                /* Extraction progress */
                .vp-extraction-progress {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .vp-extraction-bar {
                    height: 4px;
                    background: #2a2a3e;
                    border-radius: 4px;
                    overflow: hidden;
                }
                .vp-extraction-fill {
                    height: 100%;
                    background: #f59e0b;
                    border-radius: 4px;
                }
                .vp-extraction-fill--animated {
                    width: 40%;
                    animation: vpSlide 1.4s ease-in-out infinite;
                }
                @keyframes vpSlide {
                    0%   { transform: translateX(-100%); }
                    100% { transform: translateX(300%); }
                }
                .vp-extraction-label { font-size: 12px; color: #fcd34d; }

                /* Done summary */
                .vp-done-summary {
                    font-size: 12px;
                    color: #86efac;
                    background: #0a1f10;
                    border: 1px solid #14532d;
                    border-radius: 6px;
                    padding: 8px 12px;
                }

                /* Extraction controls */
                .vp-extract-controls {
                    display: flex;
                    align-items: flex-end;
                    gap: 12px;
                    flex-wrap: wrap;
                }
                .vp-extract-field { display: flex; flex-direction: column; gap: 4px; }
                .vp-extract-label {
                    font-size: 11px;
                    color: #8b8baa;
                    display: flex;
                    flex-direction: column;
                    gap: 1px;
                }
                .vp-extract-hint { font-size: 10px; color: #4b4b6a; }
                .vp-extract-input {
                    width: 90px;
                    background: #12121e;
                    border: 1px solid #2a2a3e;
                    border-radius: 6px;
                    color: #e2e2f0;
                    font-size: 13px;
                    padding: 6px 8px;
                    outline: none;
                }
                .vp-extract-input:focus { border-color: #6366f1; }

                .vp-btn-extract {
                    background: #6366f1;
                    border: none;
                    border-radius: 7px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 600;
                    padding: 8px 16px;
                    white-space: nowrap;
                    transition: background 0.15s;
                    align-self: flex-end;
                }
                .vp-btn-extract:hover { background: #4f52d6; }
            `}</style>
        </div>
    );
}
