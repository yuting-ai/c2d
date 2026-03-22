"""Base utilities for agent LLM calls."""

from langchain_openai import ChatOpenAI
from backend.config.settings import settings


def get_llm(temperature: float = 0) -> ChatOpenAI:
    """Get LLM instance based on settings."""
    if settings.LLM_PROVIDER == "deepseek":
        return ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.DEEPSEEK_API_KEY,
            base_url=settings.DEEPSEEK_BASE_URL,
            temperature=temperature,
            max_tokens=4096,
        )
    elif settings.LLM_PROVIDER == "anthropic":
        # Use langchain-openai with Anthropic's OpenAI-compatible endpoint
        return ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.ANTHROPIC_API_KEY,
            base_url="https://api.anthropic.com/v1/",
            temperature=temperature,
            max_tokens=4096,
        )
    else:
        raise ValueError(f"Unknown LLM provider: {settings.LLM_PROVIDER}")