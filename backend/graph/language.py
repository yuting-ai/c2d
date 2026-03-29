"""BCP-47 language detection for the analysis pipeline (single entry point)."""

from typing import Callable

try:
    from langdetect import detect as _langdetect_detect
except ImportError:  # optional — app runs without `pip install langdetect`
    _langdetect_detect: Callable[[str], str] | None = None

# Ideographic (CJK) substring — re-run langdetect on it when the full string is easy to mislabel.
def _cjk_substring(s: str) -> str:
    return "".join(ch for ch in s if "\u4e00" <= ch <= "\u9fff")


def detect_language(query: str) -> str:
    """Detect query language; default to English when detection fails or input is empty."""
    text = (query or "").strip()
    if not text:
        return "en"
    cjk = _cjk_substring(text)
    if len(cjk) >= 2:
        if _langdetect_detect is not None:
            try:
                return _langdetect_detect(cjk)
            except Exception:
                return "zh-cn"
        return "zh-cn"
    if _langdetect_detect is None:
        return "en"
    try:
        return _langdetect_detect(text)
    except Exception:
        return "en"
