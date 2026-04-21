# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for AI Vision Platform Windows EXE
#
# Build with:   pyinstaller launcher.spec
# Output:       dist/AIVision/aivision.exe
#
# Prerequisites (run build.bat — it handles all of this):
#   pip install pyinstaller
#   Place portable PostgreSQL 17 in:  deploy/exe/resources/postgres/
#   Place portable Redis 7 in:        deploy/exe/resources/redis/
#   Build React frontend:             cd frontend && npm run build

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

REPO_ROOT = Path(SPECPATH).parent.parent        # ai-vision-platform/
BACKEND   = REPO_ROOT / "backend"
FRONTEND  = REPO_ROOT / "frontend" / "build"
RESOURCES = Path(SPECPATH) / "resources"
SCRIPTS   = REPO_ROOT / "scripts"

# ---------------------------------------------------------------------------
# Collect all data / binaries from heavy packages
# ---------------------------------------------------------------------------
datas     = []
binaries  = []
hiddenimports = []

for pkg in [
    "uvicorn", "fastapi", "starlette",
    "sqlalchemy", "asyncpg", "psycopg2",
    "celery", "redis", "kombu", "billiard",
    "transformers", "tokenizers", "huggingface_hub",
    "ultralytics",
    "supervision",
    "PIL",
    "cv2",
    "torch", "torchvision",
    "sentencepiece",
]:
    try:
        d, b, h = collect_all(pkg)
        datas    += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

# Backend source — add as a data tree so imports work at runtime
datas += [(str(BACKEND), "backend")]

# React build artefacts
if FRONTEND.exists():
    datas += [(str(FRONTEND), "frontend_build")]
else:
    print(f"WARNING: React build not found at {FRONTEND}. Run 'npm run build' first.")

# Database init SQL
datas += [(str(SCRIPTS / "init-db.sql"), ".")]

# Portable service binaries
pg_bin = RESOURCES / "postgres"
if pg_bin.exists():
    datas += [(str(pg_bin), "postgres")]
else:
    print(f"WARNING: Portable PostgreSQL not found at {pg_bin}")

redis_bin = RESOURCES / "redis"
if redis_bin.exists():
    datas += [(str(redis_bin), "redis")]
else:
    print(f"WARNING: Portable Redis not found at {redis_bin}")

# Services package (launcher helpers)
datas += [(str(Path(SPECPATH) / "services"), "services")]
datas += [(str(Path(SPECPATH) / "cuda_check.py"), ".")]

# Additional hidden imports for async drivers and task modules
hiddenimports += [
    "asyncpg",
    "asyncpg.pgproto.pgproto",
    "psycopg2",
    "celery.app.amqp",
    "celery.backends.redis",
    "celery.loaders.app",
    "kombu.transport.redis",
    "app.tasks.training",
    "app.tasks.auto_annotate",
    "app.tasks.ai_prompt",
    "app.tasks.video_processing",
    "app.tasks.active_learning",
    "app.api.projects",
    "app.api.images",
    "app.api.annotations",
    "app.api.pipeline",
    "app.api.auth",
    "app.api.videos",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "email_validator",
    "multipart",
]

# ---------------------------------------------------------------------------
a = Analysis(
    ["launcher.py"],
    pathex=[str(BACKEND)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "notebook", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,      # --onedir keeps binaries separate (faster startup)
    name="aivision",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                  # UPX can corrupt CUDA DLLs — keep off
    console=True,               # Show console window so users can see status
    icon=str(REPO_ROOT / "frontend" / "public" / "favicon.ico") if (REPO_ROOT / "frontend" / "public" / "favicon.ico").exists() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="AIVision",
)
