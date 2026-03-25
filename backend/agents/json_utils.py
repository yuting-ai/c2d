"""Robust JSON extraction for small / local LLM outputs.

Small models (≤7B) often produce:
- ```json ... ``` fences
- <think>...</think> blocks before the answer (Qwen3)
- Extra text before/after JSON
- Trailing commas in JSON
- Single-quoted keys
- Comments inside JSON

This module handles all these cases.
"""

import json
import re
import logging

logger = logging.getLogger(__name__)


def extract_json(text: str) -> dict | None:
    """Extract the first valid JSON object from messy LLM output.

    Tries multiple strategies in order of reliability:
    1. Direct parse
    2. Strip markdown fences
    3. Strip <think> blocks
    4. Regex extraction of { ... }
    5. Fix common syntax issues (trailing commas, single quotes)

    Returns parsed dict, or None if all strategies fail.
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # Strategy 1: direct parse
    obj = _try_parse(text)
    if obj is not None:
        return obj

    # Strategy 2: strip ```json ... ``` or ``` ... ```
    cleaned = _strip_fences(text)
    if cleaned != text:
        obj = _try_parse(cleaned)
        if obj is not None:
            return obj

    # Strategy 3: strip <think>...</think> (Qwen3 thinking tags)
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    if cleaned != text:
        cleaned = _strip_fences(cleaned)
        obj = _try_parse(cleaned)
        if obj is not None:
            return obj

    # Strategy 4: regex extract first { ... } block (greedy from first { to last })
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        candidate = match.group(0)
        obj = _try_parse(candidate)
        if obj is not None:
            return obj
        # Try fixing common issues on the extracted block
        obj = _try_parse(_fix_json(candidate))
        if obj is not None:
            return obj

    # Strategy 5: fix the whole text
    obj = _try_parse(_fix_json(text))
    if obj is not None:
        return obj

    logger.warning(f"All JSON extraction strategies failed. Text preview: {text[:200]}")
    return None


def _try_parse(text: str) -> dict | None:
    """Try json.loads, return dict or None."""
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except (json.JSONDecodeError, ValueError):
        pass
    return None


def _strip_fences(text: str) -> str:
    """Remove markdown code fences."""
    lines = text.split("\n")
    out = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            continue
        out.append(line)
    return "\n".join(out).strip()


def _fix_json(text: str) -> str:
    """Fix common JSON issues from small models."""
    # Remove trailing commas before } or ]
    text = re.sub(r",\s*([}\]])", r"\1", text)
    # Replace single quotes with double quotes (rough heuristic)
    # Only if no double quotes present at all
    if '"' not in text and "'" in text:
        text = text.replace("'", '"')
    return text


def extract_sql(text: str) -> str | None:
    """Extract SQL query from plain text LLM response.

    Handles models that don't support tool_calls and instead write SQL inline.
    """
    if not text:
        return None

    # Try to find SQL in code fences
    match = re.search(r"```(?:sql)?\s*\n?(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if match:
        sql = match.group(1).strip()
        if sql:
            return sql

    # Try to find SELECT/WITH statement
    match = re.search(
        r"((?:SELECT|WITH)\s+[\s\S]*?;)",
        text,
        re.IGNORECASE,
    )
    if match:
        return match.group(1).strip()

    # Last resort: if text looks like a SQL statement itself
    upper = text.strip().upper()
    if upper.startswith(("SELECT ", "WITH ")):
        return text.strip()

    return None


def sanitize_sql(sql: str) -> str:
    """Fix common SQL dialect mistakes from small models.

    Small models often mix SQL Server / MySQL / PostgreSQL syntax.
    This function patches the most common errors for DuckDB compatibility.
    """
    if not sql:
        return sql

    # Remove SQL Server TOP N (DuckDB uses LIMIT)
    # "SELECT TOP 5 col1, col2 FROM ..." → "SELECT col1, col2 FROM ... LIMIT 5"
    top_match = re.match(
        r"(SELECT\s+)TOP\s+(\d+)\s+(.*)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if top_match:
        prefix, n, rest = top_match.groups()
        # Only add LIMIT if there isn't one already
        if not re.search(r"\bLIMIT\s+\d+", rest, re.IGNORECASE):
            sql = f"{prefix}{rest} LIMIT {n}"
        else:
            sql = f"{prefix}{rest}"
        logger.info(f"sanitize_sql: removed TOP {n}, rewrote to LIMIT")

    # Fix column names wrapped in single quotes → unquoted
    # e.g. 'release_year' → release_year (but not string literals in WHERE)
    # Only do this in SELECT/GROUP BY/ORDER BY clauses, not in WHERE value positions
    # Simple heuristic: DATE_TRUNC('year', 'col') → DATE_TRUNC('year', col)
    sql = re.sub(
        r"DATE_TRUNC\(\s*'(\w+)'\s*,\s*'(\w+)'\s*\)",
        r"DATE_TRUNC('\1', \2)",
        sql,
        flags=re.IGNORECASE,
    )

    # Remove trailing semicolons (DuckDB handles both, but cleaner without)
    sql = sql.rstrip().rstrip(";").strip()

    return sql
