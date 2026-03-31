"""Viz Agent — selects chart type and outputs structured data for frontend rendering."""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from backend.agents.base import get_llm
from backend.agents.json_utils import extract_json
from backend.config.prompts import VIZ_SYSTEM
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)


def _to_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        s = value.strip().replace(",", "")
        if not s:
            return None
        try:
            if "." in s:
                return float(s)
            return int(s)
        except ValueError:
            return None
    return None


def _numeric_ratio(rows: list[list], idx: int) -> float:
    total = 0
    numeric = 0
    for r in rows:
        if idx >= len(r):
            continue
        v = r[idx]
        if v in (None, ""):
            continue
        total += 1
        if _to_number(v) is not None:
            numeric += 1
    if total == 0:
        return 0.0
    return numeric / total


def _is_temporal_scalar(value) -> bool:
    if value is None or value == "":
        return False

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        year = int(value)
        return 1900 <= year <= 2100

    if isinstance(value, str):
        s = value.strip()
        if not s:
            return False

        if s.isdigit() and len(s) == 4:
            year = int(s)
            if 1900 <= year <= 2100:
                return True

        # ISO/date-like and quarter-like strings.
        if any(ch in s for ch in ("-", "/")):
            parts = s.replace("/", "-").split("-")
            if len(parts) >= 2 and all(p.isdigit() for p in parts if p):
                return True
        if s.lower().startswith("q") and any(ch.isdigit() for ch in s):
            return True

    return False


def _temporal_ratio(rows: list[list], idx: int) -> float:
    total = 0
    temporal = 0
    for r in rows:
        if idx >= len(r):
            continue
        v = r[idx]
        if v in (None, ""):
            continue
        total += 1
        if _is_temporal_scalar(v):
            temporal += 1
    if total == 0:
        return 0.0
    return temporal / total


def _pick_y_column(
    columns: list[str],
    rows: list[list],
    numeric_idxs: list[int],
    y_label_hint: str | None = None,
) -> int | None:
    if not numeric_idxs:
        return None

    measure_keywords = (
        "sales", "revenue", "amount", "value", "price", "profit", "cost", "count", "sum", "avg",
        "mean", "score", "total", "qty", "quantity",
    )
    helper_keywords = ("rank", "row_num", "rownum", "index", "idx", "id", "order")

    # Prefer measures over years/timestamps misclassified as numeric.
    candidates = [i for i in numeric_idxs if _temporal_ratio(rows, i) < 0.6]
    if not candidates:
        candidates = list(numeric_idxs)

    hint = (y_label_hint or "").lower().replace("'", "")
    hint_tokens = [t.strip(".,;:()") for t in hint.split() if len(t.strip(".,;:()")) >= 3]

    def score(idx: int) -> tuple[float, int]:
        name = str(columns[idx]).lower()
        s = 0.0

        if any(k in name for k in measure_keywords):
            s += 5.0
        if any(k in name for k in helper_keywords):
            s -= 6.0

        # Deprioritize typical secondary metrics (ratings, averages) vs primary totals when both exist.
        if any(
            frag in name
            for frag in ("avg_", "_avg_", "mean_", "_mean_", "median_", "_median_", " std", "_std_")
        ) or name.startswith(("avg", "mean", "median")):
            s -= 5.0
        if any(
            frag in name
            for frag in ("avg_rating", "_rating")
        ):
            s -= 4.0

        for tok in hint_tokens:
            if tok in name:
                s += 4.0

        vals = []
        for r in rows:
            if idx < len(r):
                n = _to_number(r[idx])
                if n is not None:
                    vals.append(float(n))

        if vals:
            uniq = len(set(vals))
            if uniq > 1:
                s += 1.0
            if max(vals) - min(vals) > 0:
                s += 0.5

        # Tie-breaker: prefer the leftmost strong measure (avoid always picking the rightmost column).
        return (s, -idx)

    return max(candidates, key=score)


def _build_series_from_rows(
    columns: list[str], rows: list[list], y_label_hint: str | None = None
) -> list[dict]:
    """Build chart series deterministically from full SQL rows.

    Heuristic:
    - y column: best-scoring numeric measure (prefers totals/counts over avg scores when both exist)
    - if >= 3 columns: first non-y is group, second non-y is x
    - if 2 columns: single series, first is x, second is y
    """
    if not columns or not rows or len(columns) < 2:
        return []

    numeric_idxs = [i for i in range(len(columns)) if _numeric_ratio(rows, i) >= 0.6]
    y_idx = _pick_y_column(columns, rows, numeric_idxs, y_label_hint=y_label_hint)
    if y_idx is None:
        return []

    non_y = [i for i in range(len(columns)) if i != y_idx]
    if not non_y:
        return []

    temporal_idxs = [i for i in non_y if _temporal_ratio(rows, i) >= 0.6]
    categorical_idxs = [i for i in non_y if _numeric_ratio(rows, i) < 0.6]
    numeric_non_y = [i for i in non_y if i not in categorical_idxs]

    # Prefer temporal dimension for x-axis. Then category. Then numeric fallback.
    # Exception: if the temporal column has only 1 unique value (single-period snapshot query,
    # e.g. "top 5 genres in 2020"), prefer categorical as x so the category spread is visible.
    if temporal_idxs:
        temp_candidate = temporal_idxs[0]
        unique_temporal = len({
            r[temp_candidate] for r in rows
            if temp_candidate < len(r) and r[temp_candidate] is not None
        })
        if unique_temporal <= 1 and categorical_idxs:
            x_idx = categorical_idxs[0]
        else:
            x_idx = temp_candidate
    elif categorical_idxs:
        x_idx = categorical_idxs[0]
    else:
        x_idx = numeric_non_y[0]

    # Only create grouped multi-series when there is an extra categorical dimension.
    remaining_cats = [i for i in categorical_idxs if i != x_idx]
    group_idx = remaining_cats[0] if remaining_cats else None

    grouped: dict[str, dict[str, list]] = {}
    for row in rows:
        if y_idx >= len(row) or x_idx >= len(row):
            continue
        x_val = row[x_idx]
        if x_val is None:
            continue
        y_val = _to_number(row[y_idx])
        if y_val is None:
            continue

        if group_idx is None:
            name = str(columns[y_idx])
        else:
            raw_name = row[group_idx] if group_idx < len(row) else None
            name = str(raw_name) if raw_name not in (None, "") else "(unknown)"

        bucket = grouped.setdefault(name, {"x": [], "y": []})
        bucket["x"].append(x_val)
        bucket["y"].append(y_val)

    result = []
    for name, values in grouped.items():
        xs = values["x"]
        ys = values["y"]
        if not xs or not ys:
            continue

        # Keep chronological order when x is temporal (e.g., release_year).
        if xs and all(_is_temporal_scalar(x) for x in xs):
            pairs = list(zip(xs, ys))

            def _temporal_key(item):
                x = item[0]
                if isinstance(x, (int, float)):
                    return float(x)
                sx = str(x).strip()
                if sx.isdigit():
                    return float(int(sx))
                return float('inf')

            pairs.sort(key=_temporal_key)
            xs = [p[0] for p in pairs]
            ys = [p[1] for p in pairs]

        result.append({"name": name, "x": xs, "y": ys})

    return result

_HISTOGRAM_KEYWORDS = (
    "histogram",
    "distribution",
    "frequency distribution",
    "frequency",
    "binning",
    "bins",
)


def _is_histogram_intent(user_query: str) -> bool:
    q = (user_query or "").lower()
    return any(kw in q for kw in _HISTOGRAM_KEYWORDS)


def _compatible_chart_types(series: list[dict], primary_type: str) -> list[str]:
    """Determine which chart types are compatible with the actual data shape.

    Returns a list of chart types (excluding `primary_type` and `table`)
    that make semantic sense for the data.
    """
    if not series:
        return []

    all_x: list = []
    all_y: list = []
    for s in series:
        all_x.extend(s.get("x", []))
        all_y.extend(s.get("y", []))

    if not all_x or not all_y:
        return []

    # Classify x-axis data
    num_x = sum(1 for v in all_x if _to_number(v) is not None)
    x_numeric_ratio = num_x / len(all_x) if all_x else 0

    temporal_x = sum(1 for v in all_x if _is_temporal_scalar(v))
    x_temporal_ratio = temporal_x / len(all_x) if all_x else 0

    unique_x = len(set(str(v) for v in all_x))

    x_is_numeric = x_numeric_ratio >= 0.8
    x_is_temporal = x_temporal_ratio >= 0.6
    x_is_categorical = not x_is_numeric and not x_is_temporal

    # Classify y-axis data
    num_y = sum(1 for v in all_y if _to_number(v) is not None)
    y_is_numeric = (num_y / len(all_y)) >= 0.8 if all_y else False

    compatible = set()

    if x_is_temporal and y_is_numeric:
        compatible.update(["line", "area", "bar"])
    elif x_is_numeric and y_is_numeric:
        compatible.update(["scatter", "line", "bar"])
        if unique_x <= 30:
            compatible.add("area")
    elif x_is_categorical and y_is_numeric:
        compatible.add("bar")
        if unique_x <= 10:
            compatible.add("pie")

    # Always include primary type
    compatible.add(primary_type)
    compatible.discard("table")

    return [t for t in compatible if t != primary_type]


async def viz_agent(state: AgentState) -> dict:
    """Generate structured chart data from SQL results."""

    sql_result = state.get("sql_result", {})
    final_columns = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])
    error = sql_result.get("error")

    # Skip if SQL failed or no data
    if error or not final_rows:
        logger.info("Viz Agent skipped — no data to visualize")
        return {
            "viz_result": None,
            "stream_events": [],
        }

    # Build data preview
    header = " | ".join(str(c) for c in final_columns)
    rows_text = "\n".join(
        " | ".join(str(v) for v in row)
        for row in final_rows[:30]
    )
    data_preview = f"{header}\n{rows_text}"

    prompt = VIZ_SYSTEM.format(
        columns=", ".join(final_columns),
        data_preview=data_preview,
        row_count=len(final_rows),
        user_query=state["user_query"],
        user_lang=state.get("user_lang", "en"),
    )

    # Progress: generating chart
    start_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {len(sql_result.get('steps', []))} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "active"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    llm = get_llm(temperature=0)

    messages = [
        SystemMessage(content=prompt),
        HumanMessage(content="Generate the chart data now. Output ONLY valid JSON, no explanation."),
    ]

    chart_data = None

    # Try up to 2 times (initial + 1 retry for small models)
    for attempt in range(2):
        response = await llm.ainvoke(messages)
        text = response.content.strip()
        logger.info(f"Viz Agent attempt {attempt + 1}, raw output: {text[:300]}")

        chart_data = extract_json(text)
        if chart_data and chart_data.get("series"):
            break

        # Retry with stronger hint
        if attempt == 0:
            logger.warning(f"Viz Agent: failed to parse chart data, retrying with hint")
            messages.append(AIMessage(content=text))
            messages.append(HumanMessage(
                content='Your output was not valid JSON. Output ONLY a JSON object with keys: "type", "alt_types", "title", "x_label", "y_label", "series". No markdown fences, no explanation.'
            ))
            chart_data = None

    if not chart_data:
        return {
            "viz_result": None,
            "stream_events": [start_event],
        }

    # Validate and normalize: deterministic series from SQL rows (use LLM y_label to disambiguate measures).
    full_series = _build_series_from_rows(
        final_columns, final_rows, y_label_hint=chart_data.get("y_label")
    )
    series = full_series or chart_data.get("series", [])

    # Guard: detect histogram intent with insufficient bin data.
    # If user asked for a distribution/histogram but SQL only returned ≤ 5 rows,
    # the SQL Agent likely produced summary stats instead of proper bin data.
    histogram_intent = _is_histogram_intent(state.get("user_query", ""))
    if histogram_intent and len(final_rows) <= 5:
        total_points = sum(len(s.get("y", [])) for s in series)
        if total_points <= 5:
            logger.warning(
                f"Viz Agent: histogram intent detected but only {len(final_rows)} rows / "
                f"{total_points} data points — SQL likely returned summary stats instead of bins"
            )

    primary_type = chart_data.get("type", "bar")
    llm_alt_types = chart_data.get("alt_types", [])

    # Programmatic compatibility filter: only keep alt_types that match the data shape.
    compatible = _compatible_chart_types(series, primary_type)
    filtered_alt = [t for t in llm_alt_types if t in compatible]
    # Add compatible types the LLM missed, but keep LLM ordering first.
    for ct in compatible:
        if ct not in filtered_alt:
            filtered_alt.append(ct)

    if set(filtered_alt) != set(llm_alt_types):
        logger.info(
            f"Viz Agent: alt_types filtered from {llm_alt_types} to {filtered_alt} "
            f"based on data compatibility"
        )

    viz_result = {
        "type": primary_type,
        "alt_types": filtered_alt,
        "title": chart_data.get("title", ""),
        "x_label": chart_data.get("x_label", ""),
        "y_label": chart_data.get("y_label", ""),
        "series": series,
    }

    # Also build table_data for the table view
    viz_result["table_data"] = {
        "headers": final_columns,
        "rows": final_rows[:100],
    }

    logger.info(f"Viz Agent: type={viz_result['type']}, series={len(viz_result['series'])}, alt_types={viz_result['alt_types']}")

    # Done event
    done_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {len(sql_result.get('steps', []))} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    # Result event for frontend
    result_event = {
        "type": "result",
        "data": {
            "type": "viz",
            "chart_type": viz_result["type"],
            "alt_types": viz_result["alt_types"],
            "title": viz_result["title"],
            "x_label": viz_result["x_label"],
            "y_label": viz_result["y_label"],
            "series": viz_result["series"],
            "table_data": viz_result["table_data"],
        }
    }

    return {
        "viz_result": viz_result,
        "stream_events": [start_event, result_event, done_event],
    }