from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from app.database import init_db
from app.api import projects, images, annotations, pipeline, auth
from app.config import settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield

app = FastAPI(title="AI Vision Platform", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(projects.router, prefix="/api/v1")
app.include_router(images.router, prefix="/api/v1")
app.include_router(annotations.router, prefix="/api/v1")
app.include_router(pipeline.router, prefix="/api/v1")

app.mount("/uploads", StaticFiles(directory=str(settings.upload_dir)), name="uploads")

@app.get("/health")
async def health():
    return {"status": "ok"}
