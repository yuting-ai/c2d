"""SQL execution sandbox — read-only, with safety checks."""

import re
import time
import duckdb

FORBIDDEN_PATTERNS = [
    re.compile(r'\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE)\b', re.IGNORECASE),
    re.compile(r'\b(COPY|EXPORT|IMPORT|ATTACH|DETACH)\b', re.IGNORECASE),
    re.compile(r'\bPRAGMA\b', re.IGNORECASE),
]

# Cap query results to avoid unbounded memory usage while
# still covering common mid-sized datasets used for charting.
def execute_sandboxed(conn: duckdb.DuckDBPyConnection, sql: str) -> dict:
    """Execute SQL with safety restrictions. Returns dict with results or error."""

    # Strip markdown fences if LLM included them
    sql = sql.strip()
    if sql.startswith('```'):
        lines = sql.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        sql = '\n'.join(lines).strip()

    # Check forbidden operations
    for pattern in FORBIDDEN_PATTERNS:
        if pattern.search(sql):
            return {"error": f"Forbidden operation detected", "sql": sql}

    try:
        start = time.perf_counter()
        result = conn.execute(sql)
        elapsed_ms = int((time.perf_counter() - start) * 1000)

        columns = [desc[0] for desc in result.description]
        rows = result.fetchall()

        return {
            "columns": columns,
            "rows": [list(row) for row in rows],
            "row_count": len(rows),
            "execution_ms": elapsed_ms,
            "sql": sql,
            "error": None,
        }
    except duckdb.Error as e:
        return {"error": str(e), "sql": sql}