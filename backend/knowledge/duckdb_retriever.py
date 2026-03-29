"""Local DuckDB docs retriever for offline SQL assistance.

Single source of truth:
- ./doc/duckdb_official/quick_reference.md
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

from backend.config.settings import settings

_TOKEN_RE = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]+|\d+")


@dataclass
class _DocChunk:
    source: str
    title: str
    content: str


def _tokenize(text: str) -> list[str]:
    tokens = [t.lower() for t in _TOKEN_RE.findall(text or "")]
    return [t for t in tokens if len(t) > 1]


def _load_chunks(base: Path) -> list[_DocChunk]:
    quick_ref = base / "quick_reference.md"
    if not quick_ref.exists():
        return []
    text = quick_ref.read_text(encoding="utf-8", errors="ignore")
    if not text.strip():
        return []

    # Split by markdown headings for better retrieval granularity.
    chunks: list[_DocChunk] = []
    sections = re.split(r"(?m)^#+\s+", text)
    # The split drops heading markers; keep meaningful non-empty sections.
    for idx, sec in enumerate(sections):
        sec = sec.strip()
        if not sec:
            continue
        chunks.append(
            _DocChunk(
                source=str(quick_ref),
                title=f"quick_reference section {idx + 1}",
                content=sec,
            )
        )
    return chunks or [_DocChunk(source=str(quick_ref), title="quick_reference", content=text)]


def _rank_chunks(query: str, chunks: list[_DocChunk], top_k: int) -> list[_DocChunk]:
    q_tokens = _tokenize(query)
    if not chunks:
        return []
    if not q_tokens:
        return chunks[: max(1, top_k)]

    # Lightweight BM25-style scoring, no external dependency.
    docs_tokens = [_tokenize(c.title + "\n" + c.content) for c in chunks]
    n_docs = len(chunks)
    avg_len = sum(len(t) for t in docs_tokens) / max(1, n_docs)

    df: dict[str, int] = {}
    for toks in docs_tokens:
        for tok in set(toks):
            df[tok] = df.get(tok, 0) + 1

    scored: list[tuple[float, int]] = []
    k1 = 1.2
    b = 0.75
    q_terms = {}
    for t in q_tokens:
        q_terms[t] = q_terms.get(t, 0) + 1

    for idx, toks in enumerate(docs_tokens):
        if not toks:
            continue
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        dl = len(toks)
        score = 0.0
        for term, qf in q_terms.items():
            term_tf = tf.get(term, 0)
            if term_tf == 0:
                continue
            term_df = df.get(term, 0)
            idf = math.log(1 + (n_docs - term_df + 0.5) / (term_df + 0.5))
            denom = term_tf + k1 * (1 - b + b * (dl / max(1e-9, avg_len)))
            score += idf * ((term_tf * (k1 + 1)) / max(1e-9, denom)) * qf
        if score > 0:
            scored.append((score, idx))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [chunks[i] for _, i in scored[: max(1, top_k)]]


def retrieve_duckdb_refs(user_query: str, sql_task: str, top_k: int | None = None) -> str:
    """Return compact DuckDB reference snippets for SQL prompt injection."""
    base = Path(settings.DUCKDB_DOC_DIR)
    chunks = _load_chunks(base)
    if not chunks:
        return "No local DuckDB references found."

    merged_query = f"{user_query or ''}\n{sql_task or ''}".strip()
    ranked = _rank_chunks(merged_query, chunks, top_k or settings.SQL_DOC_TOP_K)
    if not ranked:
        ranked = chunks[: max(1, top_k or settings.SQL_DOC_TOP_K)]

    def _clean_snippet(s: str) -> str:
        # Avoid injecting markdown code fences into the SQL agent system prompt.
        s = s.replace("```", " ").replace("sql", " ")
        s = re.sub(r"\s+", " ", s).strip()
        return s

    parts: list[str] = []
    for i, c in enumerate(ranked, 1):
        snippet = _clean_snippet(c.content)
        if len(snippet) > 900:
            snippet = snippet[:900].rstrip() + " ..."
        source = c.source.replace("\\", "/")
        parts.append(f"[ref {i}] {c.title} ({source})\n{snippet}")
    return "\n\n".join(parts)
