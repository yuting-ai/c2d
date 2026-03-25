"""Base utilities for agent LLM calls."""

from langchain_openai import ChatOpenAI
from backend.config.settings import settings

# ── Runtime override (allows switching without restart) ──
_runtime_provider: str | None = None
_runtime_model: str | None = None


def _is_qwen3() -> bool:
    """Return True if the active model is Qwen3 (supports /no_think directive)."""
    provider = _runtime_provider or settings.LLM_PROVIDER
    if provider != "ollama":
        return False
    model = (_runtime_model or settings.OLLAMA_MODEL).lower()
    return "qwen3" in model


def no_think(system_content: str) -> str:
    """Prepend /no_think for Qwen3 models to disable the thinking chain.

    Call this on the system prompt of agents that don't need reasoning
    (Planner, Viz, Critic, Report). Do NOT call it in SQL Agent — that
    one benefits from thinking for complex query generation.

    For non-Qwen3 models this is a no-op.
    """
    if _is_qwen3():
        return "/no_think\n" + system_content
    return system_content


def set_provider(provider: str, model: str | None = None):
    """Switch LLM provider at runtime. Takes effect on next get_llm() call."""
    global _runtime_provider, _runtime_model
    _runtime_provider = provider
    _runtime_model = model


def get_current_provider() -> dict:
    """Return which provider + model is currently active."""
    provider = _runtime_provider or settings.LLM_PROVIDER
    if provider == "ollama":
        model = _runtime_model or settings.OLLAMA_MODEL
        base_url = settings.OLLAMA_BASE_URL
    elif provider == "deepseek":
        model = _runtime_model or settings.LLM_MODEL
        base_url = settings.DEEPSEEK_BASE_URL
    elif provider == "anthropic":
        model = _runtime_model or settings.LLM_MODEL
        base_url = "https://api.anthropic.com/v1/"
    else:
        model = _runtime_model or settings.LLM_MODEL
        base_url = ""
    return {"provider": provider, "model": model, "base_url": base_url}


def get_llm(temperature: float = 0) -> ChatOpenAI:
    """Get LLM instance based on current provider (runtime override > .env)."""
    provider = _runtime_provider or settings.LLM_PROVIDER

    if provider == "deepseek":
        return ChatOpenAI(
            model=_runtime_model or settings.LLM_MODEL,
            api_key=settings.DEEPSEEK_API_KEY,
            base_url=settings.DEEPSEEK_BASE_URL,
            temperature=temperature,
            max_tokens=4096,
        )

    elif provider == "ollama":
        # Ollama exposes OpenAI-compatible API at /v1
        return ChatOpenAI(
            model=_runtime_model or settings.OLLAMA_MODEL,
            api_key="ollama",           # Ollama doesn't need a real key
            base_url=settings.OLLAMA_BASE_URL,
            temperature=temperature,
            max_tokens=4096,
        )

    elif provider == "anthropic":
        return ChatOpenAI(
            model=_runtime_model or settings.LLM_MODEL,
            api_key=settings.ANTHROPIC_API_KEY,
            base_url="https://api.anthropic.com/v1/",
            temperature=temperature,
            max_tokens=4096,
        )

    else:
        raise ValueError(f"Unknown LLM provider: {provider}")
