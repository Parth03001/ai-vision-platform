import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './VideoPanel.css';

const API_URL = "http://localhost:8000/api/v1";
const POLL_INTERVAL = 2500;

function formatDuration(seconds) {
    if (!seconds) return null;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
}

function formatSize(bytes) {
    if (!bytes) return null;
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
    const [videos, setVideos]                 = useState([]);
    const [loading, setLoading]               = useState(true);
    const [uploading, setUploading]           = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [error, setError]                   = useState(null);
    const [successMsg, setSuccessMsg]         = useState(null);
    const [extractConfig, setExtractConfig]   = useState({});

    const pollingRef  = useRef({});
    const fileInputRef = useRef(null);

    // ── Load videos ────────────────────────────────────────────────
    const fetchVideos = useCallback(async () => {
        try {
            const res = await axios.get(`${API_URL}/videos/project/${project.id}`);
            setVideos(res.data);
        } catch { /* silently ignore */ }
    }, [project.id]);

    useEffect(() => {
        setLoading(true);
        fetchVideos().finally(() => setLoading(false));
    }, [fetchVideos]);

    // ── Poll extracting videos ─────────────────────────────────────
    useEffect(() => {
        const extractingIds = videos.filter(v => v.status === 'extracting').map(v => v.id);

        extractingIds.forEach(id => {
            if (pollingRef.current[id]) return;
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

        Object.keys(pollingRef.current).forEach(id => {
            if (!extractingIds.includes(id)) {
                clearInterval(pollingRef.current[id]);
                delete pollingRef.current[id];
            }
        });
    }, [videos, onFramesExtracted]);

    useEffect(() => () => Object.values(pollingRef.current).forEach(clearInterval), []);

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
                        if (e.total) setUploadProgress(Math.round((e.loaded / e.total) * 100));
                    },
                }
            );
            setVideos(prev => [res.data, ...prev]);
            showSuccess('Video uploaded! Configure frame extraction below.');
        } catch (err) {
            setError(err.response?.data?.detail || 'Upload failed.');
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
            showSuccess('Frame extraction started — images will appear in the sidebar shortly.');
        } catch (err) {
            setError(err.response?.data?.detail || 'Failed to start extraction.');
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

    const showSuccess = (msg) => {
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(null), 4000);
    };

    const updateConfig = (videoId, key, value) =>
        setExtractConfig(prev => ({ ...prev, [videoId]: { ...(prev[videoId] || {}), [key]: value } }));

    // ── Render ─────────────────────────────────────────────────────
    return (
        <div className="vp-overlay" onClick={onClose}>
            <div className="vp-modal" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="vp-header">
                    <div className="vp-header-left">
                        <span className="vp-header-icon">🎬</span>
                        <div>
                            <h2 className="vp-title">Video Import</h2>
                            <p className="vp-subtitle">Upload videos → extract frames → annotate &amp; train</p>
                        </div>
                    </div>
                    <button className="vp-close" onClick={onClose}>✕</button>
                </div>

                {/* How it works */}
                <div className="vp-howto">
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">1</span>
                        <span>Upload a video (MP4, AVI, MOV, MKV…)</span>
                    </div>
                    <span className="vp-howto-arrow">→</span>
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">2</span>
                        <span>Set sampling rate &amp; extract frames</span>
                    </div>
                    <span className="vp-howto-arrow">→</span>
                    <div className="vp-howto-step">
                        <span className="vp-howto-num">3</span>
                        <span>Frames appear in the image list — annotate &amp; train!</span>
                    </div>
                </div>

                {/* Scrollable body */}
                <div className="vp-body">
                    {/* Toasts */}
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
                            accept="video/mp4,video/avi,video/quicktime,video/x-matroska,video/webm,.mp4,.avi,.mov,.mkv,.webm,.m4v,.flv"
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
                                                    {formatDuration(video.duration) && <span>{formatDuration(video.duration)}</span>}
                                                    {video.fps && <span>{video.fps.toFixed(1)} fps</span>}
                                                    {video.width && video.height && <span>{video.width}×{video.height}</span>}
                                                    {formatSize(video.file_size) && <span>{formatSize(video.file_size)}</span>}
                                                </div>
                                            </div>
                                            <div className="vp-card-actions">
                                                <StatusBadge status={video.status} />
                                                <button
                                                    className="vp-btn-delete"
                                                    onClick={() => handleDelete(video.id)}
                                                    title="Delete video and extracted frames"
                                                    disabled={isExtracting}
                                                >🗑</button>
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

                                        {/* Extraction controls */}
                                        {!isExtracting && (
                                            <div className="vp-extract-controls">
                                                <div className="vp-extract-field">
                                                    <label className="vp-extract-label">
                                                        Sample every N frames
                                                        <span className="vp-extract-hint">e.g. 30 = ~1 fps at 30fps</span>
                                                    </label>
                                                    <input
                                                        type="number"
                                                        className="vp-extract-input"
                                                        min="1" max="3000"
                                                        value={cfg.sampleEveryN ?? 30}
                                                        onChange={e => updateConfig(video.id, 'sampleEveryN', e.target.value)}
                                                    />
                                                </div>
                                                <div className="vp-extract-field">
                                                    <label className="vp-extract-label">
                                                        Max frames
                                                        <span className="vp-extract-hint">0 = no limit</span>
                                                    </label>
                                                    <input
                                                        type="number"
                                                        className="vp-extract-input"
                                                        min="0" max="10000"
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
            </div>
        </div>
    );
}
