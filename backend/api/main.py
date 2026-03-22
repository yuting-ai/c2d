"""FastAPI application entry point."""

import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from backend.api.routes import router
from backend.db.engine import engine
from backend.config.settings import settings

# Configure logging so we can see pipeline errors
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


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


@app.get("/api/test-llm")
async def test_llm():
    """Quick test to verify LLM connection works."""
    try:
        from backend.agents.base import get_llm
        from langchain_core.messages import HumanMessage
        llm = get_llm()
        response = await llm.ainvoke([HumanMessage(content="Say hello in 5 words.")])
        return {"status": "ok", "response": response.content, "model": settings.LLM_MODEL}
    except Exception as e:
        return {"status": "error", "message": str(e), "model": settings.LLM_MODEL}