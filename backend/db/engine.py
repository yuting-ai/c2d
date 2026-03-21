"""DuckDB connection management — one database file per project."""

import duckdb
from pathlib import Path
from backend.config.settings import settings


class DuckDBEngine:
    """Manage DuckDB connections per project."""

    def __init__(self):
        self._connections: dict[str, duckdb.DuckDBPyConnection] = {}

    def get_connection(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """Get or create a read-write DuckDB connection for a project."""
        if project_id not in self._connections:
            db_path = Path(settings.DUCKDB_DATA_DIR) / f"{project_id}.duckdb"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._connections[project_id] = duckdb.connect(str(db_path))
        return self._connections[project_id]

    def get_readonly(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """Get a read-only connection for SQL Agent sandbox."""
        db_path = Path(settings.DUCKDB_DATA_DIR) / f"{project_id}.duckdb"
        if not db_path.exists():
            raise FileNotFoundError(f"No database for project {project_id}")
        return duckdb.connect(str(db_path), read_only=True)

    def close(self, project_id: str):
        """Close connection for a project."""
        conn = self._connections.pop(project_id, None)
        if conn:
            conn.close()

    def close_all(self):
        """Close all connections (shutdown)."""
        for conn in self._connections.values():
            conn.close()
        self._connections.clear()

    def list_tables(self, project_id: str) -> list[str]:
        """List all tables in a project's database."""
        conn = self.get_connection(project_id)
        result = conn.execute("SHOW TABLES").fetchall()
        return [row[0] for row in result]


engine = DuckDBEngine()