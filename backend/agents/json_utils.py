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

    # Strategy 6: fix literal newlines inside JSON string values, then retry
    # Small models often write multi-line sql_task strings with real \n chars
    fixed_nl = _fix_newlines_in_strings(text)
    if fixed_nl != text:
        obj = _try_parse(fixed_nl)
        if obj is not None:
            return obj
        obj = _try_parse(_fix_json(fixed_nl))
        if obj is not None:
            return obj
        # Also try extracting { ... } block after newline fix
        match2 = re.search(r"\{[\s\S]*\}", fixed_nl)
        if match2:
            obj = _try_parse(_fix_json(match2.group(0)))
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


def _fix_newlines_in_strings(text: str) -> str:
    """Replace literal newlines/tabs inside JSON string values with their escape sequences.

    Small models (especially when writing multi-line sql_task descriptions) often
    emit real newline characters inside a JSON string, producing invalid JSON.
    This function walks the text character-by-character and replaces bare \\n / \\r / \\t
    that appear inside a quoted string with the proper JSON escape sequences.
    """
    result: list[str] = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        # Toggle in_string on unescaped double-quote
        if ch == '"' and (i == 0 or text[i - 1] != '\\'):
            in_string = not in_string
            result.append(ch)
        elif in_string and ch == '\n':
            result.append('\\n')
        elif in_string and ch == '\r':
            result.append('\\r')
        elif in_string and ch == '\t':
            result.append('\\t')
        else:
            result.append(ch)
        i += 1
    return ''.join(result)


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


def _find_matching_paren(s: str, open_pos: int) -> int:
    """Find the closing ')' that matches '(' at open_pos.

    Respects nested parentheses and string literals.
    Returns -1 if no matching paren is found.
    """
    depth = 0
    in_sq = in_dq = False
    for i in range(open_pos, len(s)):
        ch = s[i]
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        if not in_sq and not in_dq:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    return i
    return -1


def _split_select_items(select_list: str) -> list[str]:
    """Split a SELECT column list at top-level commas (not inside parens/quotes)."""
    items: list[str] = []
    buf: list[str] = []
    depth = 0
    in_sq = in_dq = False
    for ch in select_list:
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        if not in_sq and not in_dq:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            elif ch == ',' and depth == 0:
                items.append(''.join(buf).strip())
                buf = []
                continue
        buf.append(ch)
    if buf:
        items.append(''.join(buf).strip())
    return [x for x in items if x]


def _select_item_output_name(item: str) -> str | None:
    """Extract the output column name of a SELECT item.

    'YEAR(release_date) AS year'     → 'year'
    'SUM(total_sales) AS total_sales' → 'total_sales'
    'genre'                           → 'genre'
    '"schema"."col"'                  → 'col'
    Returns None if the name cannot be determined (e.g., bare function call).
    """
    item = item.strip()
    # Prefer explicit AS alias
    m = re.search(r'\bAS\s+(\w+)\s*$', item, re.IGNORECASE)
    if m:
        return m.group(1)
    # Qualified name: take the last part
    parts = item.split('.')
    last = parts[-1].strip().strip('"')
    if '(' in last:
        return None  # bare function call with no alias — skip
    return last or None


def _fix_window_in_grouped_cte(sql: str) -> str:
    """Split a CTE that mixes GROUP BY aggregation with window functions into two CTEs.

    DuckDB's binder resolves window functions before SELECT-level aliases are
    available, so references like ``ORDER BY agg_alias`` inside ``OVER (...)``
    in the same SELECT that contains ``GROUP BY`` raise a Binder Error.

    Transformation (one CTE → two CTEs):

        WITH ranked AS (
          SELECT yr, genre, SUM(sales) AS sales,
                 ROW_NUMBER() OVER (PARTITION BY yr ORDER BY sales DESC) AS rn
          FROM tbl
          GROUP BY yr, genre
        )
        SELECT ... FROM ranked WHERE rn <= 5

    becomes:

        WITH ranked_agg AS (
          SELECT yr, genre, SUM(sales) AS sales
          FROM tbl
          GROUP BY yr, genre
        ),
        ranked AS (
          SELECT yr, genre, sales,
                 ROW_NUMBER() OVER (PARTITION BY yr ORDER BY sales DESC) AS rn
          FROM ranked_agg
        )
        SELECT ... FROM ranked WHERE rn <= 5

    Only processes the *first* CTE in the WITH clause. Multi-CTE inputs where
    the problematic CTE is not first are rare in practice (models emit one CTE
    for P-B queries) and left for future work.
    """
    if not sql:
        return sql

    # Quick pre-checks — both markers must be present
    s_upper = sql.upper()
    if 'GROUP BY' not in s_upper or ' OVER ' not in s_upper:
        return sql

    # Match the opening of the WITH clause and first CTE name
    with_m = re.match(
        r'(\s*WITH\s+(?:RECURSIVE\s+)?)(\w+)(\s+AS\s*\()',
        sql,
        re.IGNORECASE,
    )
    if not with_m:
        return sql

    with_keyword = with_m.group(1)  # e.g. 'WITH '
    cte_name = with_m.group(2)      # e.g. 'ranked'
    # group(3) ends with '(' — so with_m.end()-1 is the position of '('
    open_paren_pos = with_m.end() - 1
    if sql[open_paren_pos] != '(':
        return sql  # safety guard

    close_paren_pos = _find_matching_paren(sql, open_paren_pos)
    if close_paren_pos == -1:
        return sql

    cte_body = sql[open_paren_pos + 1 : close_paren_pos]

    # Confirm this CTE body has both GROUP BY and a window OVER
    body_upper = cte_body.upper()
    if 'GROUP BY' not in body_upper or ' OVER ' not in body_upper:
        return sql

    # ── Parse the SELECT list from the CTE body ────────────────────────────
    select_m = re.match(r'\s*SELECT\s+', cte_body, re.IGNORECASE)
    if not select_m:
        return sql

    after_select = cte_body[select_m.end():]

    # Walk after_select to find the first FROM at paren depth 0
    from_pos: int | None = None
    depth = 0
    in_sq = in_dq = False
    i = 0
    while i < len(after_select):
        ch = after_select[i]
        if ch == "'" and not in_dq:
            in_sq = not in_sq
        elif ch == '"' and not in_sq:
            in_dq = not in_dq
        if not in_sq and not in_dq:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
            elif depth == 0 and re.match(r'\bFROM\b', after_select[i:], re.IGNORECASE):
                from_pos = i
                break
        i += 1

    if from_pos is None:
        return sql

    raw_select_list = after_select[:from_pos].strip()
    from_and_rest = after_select[from_pos:].strip()  # 'FROM tbl WHERE … GROUP BY …'

    # ── Split SELECT list and separate window-function items ───────────────
    items = _split_select_items(raw_select_list)
    if not items:
        return sql

    window_items = [it for it in items if re.search(r'\bOVER\s*\(', it, re.IGNORECASE)]
    regular_items = [it for it in items if not re.search(r'\bOVER\s*\(', it, re.IGNORECASE)]

    if not window_items or not regular_items:
        return sql  # nothing to split

    # ── Derive output column names for the second CTE's SELECT list ───────
    col_refs = []
    for it in regular_items:
        name = _select_item_output_name(it)
        if name:
            col_refs.append(name)

    second_select_prefix = ', '.join(col_refs) if col_refs else '*'

    # ── Resolve raw-column references in window items ─────────────────────
    # After the split, the second CTE reads from the *first* CTE which only
    # exposes aliased columns (e.g. "year", not "YEAR(release_date)").
    # Any raw expression used in PARTITION BY / ORDER BY inside the window
    # function must be replaced with the corresponding alias.
    #
    # Example: PARTITION BY YEAR(release_date)  →  PARTITION BY year
    #          (because the first CTE has YEAR(release_date) AS year)
    expr_to_alias: dict[str, str] = {}
    for it in regular_items:
        m = re.match(r'(.+?)\s+AS\s+(\w+)\s*$', it.strip(), re.IGNORECASE | re.DOTALL)
        if m:
            expr = m.group(1).strip()
            alias = m.group(2)
            # Only map when expression differs from alias (skip "genre AS genre")
            if expr.lower() != alias.lower():
                expr_to_alias[expr] = alias

    resolved_window_items = []
    for witem in window_items:
        resolved = witem
        for expr, alias in expr_to_alias.items():
            resolved = re.sub(re.escape(expr), alias, resolved, flags=re.IGNORECASE)
        resolved_window_items.append(resolved)

    # ── Build the two replacement CTEs ────────────────────────────────────
    agg_name = f"{cte_name}_agg"
    regular_str = ',\n    '.join(regular_items)
    window_str = ',\n    '.join(resolved_window_items)

    first_cte = (
        f"{agg_name} AS (\n"
        f"  SELECT\n"
        f"    {regular_str}\n"
        f"  {from_and_rest}\n"
        f")"
    )
    second_cte = (
        f"{cte_name} AS (\n"
        f"  SELECT {second_select_prefix},\n"
        f"    {window_str}\n"
        f"  FROM {agg_name}\n"
        f")"
    )

    after_cte = sql[close_paren_pos + 1:].strip()

    if after_cte.startswith(','):
        # Additional CTEs follow — keep the comma chain intact
        new_sql = f"{with_keyword}{first_cte},\n{second_cte}{after_cte}"
    else:
        new_sql = f"{with_keyword}{first_cte},\n{second_cte}\n{after_cte}"

    logger.info(
        "sanitize_sql: split CTE '%s' → '%s' (aggregate) + '%s' (window) "
        "to resolve DuckDB alias-in-window-ORDER-BY binder limitation",
        cte_name, agg_name, cte_name,
    )
    return new_sql


def _fix_aggregate_in_orderby(sql: str) -> str:
    """Replace aggregate expressions in ORDER BY clauses with their SELECT aliases.

    DuckDB raises a Binder Error when a window function's ORDER BY uses an aggregate
    expression (e.g. SUM(col)) while the outer query already has GROUP BY.
    The correct form is to reference the SELECT-level alias instead.

    Example (before):
        SUM(total_sales) AS total_sales,
        ROW_NUMBER() OVER (PARTITION BY year ORDER BY SUM(total_sales) DESC)

    Example (after, auto-corrected):
        SUM(total_sales) AS total_sales,
        ROW_NUMBER() OVER (PARTITION BY year ORDER BY total_sales DESC)

    Also safe to apply to the main ORDER BY of a GROUP BY query — using the alias
    rather than the aggregate expression is equivalent and preferred.
    """
    if not sql:
        return sql

    # Only applies to queries with GROUP BY (aggregation context)
    if not re.search(r"\bGROUP\s+BY\b", sql, re.IGNORECASE):
        return sql

    # Build a map: normalised aggregate expression → SELECT alias
    # Matches non-nested calls: SUM(col) AS alias, AVG(col_name) AS alias, etc.
    agg_alias: dict[str, str] = {}
    for m in re.finditer(
        r"\b(SUM|AVG|COUNT|MIN|MAX)\s*\(([^()]+?)\)\s+AS\s+(\w+)",
        sql,
        re.IGNORECASE,
    ):
        fn = m.group(1).upper()
        inner = m.group(2).strip().upper()
        alias = m.group(3)
        agg_alias[f"{fn}({inner})"] = alias

    if not agg_alias:
        return sql

    # Replace aggregate expressions that appear directly after ORDER BY.
    # The regex captures: ORDER BY <AGG_FUNC>(<args>) [ASC|DESC]
    # It handles multiple comma-separated ORDER BY terms by repeating.
    _AGG_TERM = re.compile(
        r"(?i)"
        r"(\bORDER\s+BY\s+)"                           # ORDER BY keyword
        r"((?:"
        r"(?:SUM|AVG|COUNT|MIN|MAX)\s*\([^()]+\)"     # aggregate term
        r"|\w+"                                          # plain column/alias term
        r")"
        r"(?:\s+(?:ASC|DESC))?"                         # optional direction
        r"(?:\s*,\s*"                                    # optional extra terms
        r"(?:"
        r"(?:SUM|AVG|COUNT|MIN|MAX)\s*\([^()]+\)"
        r"|\w+"
        r")"
        r"(?:\s+(?:ASC|DESC))?"
        r")*)",
    )

    def _fix_term(term: str) -> str:
        """Replace a single ORDER BY term's aggregate with its alias, if known."""
        def _repl(m: re.Match) -> str:
            fn = m.group(1).upper()
            inner = m.group(2).strip().upper()
            key = f"{fn}({inner})"
            return agg_alias.get(key, m.group(0))

        return re.sub(
            r"\b(SUM|AVG|COUNT|MIN|MAX)\s*\(([^()]+)\)",
            _repl,
            term,
            flags=re.IGNORECASE,
        )

    def _fix_orderby(m: re.Match) -> str:
        keyword = m.group(1)
        terms_str = m.group(2)
        fixed = _fix_term(terms_str)
        return keyword + fixed

    fixed_sql = _AGG_TERM.sub(_fix_orderby, sql)

    if fixed_sql != sql:
        logger.info(
            "sanitize_sql: auto-corrected aggregate expression(s) in ORDER BY → alias "
            "(prevents DuckDB Binder Error in window functions)"
        )

    return fixed_sql


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

    # Auto-correct aggregate expressions in ORDER BY → use SELECT alias
    # Prevents DuckDB Binder Error in window functions alongside GROUP BY
    sql = _fix_aggregate_in_orderby(sql)

    # Split CTEs that mix GROUP BY aggregation with window functions into two CTEs.
    # DuckDB cannot resolve SELECT-level aggregate aliases in window ORDER BY when
    # GROUP BY is present in the same SELECT — must aggregate first, then rank.
    sql = _fix_window_in_grouped_cte(sql)

    # Remove trailing semicolons (DuckDB handles both, but cleaner without)
    sql = sql.rstrip().rstrip(";").strip()

    return sql
