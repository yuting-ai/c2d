"""FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from backend.api.routes import router
from backend.db.engine import engine
from backend.config.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    # Startup
    settings.ensure_dirs()
    yield
    # Shutdown
    engine.close_all()


app = FastAPI(
    title="c2d — Chat to Dataset",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routes
app.include_router(router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}