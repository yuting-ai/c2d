"""Global configuration loaded from .env file."""

from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # ── LLM Provider ──
    LLM_PROVIDER: str = "deepseek"
    LLM_MODEL: str = "deepseek-chat"
    DEEPSEEK_API_KEY: str = ""
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"
    ANTHROPIC_API_KEY: str = ""

    # ── Embedding ──
    EMBEDDING_PROVIDER: str = "local"
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"

    # ── Data Engine ──
    DUCKDB_DATA_DIR: str = "./data/processed"
    UPLOAD_DIR: str = "./data/uploads"
    EXPORT_DIR: str = "./data/exports"

    # ── Vector Database ──
    QDRANT_HOST: str = "localhost"
    QDRANT_PORT: int = 6333
    QDRANT_COLLECTION: str = "c2d_memory"

    # ── Session Storage ──
    STORAGE_BACKEND: str = "local"
    SQLITE_PATH: str = "./data/c2d.sqlite"

    # ── Server ──
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = True
    LOG_LEVEL: str = "info"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    def ensure_dirs(self):
        """Create data directories if they don't exist."""
        for d in [self.DUCKDB_DATA_DIR, self.UPLOAD_DIR, self.EXPORT_DIR]:
            Path(d).mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()