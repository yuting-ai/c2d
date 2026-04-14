# DuckDB Offline Knowledge Base

Single source of truth for SQL syntax guidance:

- `quick_reference.md`

Runtime behavior:

- `backend/knowledge/duckdb_retriever.py` reads only `quick_reference.md`
- SQL Agent injects relevant sections into `SQL_AGENT_SYSTEM`

This avoids drift from multiple generated snapshots and ensures one maintainable authoritative file.
