import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './ModelsPanel.css';

const API_URL = 'http://localhost:8000/api/v1';

/* ─────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────── */

/** Extract best mAP50 from epoch history */
function bestMetric(history, key) {
    if (!history?.length) return null;
    const vals = history
        .map(h => h[key] ?? h[`${key}(B)`] ?? null)
        .filter(v => v != null && v > 0);
    if (!vals.length) return null;
    return Math.max(...vals);
}

/** Format a number as a percentage string */
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** Human-readable file size */
const fmtSize = (mb) => {
    if (mb == null) return '—';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb} MB`;
};

/** Format date string */
const fmtDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
};

/** Friendly model name from filename */
const friendlyModel = (name) => {
    if (!name) return '—';
    return name.replace('.pt', '').replace('yolo', 'YOLO').replace(/(\d+)/, '$1 ');
};

/** mAP quality color */
const mapColor = (val) => {
    if (val == null) return '#3d4f6a';
    if (val >= 0.7) return '#4ade80';
    if (val >= 0.4) return '#facc15';
    return '#f87171';
};

/* ─────────────────────────────────────────────────────────────────
   SVG Sparkline
   ───────────────────────────────────────────────────────────────── */
function Sparkline({ history, color = '#818cf8' }) {
    if (!history?.length) return null;

    const vals = history
        .map(h => h['mAP50'] ?? h['mAP50(B)'] ?? null)
        .filter(v => v != null);
    if (vals.length < 2) return null;

    const W = 180, H = 48;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 0.01;

    const pts = vals.map((v, i) => {
        const x = (i / (vals.length - 1)) * W;
        const y = H - ((v - min) / range) * (H - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    // Filled area
    const area = `0,${H} ` + pts + ` ${W},${H}`;

    return (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mp-sparkline">
            <defs>
                <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <polygon points={area} fill={`url(#sg-${color.replace('#', '')})`} />
            <polyline points={pts} fill="none" stroke={color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Metric Pill
   ───────────────────────────────────────────────────────────────── */
function MetricPill({ label, value, color }) {
    return (
        <div className="mp-metric">
            <span className="mp-metric-val" style={{ color }}>{value}</span>
            <span className="mp-metric-label">{label}</span>
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Model Card
   ───────────────────────────────────────────────────────────────── */
function ModelCard({ type, data, onTrain, onDownload, downloading }) {
    const isSeed = type === 'seed';
    const config = {
        seed: {
            label: 'Seed Model',
            desc: 'Fast annotation model trained on your labeled data',
            icon: '🌱',
            accent: ['#06b6d4', '#3b82f6'],
            light: 'rgba(6,182,212,0.1)',
            sparkColor: '#38bdf8',
            trainLabel: '🚀 Train Seed Model',
        },
        main: {
            label: 'Main Model',
            desc: 'High-accuracy production model for final deployment',
            icon: '🎯',
            accent: ['#6366f1', '#8b5cf6'],
            light: 'rgba(99,102,241,0.1)',
            sparkColor: '#a5b4fc',
            trainLabel: '🎯 Train Main Model',
        },
    }[type];

    const exists  = data?.exists;
    const job     = data?.last_job;
    const meta    = job?.result_meta || {};
    const history = meta?.epochMeta?.history || [];
    const epochs  = meta?.epochMeta?.epoch   || meta?.epochMeta?.total_epochs || null;

    const map50   = bestMetric(history, 'mAP50');
    const map95   = bestMetric(history, 'mAP50-95');

    const gradStyle = {
        background: `linear-gradient(135deg, ${config.accent[0]}, ${config.accent[1]})`,
    };

    return (
        <div className={`mp-card ${exists ? 'mp-card--trained' : 'mp-card--empty'}`}>
            {/* Top bar */}
            <div className="mp-card-bar" style={gradStyle} />

            {/* Header */}
            <div className="mp-card-header">
                <div className="mp-card-icon" style={gradStyle}>{config.icon}</div>
                <div className="mp-card-title-wrap">
                    <h3 className="mp-card-title">{config.label}</h3>
                    <p className="mp-card-desc">{config.desc}</p>
                </div>
                <div className={`mp-card-status ${exists ? 'mp-card-status--ok' : 'mp-card-status--none'}`}>
                    {exists ? '✓ Trained' : '○ Not trained'}
                </div>
            </div>

            {exists ? (
                <>
                    {/* Model tags */}
                    <div className="mp-card-tags">
                        {meta.modelName && (
                            <span className="mp-tag mp-tag--model">
                                🧠 {friendlyModel(meta.modelName)}
                            </span>
                        )}
                        <span className="mp-tag mp-tag--size">
                            💾 {fmtSize(data.file_size_mb)}
                        </span>
                        {epochs && (
                            <span className="mp-tag mp-tag--epoch">
                                📈 {epochs} epochs
                            </span>
                        )}
                        {job?.finished_at && (
                            <span className="mp-tag mp-tag--date">
                                🗓 {fmtDate(job.finished_at)}
                            </span>
                        )}
                    </div>

                    {/* Metrics grid */}
                    <div className="mp-metrics">
                        <MetricPill
                            label="mAP@50"
                            value={pct(map50)}
                            color={mapColor(map50)}
                        />
                        <MetricPill
                            label="mAP@50-95"
                            value={pct(map95)}
                            color={mapColor(map95)}
                        />
                        <MetricPill
                            label="File size"
                            value={fmtSize(data.file_size_mb)}
                            color="#94a3b8"
                        />
                        <MetricPill
                            label="Epochs"
                            value={epochs ?? '—'}
                            color="#94a3b8"
                        />
                    </div>

                    {/* Sparkline chart */}
                    {history.length >= 2 && (
                        <div className="mp-chart-wrap">
                            <span className="mp-chart-label">mAP@50 over training</span>
                            <Sparkline history={history} color={config.sparkColor} />
                            <div className="mp-chart-axis">
                                <span>Epoch 1</span>
                                <span>Epoch {history.length}</span>
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="mp-card-actions">
                        <button
                            className="mp-btn-download"
                            onClick={() => onDownload(type)}
                            disabled={downloading}
                        >
                            {downloading === type
                                ? <><span className="mp-spinner" />Downloading…</>
                                : <>⬇ Download weights</>
                            }
                        </button>
                        <button className="mp-btn-retrain" onClick={() => onTrain(type)}>
                            ↺ Re-train
                        </button>
                    </div>
                </>
            ) : (
                /* Not trained state */
                <div className="mp-card-empty">
                    <div className="mp-card-empty-icon" style={{ color: config.accent[0] }}>
                        {isSeed ? '🌱' : '🎯'}
                    </div>
                    <p className="mp-card-empty-text">
                        No trained model yet.<br />
                        <span>Run a training job to generate this model.</span>
                    </p>
                    <button
                        className="mp-btn-train"
                        style={gradStyle}
                        onClick={() => onTrain(type)}
                    >
                        {config.trainLabel}
                    </button>
                </div>
            )}
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────
   Main Panel
   ───────────────────────────────────────────────────────────────── */
const ModelsPanel = ({ project, onClose, onGoToTrain }) => {
    const [details, setDetails]     = useState(null);
    const [loading, setLoading]     = useState(true);
    const [error, setError]         = useState(null);
    const [downloading, setDownloading] = useState(null); // 'seed' | 'main' | null

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        axios.get(`${API_URL}/pipeline/model-details/${project.id}`)
            .then(res => setDetails(res.data))
            .catch(() => setError('Could not load model details.'))
            .finally(() => setLoading(false));
    }, [project.id]);

    useEffect(() => { load(); }, [load]);

    const handleDownload = async (type) => {
        setDownloading(type);
        try {
            const res = await axios.get(
                `${API_URL}/pipeline/download-model/${project.id}/${type}`,
                { responseType: 'blob' }
            );
            const url  = URL.createObjectURL(new Blob([res.data]));
            const link = document.createElement('a');
            link.href        = url;
            link.download    = `${type}_best.pt`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch {
            setError(`Failed to download ${type} model.`);
        } finally {
            setDownloading(null);
        }
    };

    const handleTrain = (type) => {
        onClose();
        onGoToTrain(type);  // 'seed' | 'main'
    };

    return (
        <div className="mp-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="mp-panel">

                {/* ── Panel header ───────────────────────────── */}
                <div className="mp-header">
                    <div className="mp-header-left">
                        <div className="mp-header-icon">◈</div>
                        <div>
                            <h2 className="mp-header-title">Trained Models</h2>
                            <p className="mp-header-sub">{project.name}</p>
                        </div>
                    </div>
                    <div className="mp-header-actions">
                        <button className="mp-btn-refresh" onClick={load} title="Refresh">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
                                <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/>
                            </svg>
                        </button>
                        <button className="mp-btn-close" onClick={onClose}>✕</button>
                    </div>
                </div>

                {/* ── Body ───────────────────────────────────── */}
                <div className="mp-body">
                    {error && (
                        <div className="mp-error">
                            <span>⚠</span> {error}
                            <button onClick={() => setError(null)}>×</button>
                        </div>
                    )}

                    {loading ? (
                        <div className="mp-loading">
                            <div className="mp-loading-spinner" />
                            <p>Loading model details…</p>
                        </div>
                    ) : details ? (
                        <div className="mp-cards-grid">
                            <ModelCard
                                type="seed"
                                data={details.seed}
                                onTrain={handleTrain}
                                onDownload={handleDownload}
                                downloading={downloading}
                            />
                            <ModelCard
                                type="main"
                                data={details.main}
                                onTrain={handleTrain}
                                onDownload={handleDownload}
                                downloading={downloading}
                            />
                        </div>
                    ) : null}

                    {/* Tips */}
                    {!loading && details && (
                        <div className="mp-tips">
                            <div className="mp-tip">
                                <span className="mp-tip-icon">💡</span>
                                <div>
                                    <strong>Seed model</strong> — used by Auto-Annotate to generate bounding boxes quickly.
                                    Train it first.
                                </div>
                            </div>
                            <div className="mp-tip">
                                <span className="mp-tip-icon">🎯</span>
                                <div>
                                    <strong>Main model</strong> — your final deployment model.
                                    Can fine-tune from seed weights for faster convergence.
                                </div>
                            </div>
                            <div className="mp-tip">
                                <span className="mp-tip-icon">📊</span>
                                <div>
                                    <strong>mAP@50 ≥ 70%</strong> is considered good. Aim for
                                    mAP@50-95 ≥ 50% for production use.
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ModelsPanel;
