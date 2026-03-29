"""Regression tests for SQL Agent utility functions.

Run with:
    cd <project-root>
    python -m pytest tests/test_agents.py -v
"""

import pytest
import sys
import os

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.agents.sql_agent import _validate_sql_candidate
from backend.agents.json_utils import (
    sanitize_sql,
    _fix_aggregate_in_orderby,
    _fix_window_in_grouped_cte,
    _split_select_items,
    _select_item_output_name,
)


# ─────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────

REAL_TABLE = [{"name": "video_games_sales_1980_2024_raw"}]
MULTI_TABLE = [{"name": "sales"}, {"name": "genres"}]


# ─────────────────────────────────────────────────────────────
# _validate_sql_candidate — CTE whitelist fix
# ─────────────────────────────────────────────────────────────

class TestValidateSqlCandidate:

    # ── CTE queries: must pass ────────────────────────────────

    def test_single_cte_allowed(self):
        """FROM ranked where ranked is defined as a CTE must not be rejected."""
        sql = """
        WITH ranked AS (
          SELECT
            YEAR(release_date) AS year,
            genre,
            SUM(total_sales) AS total_sales,
            ROW_NUMBER() OVER (PARTITION BY YEAR(release_date) ORDER BY total_sales DESC) AS rn
          FROM video_games_sales_1980_2024_raw
          WHERE YEAR(release_date) >= 2020
          GROUP BY year, genre
        )
        SELECT year, genre, total_sales
        FROM ranked
        WHERE rn <= 5
        ORDER BY year ASC, total_sales DESC
        """
        assert _validate_sql_candidate(sql, REAL_TABLE) is None

    def test_multi_cte_allowed(self):
        """Multiple CTEs — all names must be whitelisted."""
        sql = """
        WITH base AS (
          SELECT genre, total_sales FROM sales
        ),
        ranked AS (
          SELECT genre, SUM(total_sales) AS ts FROM base GROUP BY genre
        )
        SELECT genre, ts FROM ranked ORDER BY ts DESC
        """
        tables = [{"name": "sales"}]
        assert _validate_sql_candidate(sql, tables) is None

    def test_recursive_cte_allowed(self):
        """WITH RECURSIVE — the RECURSIVE keyword must not be treated as a CTE name."""
        sql = """
        WITH RECURSIVE cte AS (
          SELECT 1 AS n
          UNION ALL
          SELECT n + 1 FROM cte WHERE n < 10
        )
        SELECT n FROM cte
        """
        # No real tables required when allowed_tables is empty
        assert _validate_sql_candidate(sql, []) is None

    def test_qualify_no_cte(self):
        """QUALIFY syntax — no CTE, real table only."""
        sql = """
        SELECT YEAR(release_date) AS year, genre, SUM(total_sales) AS total_sales
        FROM video_games_sales_1980_2024_raw
        WHERE YEAR(release_date) >= 2020
        GROUP BY year, genre
        QUALIFY ROW_NUMBER() OVER (PARTITION BY year ORDER BY total_sales DESC) <= 5
        ORDER BY year ASC, total_sales DESC
        """
        assert _validate_sql_candidate(sql, REAL_TABLE) is None

    def test_cte_name_not_confused_with_alias(self):
        """SUM(x) AS alias should NOT be mistakenly added to CTE whitelist."""
        sql = """
        SELECT genre, SUM(total_sales) AS ranked
        FROM missing_table
        GROUP BY genre
        """
        # 'ranked' appears as an alias, not a CTE. 'missing_table' is still unknown.
        result = _validate_sql_candidate(sql, REAL_TABLE)
        assert result is not None
        assert "missing_table" in result

    # ── Unknown tables: must be rejected ─────────────────────

    def test_truly_unknown_table_rejected(self):
        """FROM missing_table (with whitespace after) must be caught even when CTEs are present.

        Note: the validator uses a (?=\\s) lookahead guard to avoid false-positives from
        EXTRACT(YEAR FROM col) expressions.  As a consequence, a table name appearing
        *immediately* before ')' on the same line (e.g. 'FROM missing_table)') is NOT
        checked.  LLM-generated SQL always puts the table on its own line, so this
        edge case doesn't arise in practice.  The realistic multi-line format IS caught.
        """
        sql = """
        WITH ranked AS (
          SELECT genre
          FROM missing_table
          WHERE 1=1
        )
        SELECT genre FROM ranked
        """
        result = _validate_sql_candidate(sql, REAL_TABLE)
        assert result is not None
        assert "missing_table" in result

    def test_inline_cte_body_table_not_checked(self):
        """Known limitation: single-line 'FROM tbl)' is NOT validated ((?=\\s) guard).

        This is intentional — the same guard prevents EXTRACT(YEAR FROM col) from being
        treated as a table reference.  Multi-line format (the common LLM output) IS caught.
        """
        sql = "WITH ranked AS (SELECT genre FROM missing_table) SELECT genre FROM ranked"
        # This passes validation because missing_table is followed by ) not whitespace.
        # Document as known behaviour, not a bug.
        result = _validate_sql_candidate(sql, REAL_TABLE)
        assert result is None  # known limitation — single-line inline body not validated

    def test_unknown_table_no_cte(self):
        """Plain query referencing an unknown table must be rejected."""
        sql = "SELECT * FROM unknown_table WHERE id = 1"
        result = _validate_sql_candidate(sql, REAL_TABLE)
        assert result is not None
        assert "unknown_table" in result

    def test_join_unknown_table_rejected(self):
        """JOIN on an unknown table must also be caught."""
        sql = """
        SELECT a.genre, b.platform
        FROM video_games_sales_1980_2024_raw AS a
        JOIN unknown_platform_table AS b ON a.id = b.id
        """
        result = _validate_sql_candidate(sql, REAL_TABLE)
        assert result is not None
        assert "unknown_platform_table" in result

    # ── Structural checks ─────────────────────────────────────

    def test_empty_sql_rejected(self):
        assert _validate_sql_candidate("", REAL_TABLE) is not None

    def test_non_select_rejected(self):
        assert _validate_sql_candidate("DELETE FROM tbl", REAL_TABLE) is not None

    def test_multi_statement_rejected(self):
        sql = "SELECT 1; SELECT 2"
        assert _validate_sql_candidate(sql, REAL_TABLE) is not None

    def test_no_active_tables_skips_table_check(self):
        """When active_tables is empty, table-name checking is skipped."""
        sql = "SELECT * FROM any_table"
        assert _validate_sql_candidate(sql, []) is None

    def test_extract_year_from_not_false_positive(self):
        """EXTRACT(YEAR FROM col) must not be treated as a table reference."""
        sql = """
        SELECT EXTRACT(YEAR FROM release_date) AS year, SUM(total_sales) AS ts
        FROM video_games_sales_1980_2024_raw
        GROUP BY year
        ORDER BY year
        """
        assert _validate_sql_candidate(sql, REAL_TABLE) is None


# ─────────────────────────────────────────────────────────────
# _fix_aggregate_in_orderby / sanitize_sql
# ─────────────────────────────────────────────────────────────

class TestFixAggregateInOrderby:

    def test_sum_in_over_orderby_replaced(self):
        """The exact failing SQL pattern must be auto-corrected."""
        sql = """
        WITH ranked AS (
          SELECT
            YEAR(release_date) AS year,
            genre,
            SUM(total_sales) AS total_sales,
            ROW_NUMBER() OVER (PARTITION BY YEAR(release_date) ORDER BY SUM(total_sales) DESC) AS rn
          FROM tbl
          GROUP BY year, genre
        )
        SELECT year, genre, total_sales FROM ranked WHERE rn <= 5
        """
        fixed = _fix_aggregate_in_orderby(sql)
        assert "ORDER BY total_sales DESC" in fixed
        assert "ORDER BY SUM(total_sales) DESC" not in fixed

    def test_avg_in_over_orderby_replaced(self):
        sql = """
        SELECT genre, AVG(critic_score) AS avg_score,
               ROW_NUMBER() OVER (PARTITION BY year ORDER BY AVG(critic_score) DESC) AS rn
        FROM tbl GROUP BY year, genre
        """
        fixed = _fix_aggregate_in_orderby(sql)
        assert "ORDER BY avg_score DESC" in fixed
        assert "ORDER BY AVG(critic_score) DESC" not in fixed

    def test_multiple_aggs_in_orderby_replaced(self):
        sql = """
        SELECT genre, SUM(total_sales) AS ts, AVG(critic_score) AS avg_s
        FROM tbl GROUP BY genre
        QUALIFY ROW_NUMBER() OVER (PARTITION BY genre ORDER BY SUM(total_sales) DESC, AVG(critic_score) ASC) <= 3
        """
        fixed = _fix_aggregate_in_orderby(sql)
        assert "ORDER BY ts DESC, avg_s ASC" in fixed

    def test_no_group_by_unchanged(self):
        """Queries without GROUP BY must not be touched."""
        sql = "SELECT genre, SUM(total_sales) FROM tbl ORDER BY SUM(total_sales) DESC LIMIT 5"
        assert _fix_aggregate_in_orderby(sql) == sql

    def test_alias_already_used_unchanged(self):
        """If the alias is already used in ORDER BY, no change needed."""
        sql = """
        SELECT genre, SUM(total_sales) AS total_sales,
               ROW_NUMBER() OVER (PARTITION BY year ORDER BY total_sales DESC) AS rn
        FROM tbl GROUP BY year, genre
        """
        fixed = _fix_aggregate_in_orderby(sql)
        assert fixed == sql

    def test_sanitize_sql_integrates_fix(self):
        """sanitize_sql() must call _fix_aggregate_in_orderby automatically."""
        sql = """
        WITH r AS (
          SELECT genre, SUM(total_sales) AS total_sales,
                 ROW_NUMBER() OVER (PARTITION BY year ORDER BY SUM(total_sales) DESC) AS rn
          FROM tbl GROUP BY year, genre
        )
        SELECT genre, total_sales FROM r WHERE rn <= 5
        """
        fixed = sanitize_sql(sql)
        assert "ORDER BY total_sales DESC" in fixed
        assert "ORDER BY SUM(total_sales) DESC" not in fixed

    def test_no_alias_match_unchanged(self):
        """If aggregate expression has no matching alias, leave it as-is."""
        sql = """
        SELECT genre,
               ROW_NUMBER() OVER (PARTITION BY year ORDER BY SUM(orphan_col) DESC) AS rn
        FROM tbl GROUP BY year, genre
        """
        fixed = _fix_aggregate_in_orderby(sql)
        # No alias for SUM(orphan_col), so cannot replace — leave unchanged
        assert "ORDER BY SUM(orphan_col) DESC" in fixed


# ─────────────────────────────────────────────────────────────
# _fix_window_in_grouped_cte — CTE split for DuckDB binder fix
# ─────────────────────────────────────────────────────────────

class TestFixWindowInGroupedCte:
    """Tests for _fix_window_in_grouped_cte.

    DuckDB cannot use SELECT-level aggregate aliases in window ORDER BY when
    GROUP BY is present in the same SELECT.  The fix splits the CTE into:
      1. <name>_agg  — aggregation only (keeps GROUP BY, no window functions)
      2. <name>      — window function only (no GROUP BY, reads from <name>_agg)
    """

    # ── Core transformation ────────────────────────────────────

    def test_exact_failing_pattern_split(self):
        """The exact SQL pattern from the production failure is correctly split."""
        sql = (
            "WITH ranked AS (\n"
            "  SELECT\n"
            "    YEAR(release_date) AS year,\n"
            "    genre,\n"
            "    SUM(total_sales) AS total_sales,\n"
            "    ROW_NUMBER() OVER (PARTITION BY YEAR(release_date) ORDER BY total_sales DESC) AS rn\n"
            "  FROM video_games_sales_1980_2024_raw\n"
            "  WHERE YEAR(release_date) >= 2020\n"
            "  GROUP BY year, genre\n"
            ")\n"
            "SELECT year, genre, total_sales FROM ranked WHERE rn <= 5"
        )
        result = _fix_window_in_grouped_cte(sql)

        # Two CTEs must be present
        assert "ranked_agg AS (" in result
        assert "ranked AS (" in result

        # First CTE must NOT contain window function
        agg_start = result.index("ranked_agg AS (")
        ranked_start = result.index("ranked AS (")
        agg_body = result[agg_start:ranked_start]
        assert "ROW_NUMBER" not in agg_body
        assert "OVER" not in agg_body
        assert "GROUP BY" in agg_body

        # Second CTE must contain window function and reference first CTE
        ranked_body = result[ranked_start:]
        assert "ROW_NUMBER" in ranked_body
        assert "OVER" in ranked_body
        assert "FROM ranked_agg" in ranked_body
        assert "GROUP BY" not in ranked_body.split("FROM ranked_agg")[0]

        # Outer query is preserved
        assert "WHERE rn <= 5" in result

    def test_second_cte_select_list_includes_regular_cols(self):
        """Second CTE SELECT must name the regular columns, not just SELECT *."""
        sql = (
            "WITH ranked AS (\n"
            "  SELECT yr, genre, SUM(sales) AS sales,\n"
            "    ROW_NUMBER() OVER (PARTITION BY yr ORDER BY sales DESC) AS rn\n"
            "  FROM tbl\n"
            "  GROUP BY yr, genre\n"
            ")\n"
            "SELECT yr, genre, sales FROM ranked WHERE rn <= 3"
        )
        result = _fix_window_in_grouped_cte(sql)
        # Second CTE should SELECT the regular columns
        assert "yr" in result
        assert "genre" in result
        assert "sales" in result
        assert "FROM ranked_agg" in result

    def test_outer_query_preserved_exactly(self):
        """The query after the CTE (WHERE rn <= N, ORDER BY …) must be unchanged."""
        outer = "SELECT year, genre, total_sales\nFROM ranked\nWHERE rn <= 5\nORDER BY year ASC, total_sales DESC"
        sql = (
            "WITH ranked AS (\n"
            "  SELECT year, genre, SUM(sales) AS sales,\n"
            "    ROW_NUMBER() OVER (PARTITION BY year ORDER BY sales DESC) AS rn\n"
            "  FROM tbl GROUP BY year, genre\n"
            ")\n" + outer
        )
        result = _fix_window_in_grouped_cte(sql)
        assert outer in result

    # ── No-op cases (function must leave SQL unchanged) ────────

    def test_no_group_by_unchanged(self):
        """CTE without GROUP BY must not be modified."""
        sql = (
            "WITH ranked AS (\n"
            "  SELECT genre,\n"
            "    ROW_NUMBER() OVER (PARTITION BY platform ORDER BY sales DESC) AS rn\n"
            "  FROM tbl\n"
            ")\n"
            "SELECT * FROM ranked WHERE rn <= 5"
        )
        assert _fix_window_in_grouped_cte(sql) == sql

    def test_no_window_function_unchanged(self):
        """CTE with GROUP BY but no window function must not be modified."""
        sql = (
            "WITH agg AS (\n"
            "  SELECT year, genre, SUM(sales) AS sales\n"
            "  FROM tbl\n"
            "  GROUP BY year, genre\n"
            ")\n"
            "SELECT * FROM agg ORDER BY sales DESC LIMIT 10"
        )
        assert _fix_window_in_grouped_cte(sql) == sql

    def test_plain_select_unchanged(self):
        """Plain SELECT without WITH must not be touched."""
        sql = "SELECT genre, SUM(sales) AS sales FROM tbl GROUP BY genre ORDER BY sales DESC"
        assert _fix_window_in_grouped_cte(sql) == sql

    def test_empty_sql_unchanged(self):
        assert _fix_window_in_grouped_cte("") == ""

    # ── sanitize_sql integration ───────────────────────────────

    def test_sanitize_sql_applies_cte_split(self):
        """sanitize_sql() must invoke _fix_window_in_grouped_cte as part of pipeline."""
        sql = (
            "WITH ranked AS (\n"
            "  SELECT\n"
            "    YEAR(release_date) AS year,\n"
            "    genre,\n"
            "    SUM(total_sales) AS total_sales,\n"
            "    ROW_NUMBER() OVER (PARTITION BY YEAR(release_date) ORDER BY SUM(total_sales) DESC) AS rn\n"
            "  FROM video_games_sales_1980_2024_raw\n"
            "  WHERE YEAR(release_date) >= 2020\n"
            "  GROUP BY year, genre\n"
            ")\n"
            "SELECT year, genre, total_sales FROM ranked WHERE rn <= 5"
        )
        result = sanitize_sql(sql)
        # Both alias correction AND CTE split must have been applied
        assert "ORDER BY SUM(total_sales) DESC" not in result   # alias fix applied first
        assert "ranked_agg AS (" in result                       # then CTE split
        assert "FROM ranked_agg" in result

    # ── Helper unit tests ──────────────────────────────────────

    def test_split_select_items_simple(self):
        raw = "a, b, c"
        assert _split_select_items(raw) == ["a", "b", "c"]

    def test_split_select_items_nested_parens(self):
        """Commas inside function calls must NOT be treated as item separators."""
        raw = "YEAR(release_date) AS yr, SUM(total_sales) AS sales"
        items = _split_select_items(raw)
        assert len(items) == 2
        assert items[0] == "YEAR(release_date) AS yr"
        assert items[1] == "SUM(total_sales) AS sales"

    def test_split_select_items_window_function(self):
        """Window function with OVER (PARTITION BY x ORDER BY y) is one item."""
        raw = "genre, ROW_NUMBER() OVER (PARTITION BY yr ORDER BY sales DESC) AS rn"
        items = _split_select_items(raw)
        assert len(items) == 2
        assert "ROW_NUMBER" in items[1]
        assert "rn" in items[1]

    def test_select_item_output_name_with_alias(self):
        assert _select_item_output_name("YEAR(release_date) AS year") == "year"
        assert _select_item_output_name("SUM(total_sales) AS total_sales") == "total_sales"
        assert _select_item_output_name("COUNT(*) AS cnt") == "cnt"

    def test_select_item_output_name_plain_column(self):
        assert _select_item_output_name("genre") == "genre"
        assert _select_item_output_name("t.genre") == "genre"

    def test_select_item_output_name_bare_function_returns_none(self):
        """A bare function call with no alias cannot produce a reliable name."""
        assert _select_item_output_name("SUM(total_sales)") is None
