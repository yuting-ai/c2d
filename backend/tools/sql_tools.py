"""SQL tools for SQL Agent — created per-request with bound connection."""

import duckdb
from langchain_core.tools import tool
from backend.db.sandbox import execute_sandboxed


def create_sql_tools(conn: duckdb.DuckDBPyConnection) -> list:
    """Create SQL tools bound to a specific DuckDB connection."""

    @tool
    def run_query(sql: str) -> str:
        """Execute a SQL query against the DuckDB database.
        
        Args:
            sql: DuckDB-compatible SQL query string
            
        Returns:
            Query results as formatted text, or error message.
        """
        result = execute_sandboxed(conn, sql)

        if result.get("error"):
            return f"ERROR: {result['error']}\nSQL: {result['sql']}"

        # Format results as readable text for LLM
        columns = result["columns"]
        rows = result["rows"]
        row_count = result["row_count"]
        ms = result["execution_ms"]

        if row_count == 0:
            return f"Query returned 0 rows. ({ms}ms)\nSQL: {sql}"

        # Build text table (first 20 rows)
        display_rows = rows[:20]
        header = " | ".join(str(c) for c in columns)
        separator = "-" * len(header)
        body = "\n".join(
            " | ".join(str(v) for v in row)
            for row in display_rows
        )

        text = f"{header}\n{separator}\n{body}"
        if row_count > 20:
            text += f"\n... ({row_count} total rows, showing first 20)"
        text += f"\n({row_count} rows, {ms}ms)"

        return text

    return [run_query]