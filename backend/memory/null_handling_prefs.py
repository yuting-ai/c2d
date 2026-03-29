"""Persistent NULL-handling preferences.

Saved per project so the user's "apply to all future analyses" choice is
remembered across sessions.  Storage is a simple JSON file on disk
(one file per project_id).  Thread safety is not critical since each
project is single-user; we rely on atomic write via temp-file + rename.
"""

import json
import os
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

_PREFS_DIR = Path("data/preferences")


def _prefs_path(project_id: str) -> Path:
    _PREFS_DIR.mkdir(parents=True, exist_ok=True)
    return _PREFS_DIR / f"{project_id}_null_handling.json"


def load_null_prefs(project_id: str) -> dict[str, str]:
    """Return {column_name: method} saved for this project.  Returns {} on any error."""
    path = _prefs_path(project_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("null_handling_prefs: failed to load %s — %s", path, exc)
        return {}


def save_null_prefs(project_id: str, config: dict[str, str]) -> None:
    """Merge *config* into the saved preferences for this project."""
    path = _prefs_path(project_id)
    existing = load_null_prefs(project_id)
    existing.update(config)
    try:
        # Atomic write: write to temp file then rename
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(existing, fh, indent=2)
        os.replace(tmp, path)
    except Exception as exc:
        logger.warning("null_handling_prefs: failed to save %s — %s", path, exc)
