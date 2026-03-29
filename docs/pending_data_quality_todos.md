# Pending Data Quality TODOs

Last updated: 2026-03-27

This document tracks data-quality capabilities that are agreed but not completed yet.

## Scope

Current pending items focus on:
1. unit_mismatch post-conversion summary and cleaning log integration
2. currency_symbol stricter advanced-mode policy and split recommendation

## Pending Items

### 1) unit_mismatch conversion summary + cleaning log

Status: Not completed
Priority: High

Goal:
- After applying a unit_mismatch decision, generate a conversion summary such as:
  - converted_rows
  - unchanged_rows
  - unparsed_rows
  - dropped_rows (if any future policy adds dropping)
- Persist this summary into a cleaning log that can be queried later.

Current gap:
- Unit conversion is executed in backend logic, but no structured post-conversion stats are emitted.
- No dedicated cleaning-log payload is stored for this operation.

Proposed implementation points:
- backend/db/loader.py
  - In unit_mismatch application branch, compute per-column conversion counters.
  - Return or accumulate summary objects in a side channel.
- backend/api/routes.py
  - During confirm flow, attach summaries to a cleaning log record.
- backend/db/versioning.py (or a new cleaning-log module)
  - Persist summary metadata with strategy version and timestamp.

Acceptance criteria:
- For each resolved unit_mismatch issue, one summary entry is saved.
- Summary includes at least: dataset_id, column, option, converted_rows, unchanged_rows, unparsed_rows, ts.
- Summary is retrievable through an API endpoint or existing schema/project info response.

---

### 2) currency_symbol advanced policy (must-solve + split recommendation)

Status: Partially completed
Priority: High

What is already done:
- Mixed currency symbols can be detected.
- In advanced mode, semantic warnings are currently marked as must_solve.
- Option label already warns: remove currency symbols (no FX conversion).

Still pending:
- Add explicit policy text and recommendation to split into currency_code/value.
- Add actionable strategy options beyond symbol stripping, for example:
  - split_currency_code_value
  - keep_symbol_and_value
- Record selected strategy into cleaning log.

Proposed implementation points:
- backend/db/loader.py
  - Extend currency_symbol options with split recommendation path.
  - Add parser that extracts symbol/code to a companion column when selected.
- frontend/src/components/schema/SchemaPanel.tsx
  - Show recommendation text under currency_symbol warnings in advanced mode.
- docs/api.md
  - Document new option values and behavior.

Acceptance criteria:
- Advanced mode blocks confirm when currency_symbol must-solve warning is unresolved.
- Selecting split strategy creates normalized value column and currency_code column (or equivalent metadata output).
- Cleaning log stores which strategy was applied.

---

## Suggested Delivery Plan

Phase 1:
- Add conversion summary counters in loader and return structure.
- Add minimal cleaning-log persistence for unit_mismatch and currency_symbol.

Phase 2:
- Add split_currency_code_value strategy.
- Add frontend recommendation copy and API contract updates.

Phase 3:
- Add query endpoint for cleaning logs and wire to UI diagnostics panel.

## Risks

1. Backward compatibility:
- Existing decision payloads and responses should keep old fields unchanged.

2. Data ambiguity:
- Currency symbol stripping without FX metadata can still cause semantic loss.

3. Performance:
- Per-row parsing for large datasets may increase confirm latency; vectorized parsing should be preferred.
