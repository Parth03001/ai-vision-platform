# ── Stage 1: Build React Frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Install dependencies
COPY frontend/package*.json ./
RUN npm install --legacy-peer-deps

COPY frontend/ ./

# Build-time API URL — default is relative (/api/v1) so Nginx proxies correctly
# on any domain without rebuilding the image.
ARG REACT_APP_API_URL=/api/v1
ARG REACT_APP_BASE_URL=""
ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV REACT_APP_BASE_URL=$REACT_APP_BASE_URL

RUN npm run build

# ── Stage 2: CUDA-enabled Python Backend (T4 / Turing arch, CUDA 12.1) ───────
# nvidia/cuda:12.1.0-cudnn8-runtime provides cuDNN 8 + CUDA 12.1 libs.
# T4 (Compute Capability 7.5) is fully supported by CUDA 12.1 + cuDNN 8.
FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install Python 3.11 (via deadsnakes PPA) + system libs for OpenCV / psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common curl \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-dev \
        python3.11-distutils \
        gcc \
        libpq-dev \
        postgresql-client \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install PyTorch with CUDA 12.1 first (T4-compatible CUDA wheels) ─────────
# Using python3 -m pip to avoid any PATH issues with pip symlinks in CUDA image.
RUN python3 -m pip install --no-cache-dir \
        "torch>=2.1.0" \
        "torchvision>=0.16.0" \
        --index-url https://download.pytorch.org/whl/cu121

# ── Install remaining Python dependencies ─────────────────────────────────────
COPY backend/requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt \
        --extra-index-url https://download.pytorch.org/whl/cu121

# ── Copy application code ─────────────────────────────────────────────────────
COPY backend/ ./

# ── Copy built React app from Stage 1 ─────────────────────────────────────────
# Docker will initialise the named volume frontend_build from this directory
# on first mount (when the volume is empty), making the files available to Nginx.
COPY --from=frontend-builder /app/frontend/build ./frontend/build

# ── Runtime directories ───────────────────────────────────────────────────────
RUN mkdir -p /app/data/uploads /app/data/models /app/logs

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
