# DuckDB Quick Reference (Local Seed)

NOTE:
This file is a handcrafted seed template to keep the SQL agent usable before the full
official offline knowledge base is built.

For accurate official content, run:
`python -m backend.scripts.build_duckdb_kb`

# DuckDB SQL Syntax Reference
> Source: Official DuckDB Documentation (duckdb.org/docs/stable)  
> Version: DuckDB 1.4 (stable)  
> Purpose: RAG knowledge base — SQL query syntax, statements, and DuckDB-specific features

---

## TABLE OF CONTENTS
1. [Core Query Syntax (SELECT)](#1-core-query-syntax)
2. [FROM and JOIN Clauses](#2-from-and-join-clauses)
3. [WHERE Clause](#3-where-clause)
4. [GROUP BY and Aggregation](#4-group-by-and-aggregation)
5. [HAVING Clause](#5-having-clause)
6. [ORDER BY and LIMIT](#6-order-by-and-limit)
7. [Window Functions (OVER / WINDOW)](#7-window-functions)
8. [QUALIFY Clause](#8-qualify-clause)
9. [WITH (Common Table Expressions)](#9-with-common-table-expressions)
10. [Set Operations (UNION, INTERSECT, EXCEPT)](#10-set-operations)
11. [FILTER Clause](#11-filter-clause)
12. [SAMPLE Clause](#12-sample-clause)
13. [VALUES Clause](#13-values-clause)
14. [Prepared Statements](#14-prepared-statements)
15. [DDL Statements (CREATE, ALTER, DROP)](#15-ddl-statements)
16. [DML Statements (INSERT, UPDATE, DELETE, MERGE)](#16-dml-statements)
17. [COPY Statement](#17-copy-statement)
18. [PIVOT and UNPIVOT](#18-pivot-and-unpivot)
19. [Utility Statements](#19-utility-statements)
20. [DuckDB "Friendly SQL" Extensions](#20-duckdb-friendly-sql-extensions)
21. [Expressions and Operators](#21-expressions-and-operators)
22. [Data Types](#22-data-types)
23. [Functions Overview](#23-functions-overview)

---

## 1. CORE QUERY SYNTAX

### Full SELECT statement structure (canonical order)
```sql
SELECT [ALL | DISTINCT [ON (expr_list)]]
       select_expression [AS alias], ...
FROM table_reference
[WHERE condition]
[GROUP BY grouping_columns | ALL]
[HAVING condition]
[WINDOW window_name AS (window_spec), ...]
[QUALIFY condition]
[ORDER BY expression [ASC | DESC] [NULLS FIRST | NULLS LAST], ...]
[LIMIT [count | count%] [OFFSET n]]
[SAMPLE n [%] [METHOD (bernoulli | system | reservoir)]]
```

### SELECT clause
```sql
-- All columns
SELECT * FROM tbl;

-- Specific columns
SELECT col1, col2 FROM tbl;

-- Column expressions and aliases
SELECT col1, (col2 + col3) / 2 AS avg_val FROM tbl;

-- Alias shorthand (DuckDB extension: prefix alias)
SELECT x: 42, y: 'hello';      -- equivalent to SELECT 42 AS x, 'hello' AS y

-- DISTINCT — eliminate duplicates
SELECT DISTINCT city FROM weather;

-- DISTINCT ON — keep only the first row per unique key
SELECT DISTINCT ON (country) city, population
FROM cities
ORDER BY population DESC;

-- Exclude specific columns from *
SELECT * EXCLUDE (col1, col2) FROM tbl;

-- Replace specific columns in *
SELECT * REPLACE (col1 * 2 AS col1) FROM tbl;

-- COLUMNS() expression — apply the same expression to multiple columns
SELECT min(COLUMNS(*)) FROM tbl;
SELECT COLUMNS('.*_price') FROM products;

-- Star expression with regex
SELECT COLUMNS('^col[0-9]') FROM tbl;
```

---

## 2. FROM AND JOIN CLAUSES

### Basic FROM
```sql
-- Single table
SELECT * FROM tbl;

-- FROM-first syntax (DuckDB extension — SELECT is optional)
FROM tbl;
FROM tbl SELECT col1, col2;

-- Subquery in FROM
SELECT * FROM (SELECT col1 FROM tbl WHERE col2 > 0) sub;

-- Direct file query (no table needed)
SELECT * FROM 'data.csv';
SELECT * FROM 'data.parquet';
SELECT * FROM 'data.json';
SELECT * FROM 'my-data/part-*.parquet';   -- glob expansion

-- Table function in FROM
SELECT * FROM read_csv('file.csv');
SELECT * FROM read_parquet('file.parquet');
SELECT * FROM range(10);
SELECT * FROM generate_series(1, 100, 2);

-- WITH ORDINALITY (adds row number column)
SELECT * FROM read_csv('test.csv') WITH ORDINALITY;
```

### JOIN types
```sql
-- INNER JOIN (default)
SELECT * FROM t1 INNER JOIN t2 ON t1.id = t2.id;
SELECT * FROM t1 JOIN t2 ON t1.id = t2.id;

-- LEFT [OUTER] JOIN
SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.id;
SELECT * FROM t1 LEFT OUTER JOIN t2 ON t1.id = t2.id;

-- RIGHT [OUTER] JOIN
SELECT * FROM t1 RIGHT JOIN t2 ON t1.id = t2.id;

-- FULL [OUTER] JOIN
SELECT * FROM t1 FULL JOIN t2 ON t1.id = t2.id;

-- CROSS JOIN
SELECT * FROM t1 CROSS JOIN t2;

-- NATURAL JOIN (join on all identically-named columns)
SELECT * FROM t1 NATURAL JOIN t2;

-- JOIN ... USING (join on specific named columns)
SELECT * FROM t1 JOIN t2 USING (id);

-- SEMI JOIN (rows in t1 that have a match in t2)
SELECT * FROM t1 SEMI JOIN t2 USING (id);

-- ANTI JOIN (rows in t1 with no match in t2)
SELECT * FROM t1 ANTI JOIN t2 USING (id);

-- ASOF JOIN (match on nearest value — useful for time-series)
SELECT * FROM trades t ASOF JOIN prices p ON t.symbol = p.symbol AND t.when >= p.when;
SELECT * FROM trades t ASOF JOIN prices p USING (symbol, "when");
SELECT * FROM trades t ASOF LEFT JOIN prices p USING (symbol, "when");

-- LATERAL JOIN (subquery can reference outer FROM items)
SELECT * FROM t1, LATERAL (SELECT * FROM t2 WHERE t2.id = t1.id) sub;

-- POSITIONAL JOIN (join by row position, no key)
SELECT * FROM t1 POSITIONAL JOIN t2;

-- Self-join (aliases required)
SELECT a.*, b.* FROM t a JOIN t b ON a.id = b.parent_id;
```

---

## 3. WHERE CLAUSE

```sql
-- Basic comparison
SELECT * FROM tbl WHERE col = 'value';
SELECT * FROM tbl WHERE col > 100 AND col < 500;
SELECT * FROM tbl WHERE col IS NULL;
SELECT * FROM tbl WHERE col IS NOT NULL;

-- Boolean operators
SELECT * FROM tbl WHERE (a = 1 OR b = 2) AND c <> 3;
SELECT * FROM tbl WHERE NOT active;

-- IN / NOT IN
SELECT * FROM tbl WHERE col IN (1, 2, 3);
SELECT * FROM tbl WHERE col NOT IN (SELECT id FROM other);

-- BETWEEN
SELECT * FROM tbl WHERE col BETWEEN 10 AND 50;

-- LIKE / ILIKE (case-insensitive)
SELECT * FROM tbl WHERE name LIKE 'S%';
SELECT * FROM tbl WHERE name ILIKE 's%';

-- SIMILAR TO (regex-like POSIX patterns)
SELECT * FROM tbl WHERE name SIMILAR TO '(San|Los)%';

-- Regular expression match
SELECT * FROM tbl WHERE regexp_matches(name, '^San.*');

-- Subquery in WHERE
SELECT * FROM weather WHERE temp_lo = (SELECT max(temp_lo) FROM weather);

-- EXISTS
SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id);

-- ANY / ALL
SELECT * FROM tbl WHERE col > ANY (SELECT val FROM ref);
SELECT * FROM tbl WHERE col > ALL (SELECT val FROM ref);
```

---

## 4. GROUP BY AND AGGREGATION

### GROUP BY
```sql
-- Group by explicit columns
SELECT city, count(*) FROM weather GROUP BY city;

-- GROUP BY ALL (DuckDB extension — infers columns from SELECT)
SELECT city, street_name, avg(income) FROM addresses GROUP BY ALL;

-- GROUP BY column position (not recommended but valid)
SELECT city, count(*) FROM weather GROUP BY 1;

-- Column alias in GROUP BY (DuckDB extension)
SELECT strftime(date, '%Y') AS year, sum(amount) FROM sales GROUP BY year;
```

### GROUPING SETS / ROLLUP / CUBE
```sql
-- GROUPING SETS — compute aggregates for multiple groupings in one pass
SELECT city, street, sum(income)
FROM addresses
GROUP BY GROUPING SETS ((city, street), (city), ());

-- ROLLUP — hierarchical subtotals
SELECT year, month, sum(sales)
FROM data
GROUP BY ROLLUP (year, month);

-- CUBE — all combinations of groupings
SELECT a, b, sum(c)
FROM tbl
GROUP BY CUBE (a, b);

-- GROUPING() function — identifies which column is aggregated
SELECT a, b, sum(c), grouping(a) AS ga, grouping(b) AS gb
FROM tbl
GROUP BY CUBE (a, b);
```

### Aggregate Functions (common)
```sql
count(*)                  -- count all rows
count(col)                -- count non-null values
count(DISTINCT col)       -- count distinct values
sum(col)
avg(col)
min(col)
max(col)
median(col)
mode(col)
stddev(col)
variance(col)
first(col)                -- first value in group
last(col)                 -- last value in group
list(col)                 -- collect values into a list
string_agg(col, sep)      -- concatenate strings
bool_and(col)
bool_or(col)
percentile_cont(0.5) WITHIN GROUP (ORDER BY col)
percentile_disc(0.5) WITHIN GROUP (ORDER BY col)
quantile_cont(col, [0.25, 0.5, 0.75])
approx_count_distinct(col)
approx_quantile(col, 0.5)

-- Top-N aggregates (DuckDB extension)
max(col, n)               -- top-n maximum values
min(col, n)               -- top-n minimum values
arg_max(arg, val, n)      -- top-n rows by val, return arg
arg_min(arg, val, n)
max_by(arg, val, n)       -- alias for arg_max
min_by(arg, val, n)       -- alias for arg_min
```

---

## 5. HAVING CLAUSE

```sql
-- Filter groups after aggregation
SELECT city, max(temp_lo)
FROM weather
GROUP BY city
HAVING max(temp_lo) < 40;

-- Multiple conditions
SELECT department, avg(salary) AS avg_sal
FROM employees
GROUP BY department
HAVING avg(salary) > 50000 AND count(*) >= 5;

-- Column alias in HAVING (DuckDB extension)
SELECT city, avg(income) AS avg_income
FROM data
GROUP BY city
HAVING avg_income > 60000;
```

---

## 6. ORDER BY AND LIMIT

### ORDER BY
```sql
-- Ascending (default)
SELECT * FROM tbl ORDER BY col ASC;

-- Descending
SELECT * FROM tbl ORDER BY col DESC;

-- Multiple columns
SELECT * FROM tbl ORDER BY city ASC, temp_lo DESC;

-- NULL handling
SELECT * FROM tbl ORDER BY col NULLS FIRST;
SELECT * FROM tbl ORDER BY col NULLS LAST;

-- ORDER BY ALL (DuckDB extension — order by all columns)
SELECT * FROM tbl ORDER BY ALL;

-- Order by column position
SELECT city, temp_lo FROM tbl ORDER BY 1, 2;
```

### LIMIT and OFFSET
```sql
SELECT * FROM tbl LIMIT 10;
SELECT * FROM tbl LIMIT 10 OFFSET 20;

-- Percentage limit (DuckDB extension)
SELECT * FROM tbl LIMIT 10%;
```

---

## 7. WINDOW FUNCTIONS

### Syntax
```sql
function_name([args]) OVER (
    [PARTITION BY partition_expression, ...]
    [ORDER BY sort_expression [ASC | DESC], ...]
    [frame_clause]
)

-- frame_clause:
{ROWS | RANGE | GROUPS} BETWEEN frame_start AND frame_end

-- frame_start / frame_end values:
UNBOUNDED PRECEDING
n PRECEDING
CURRENT ROW
n FOLLOWING
UNBOUNDED FOLLOWING

-- EXCLUDE clause within frame:
[EXCLUDE {CURRENT ROW | GROUP | TIES | NO OTHERS}]
```

### Named WINDOW clause
```sql
SELECT col,
       sum(col) OVER w AS running_sum,
       avg(col) OVER w AS running_avg
FROM tbl
WINDOW w AS (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);
```

### Common window functions
```sql
-- Ranking
row_number() OVER (...)
rank() OVER (...)
dense_rank() OVER (...)
percent_rank() OVER (...)
cume_dist() OVER (...)
ntile(n) OVER (...)

-- Navigation
lag(col [, offset [, default]]) OVER (...)
lead(col [, offset [, default]]) OVER (...)
first_value(col) OVER (...)
last_value(col) OVER (...)
nth_value(col, n) OVER (...)

-- Aggregate used as window
sum(col)     OVER (PARTITION BY g ORDER BY t)
avg(col)     OVER (PARTITION BY g ORDER BY t)
count(col)   OVER (...)
min(col)     OVER (...)
max(col)     OVER (...)

-- RANGE frame with interval (time-series)
avg(val) OVER (
    PARTITION BY plant
    ORDER BY dt ASC
    RANGE BETWEEN INTERVAL 3 DAYS PRECEDING
              AND INTERVAL 3 DAYS FOLLOWING
)

-- GROUPS frame
avg(val) OVER (ORDER BY dt GROUPS BETWEEN 3 PRECEDING AND 3 FOLLOWING)
```

### Examples
```sql
-- Row number per partition
SELECT plant, dt,
       row_number() OVER (PARTITION BY plant ORDER BY dt) AS rn
FROM generation;

-- 7-day moving average
SELECT plant, dt,
       avg(mwh) OVER (
           PARTITION BY plant
           ORDER BY dt
           RANGE BETWEEN INTERVAL 3 DAYS PRECEDING
                     AND INTERVAL 3 DAYS FOLLOWING
       ) AS moving_avg
FROM generation;

-- Running sum
SELECT id, amount,
       sum(amount) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS running_total
FROM transactions;

-- Percentile box-plot data
SELECT plant, dt,
       min(mwh) OVER seven     AS min_7d,
       quantile_cont(mwh, [0.25,0.5,0.75]) OVER seven AS iqr_7d,
       max(mwh) OVER seven     AS max_7d
FROM generation
WINDOW seven AS (PARTITION BY plant ORDER BY dt RANGE BETWEEN INTERVAL 3 DAYS PRECEDING AND INTERVAL 3 DAYS FOLLOWING);
```

---

## 8. QUALIFY CLAUSE

The QUALIFY clause filters results of window functions (analogous to HAVING for aggregates). It avoids the need for a subquery.

```sql
-- Keep only the top-2 functions per schema (using QUALIFY)
SELECT schema_name, function_name,
       row_number() OVER (PARTITION BY schema_name ORDER BY function_name) AS rnk
FROM duckdb_functions()
QUALIFY rnk < 3;

-- Equivalent using WITH (without QUALIFY)
WITH ranked AS (
    SELECT schema_name, function_name,
           row_number() OVER (PARTITION BY schema_name ORDER BY function_name) AS rnk
    FROM duckdb_functions()
)
SELECT * FROM ranked WHERE rnk < 3;

-- Directly reference window function in QUALIFY
SELECT *, row_number() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn
FROM employees
QUALIFY rn = 1;
```

---

## 9. WITH (COMMON TABLE EXPRESSIONS)

```sql
-- Basic CTE
WITH cte AS (
    SELECT city, avg(temp_lo) AS avg_temp
    FROM weather
    GROUP BY city
)
SELECT * FROM cte WHERE avg_temp > 40;

-- Multiple CTEs
WITH
  a AS (SELECT ...),
  b AS (SELECT ... FROM a)
SELECT * FROM b;

-- Recursive CTE
WITH RECURSIVE hierarchy AS (
    -- Anchor: base case
    SELECT id, parent_id, name, 0 AS depth
    FROM nodes
    WHERE parent_id IS NULL

    UNION ALL

    -- Recursive: join back to itself
    SELECT n.id, n.parent_id, n.name, h.depth + 1
    FROM nodes n
    JOIN hierarchy h ON n.parent_id = h.id
)
SELECT * FROM hierarchy ORDER BY depth;

-- CTE as materialized hint
WITH cte AS MATERIALIZED (SELECT ...)
SELECT * FROM cte;

WITH cte AS NOT MATERIALIZED (SELECT ...)
SELECT * FROM cte;
```

---

## 10. SET OPERATIONS

```sql
-- UNION (distinct rows)
SELECT city FROM weather
UNION
SELECT city FROM cities;

-- UNION ALL (all rows, including duplicates)
SELECT * FROM range(2) t1(x)
UNION ALL
SELECT * FROM range(3) t2(x);

-- UNION BY NAME (DuckDB extension — join by column name, not position)
SELECT a, b FROM t1
UNION BY NAME
SELECT b, c FROM t2;     -- columns matched by name; missing columns get NULL

-- UNION ALL BY NAME
SELECT a, b FROM t1
UNION ALL BY NAME
SELECT b, c FROM t2;

-- INTERSECT (rows appearing in both)
SELECT city FROM weather
INTERSECT
SELECT city FROM cities;

-- INTERSECT ALL
SELECT * FROM t1
INTERSECT ALL
SELECT * FROM t2;

-- EXCEPT (rows in left but not in right)
SELECT city FROM weather
EXCEPT
SELECT city FROM cities;

-- EXCEPT ALL
SELECT * FROM t1
EXCEPT ALL
SELECT * FROM t2;
```

---

## 11. FILTER CLAUSE

The FILTER clause restricts which rows are passed to an aggregate function (localized WHERE for aggregates).

```sql
-- Basic FILTER
SELECT
    count(*) FILTER (year = 2023) AS cnt_2023,
    count(*) FILTER (year = 2024) AS cnt_2024
FROM data;

-- Multiple aggregates with different filters
SELECT
    sum(i)    FILTER (i <= 5)           AS lte_five_sum,
    median(i) FILTER (i % 2 = 1)        AS odds_median,
    median(i) FILTER (i % 2 = 1 AND i <= 5) AS odds_lte_five_median
FROM generate_series(1, 10) tbl(i);

-- Pivot pattern using FILTER
SELECT
    count(*) FILTER (region = 'East')  AS east,
    count(*) FILTER (region = 'West')  AS west,
    count(*) FILTER (region = 'North') AS north
FROM sales;

-- FILTER with window function
SELECT col,
       sum(col) FILTER (col > 0) OVER (ORDER BY id) AS positive_running_sum
FROM tbl;
```

---

## 12. SAMPLE CLAUSE

```sql
-- Default (Bernoulli, row-level)
SELECT * FROM tbl USING SAMPLE 10%;
SELECT * FROM tbl USING SAMPLE 1000 ROWS;

-- Specify sampling method
SELECT * FROM tbl USING SAMPLE reservoir(50 ROWS) REPEATABLE (42);
SELECT * FROM tbl USING SAMPLE bernoulli(10%);
SELECT * FROM tbl USING SAMPLE system(10%);

-- SAMPLE applied after FROM, before WHERE
SELECT * FROM tbl USING SAMPLE 10% WHERE col > 0;
```

---

## 13. VALUES CLAUSE

```sql
-- Standalone VALUES
VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');

-- VALUES in FROM
SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name);

-- VALUES in INSERT
INSERT INTO tbl VALUES (1, 'Alice'), (2, 'Bob');

-- VALUES in JOIN
SELECT * FROM t1 NATURAL JOIN (VALUES (2), (4)) _(x);
```

---

## 14. PREPARED STATEMENTS

```sql
-- Create prepared statement
PREPARE my_stmt AS
    SELECT * FROM tbl WHERE id = $1 AND status = $2;

-- Execute with positional parameters
EXECUTE my_stmt(42, 'active');

-- Named parameters
PREPARE by_city AS
    SELECT * FROM weather WHERE city = $city;
EXECUTE by_city(city := 'San Francisco');

-- With query_table function
PREPARE select_from AS SELECT * FROM query_table($1);
EXECUTE select_from('my_table');

-- Deallocate
DEALLOCATE my_stmt;
```

---

## 15. DDL STATEMENTS

### CREATE TABLE
```sql
-- Basic table creation
CREATE TABLE weather (
    city     VARCHAR,
    temp_lo  INTEGER,
    temp_hi  INTEGER,
    prcp     FLOAT,
    date     DATE
);

-- With constraints
CREATE TABLE employees (
    id         INTEGER PRIMARY KEY,
    name       VARCHAR NOT NULL,
    email      VARCHAR UNIQUE,
    dept_id    INTEGER REFERENCES departments(id),
    salary     DECIMAL CHECK (salary > 0),
    created_at TIMESTAMP DEFAULT current_timestamp
);

-- IF NOT EXISTS
CREATE TABLE IF NOT EXISTS tbl (i INTEGER, j INTEGER);

-- OR REPLACE
CREATE OR REPLACE TABLE tbl (i INTEGER, j INTEGER);

-- CREATE TABLE AS SELECT (CTAS)
CREATE TABLE summary AS SELECT city, avg(temp_lo) FROM weather GROUP BY city;
CREATE TABLE t1 AS SELECT 42 AS i, 84 AS j;

-- CTAS from file
CREATE TABLE flights AS FROM 'https://duckdb.org/data/flights.csv';
CREATE TABLE t1 AS SELECT * FROM read_csv('path/file.csv');

-- Copy schema only (no data)
CREATE TABLE t1 AS FROM t2 LIMIT 0;
CREATE TABLE t1 AS FROM t2 WITH NO DATA;

-- Temporary table (session-scoped)
CREATE TEMP TABLE tmp (i INTEGER);
CREATE TEMPORARY TABLE tmp (i INTEGER);

-- Generated (computed) column
CREATE TABLE t (
    price    DECIMAL,
    quantity INTEGER,
    total    DECIMAL GENERATED ALWAYS AS (price * quantity) VIRTUAL
);

-- Partitioned / struct columns
CREATE TABLE sensor (
    ts      TIMESTAMP,
    reading STRUCT(val DOUBLE, unit VARCHAR)
);
```

### ALTER TABLE
```sql
-- Add column
ALTER TABLE tbl ADD COLUMN new_col INTEGER;
ALTER TABLE tbl ADD COLUMN new_col INTEGER DEFAULT 0;

-- Drop column
ALTER TABLE tbl DROP COLUMN old_col;

-- Rename column
ALTER TABLE tbl RENAME COLUMN old_name TO new_name;

-- Rename table
ALTER TABLE old_name RENAME TO new_name;

-- Change column type
ALTER TABLE tbl ALTER COLUMN col TYPE VARCHAR;

-- Set / drop default
ALTER TABLE tbl ALTER COLUMN col SET DEFAULT 0;
ALTER TABLE tbl ALTER COLUMN col DROP DEFAULT;

-- Set / drop NOT NULL
ALTER TABLE tbl ALTER COLUMN col SET NOT NULL;
ALTER TABLE tbl ALTER COLUMN col DROP NOT NULL;

-- Add / drop primary key
ALTER TABLE tbl ADD PRIMARY KEY (id);
ALTER TABLE tbl DROP CONSTRAINT constraint_name;
```

### DROP
```sql
DROP TABLE tbl;
DROP TABLE IF EXISTS tbl;
DROP TABLE IF EXISTS tbl CASCADE;

DROP VIEW view_name;
DROP VIEW IF EXISTS view_name;

DROP INDEX idx_name;
DROP SCHEMA schema_name;
DROP SCHEMA IF EXISTS schema_name CASCADE;
DROP TYPE type_name;
DROP SEQUENCE seq_name;
DROP MACRO macro_name;
```

### CREATE VIEW
```sql
CREATE VIEW v AS
    SELECT city, avg(temp_lo) AS avg_temp FROM weather GROUP BY city;

CREATE OR REPLACE VIEW v AS SELECT ...;

-- View with explicit column names
CREATE VIEW v(col1, col2) AS SELECT a, b FROM tbl;
```

### CREATE INDEX
```sql
CREATE INDEX idx_name ON tbl (col);
CREATE UNIQUE INDEX idx_name ON tbl (col);
CREATE INDEX idx_multi ON tbl (col1, col2);
CREATE INDEX IF NOT EXISTS idx_name ON tbl (col);
```

### CREATE SCHEMA
```sql
CREATE SCHEMA my_schema;
CREATE SCHEMA IF NOT EXISTS my_schema;
```

### CREATE SEQUENCE
```sql
CREATE SEQUENCE seq_name START 1 INCREMENT 1;
SELECT nextval('seq_name');
```

### CREATE TYPE (Enum)
```sql
CREATE TYPE mood AS ENUM ('happy', 'sad', 'neutral');
CREATE TABLE survey (id INTEGER, feeling mood);
INSERT INTO survey VALUES (1, 'happy');
```

### CREATE MACRO
```sql
-- Scalar macro
CREATE MACRO add(a, b) AS a + b;
SELECT add(1, 2);

-- Table macro
CREATE MACRO top_n(tbl, n) AS TABLE
    SELECT * FROM query_table(tbl) LIMIT n;
SELECT * FROM top_n('employees', 5);
```

### ATTACH / DETACH
```sql
ATTACH 'mydb.duckdb' AS mydb;
ATTACH 'mydb.duckdb' AS mydb (READ_ONLY);
DETACH mydb;

-- Copy between databases
COPY FROM DATABASE db1 TO db2;
COPY FROM DATABASE db1 TO db2 SCHEMA;   -- schema only
```

---

## 16. DML STATEMENTS

### INSERT
```sql
-- By position
INSERT INTO tbl VALUES (1, 'Alice');
INSERT INTO tbl VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');

-- By column name (explicit)
INSERT INTO weather (city, temp_lo, temp_hi, prcp, date)
VALUES ('San Francisco', 43, 57, 0.0, '1994-11-29');

-- BY NAME (DuckDB extension — column names instead of positions)
INSERT INTO tbl BY NAME SELECT 42 AS i, 'hello' AS name;

-- From SELECT
INSERT INTO tbl SELECT * FROM other_tbl;
INSERT INTO tbl SELECT * FROM other_tbl WHERE active = true;

-- With default values
INSERT INTO tbl (i) VALUES (1), (DEFAULT), (3);

-- ON CONFLICT (upsert)
INSERT INTO tbl VALUES (1, 84)
ON CONFLICT DO NOTHING;

INSERT INTO tbl VALUES (1, 84)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO tbl VALUES (1, 84)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value
WHERE EXCLUDED.value > tbl.value;

-- Short forms (DuckDB extension)
INSERT OR IGNORE INTO tbl VALUES (1, 84);
INSERT OR REPLACE INTO tbl VALUES (1, 84);
```

### UPDATE
```sql
-- Basic update
UPDATE weather
SET temp_hi = temp_hi - 2, temp_lo = temp_lo - 2
WHERE date > '1994-11-28';

-- Set to NULL
UPDATE tbl SET col = NULL WHERE condition;

-- Update from another table (FROM clause)
UPDATE original
SET value = new.value
FROM new
WHERE original.key = new.key;

-- Update from subquery
UPDATE original AS true_orig
SET value = (
    SELECT new.value || ' (updated)' FROM original AS new
    WHERE true_orig.key = new.key
);
```

### DELETE
```sql
-- Delete with condition
DELETE FROM weather WHERE city = 'Hayward';

-- Delete all rows
DELETE FROM tbl;

-- Delete using JOIN / subquery
DELETE FROM tbl WHERE id IN (SELECT id FROM to_remove);
```

### MERGE INTO (Upsert / SCD)
```sql
MERGE INTO target AS t
USING source AS s ON t.id = s.id
WHEN MATCHED THEN
    UPDATE SET t.value = s.value
WHEN NOT MATCHED THEN
    INSERT (id, value) VALUES (s.id, s.value)
WHEN NOT MATCHED BY SOURCE THEN
    DELETE;
```

---

## 17. COPY STATEMENT

### COPY FROM (import)
```sql
-- Auto-detect CSV
COPY lineitem FROM 'lineitem.csv';

-- CSV with options
COPY lineitem FROM 'lineitem.csv' (DELIMITER '|');
COPY lineitem FROM 'lineitem.csv' (HEADER true, DELIMITER ',', QUOTE '"');

-- Parquet
COPY lineitem FROM 'lineitem.pq' (FORMAT parquet);

-- JSON
COPY lineitem FROM 'lineitem.json' (FORMAT json, AUTO_DETECT true);

-- Specific columns only
COPY tbl (col1, col2) FROM 'file.csv';
```

### COPY TO (export)
```sql
-- Export to CSV
COPY tbl TO 'output.csv' (HEADER, DELIMITER ',');

-- Export to Parquet
COPY tbl TO 'output.parquet' (FORMAT parquet);

-- Export query result
COPY (SELECT * FROM tbl WHERE active = true) TO 'active.csv';

-- Partitioned write
COPY tbl TO 'output_dir' (FORMAT parquet, PARTITION_BY (year, month));
```

### EXPORT / IMPORT DATABASE
```sql
EXPORT DATABASE 'backup_dir';
EXPORT DATABASE 'backup_dir' (FORMAT parquet);
IMPORT DATABASE 'backup_dir';
```

---

## 18. PIVOT AND UNPIVOT

### PIVOT (rows to columns)
```sql
-- Basic PIVOT
PIVOT sales
ON region
USING sum(amount);

-- PIVOT with GROUP BY
PIVOT sales
ON region IN ('East', 'West', 'North')
USING sum(amount)
GROUP BY year;

-- PIVOT with multiple aggregates
PIVOT sales
ON year
USING sum(amount) AS total, count(*) AS cnt
GROUP BY region;
```

### UNPIVOT (columns to rows)
```sql
-- Basic UNPIVOT
UNPIVOT wide_table
ON (east, west, north)
INTO NAME region VALUE amount;

-- UNPIVOT with INCLUDE NULLS
UNPIVOT wide_table
ON (col1, col2, col3)
INTO NAME attr VALUE val
INCLUDE NULLS;
```

---

## 19. UTILITY STATEMENTS

### DESCRIBE and SUMMARIZE
```sql
-- Describe table schema
DESCRIBE tbl;
DESCRIBE SELECT * FROM tbl;

-- Summary statistics for all columns
SUMMARIZE tbl;
SUMMARIZE SELECT * FROM tbl WHERE condition;
```

### SHOW
```sql
SHOW TABLES;
SHOW DATABASES;
SHOW ALL TABLES;        -- includes schemas
SHOW SCHEMAS;
SHOW VIEWS;
```

### ANALYZE
```sql
ANALYZE;                 -- update statistics for all tables
ANALYZE tbl;
```

### EXPLAIN
```sql
EXPLAIN SELECT * FROM tbl WHERE id = 1;
EXPLAIN ANALYZE SELECT * FROM tbl WHERE id = 1;
```

### CHECKPOINT
```sql
CHECKPOINT;
FORCE CHECKPOINT;
```

### VACUUM
```sql
VACUUM;
VACUUM tbl;
```

### Transaction Management
```sql
BEGIN;
BEGIN TRANSACTION;
COMMIT;
ROLLBACK;
SAVEPOINT sp1;
ROLLBACK TO SAVEPOINT sp1;
RELEASE SAVEPOINT sp1;
```

### SET / RESET
```sql
SET threads = 4;
SET memory_limit = '8GB';
SET enable_progress_bar = true;
RESET threads;
RESET ALL;
```

### SET VARIABLE
```sql
SET VARIABLE my_var = 42;
SELECT getvariable('my_var');
```

### LOAD / INSTALL Extensions
```sql
INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;
```

### CALL
```sql
CALL pragma_database_list();
```

### COMMENT ON
```sql
COMMENT ON TABLE tbl IS 'This is a description';
COMMENT ON COLUMN tbl.col IS 'Column description';
```

### USE
```sql
USE my_schema;
USE my_database.my_schema;
```

---

## 20. DUCKDB "FRIENDLY SQL" EXTENSIONS

DuckDB introduces many SQL convenience features not found in standard SQL.

### FROM-first syntax
```sql
-- No SELECT needed — returns all columns
FROM tbl;
FROM tbl WHERE col > 0;
FROM tbl SELECT col1, col2;
```

### GROUP BY ALL
```sql
-- Automatically groups by all non-aggregate SELECT columns
SELECT city, street, avg(income) FROM addresses GROUP BY ALL;
```

### ORDER BY ALL
```sql
SELECT * FROM tbl ORDER BY ALL;
```

### SELECT * EXCLUDE
```sql
SELECT * EXCLUDE (secret_col, internal_id) FROM tbl;
```

### SELECT * REPLACE
```sql
SELECT * REPLACE (price * 1.1 AS price) FROM products;
```

### UNION BY NAME
```sql
SELECT a, b FROM t1
UNION BY NAME
SELECT b, c FROM t2;
```

### Prefix aliases
```sql
SELECT x: 42, y: 'hello', z: current_date;
```

### Lateral column aliases
```sql
SELECT i + 1 AS j, j + 2 AS k FROM range(0, 3) t(i);
```

### Trailing commas
```sql
SELECT
    42 AS x,
    ['a', 'b', 'c',] AS y,
    'hello' AS z,     -- trailing comma is valid
;
```

### LIMIT with percentage
```sql
SELECT * FROM tbl LIMIT 10%;
```

### Globbing and direct file reading
```sql
SELECT * FROM 'data/*.parquet';
SELECT * FROM 'logs/2024-*.csv';
FROM 'https://example.com/data.parquet';
```

### Dot operator for function chaining
```sql
SELECT name.upper() FROM tbl;
SELECT name.replace('a', 'b').upper() FROM tbl;
SELECT ('hello world').split(' ');
```

### String format functions
```sql
SELECT format('Hello, {}!', name) FROM tbl;
SELECT printf('Value: %d', 42);
```

### List comprehensions
```sql
SELECT [x + 1 FOR x IN [1, 2, 3]];
SELECT [x FOR x IN col IF x > 0] FROM tbl;
```

### List slicing
```sql
SELECT arr[1:3] FROM tbl;
SELECT arr[-1] FROM tbl;    -- last element
SELECT arr[2:] FROM tbl;    -- from index 2 onward
```

### STRUCT dot notation
```sql
SELECT s.field1, s.* FROM tbl;
```

### COLUMNS() expression
```sql
-- Apply expression to multiple columns
SELECT min(COLUMNS(*)) FROM tbl;
SELECT COLUMNS('.*_price') * 1.1 FROM products;

-- With lambda
SELECT COLUMNS(c -> c LIKE '%price%') FROM products;
```

### INSERT INTO … BY NAME
```sql
INSERT INTO tbl BY NAME
SELECT 42 AS col2, 'hello' AS col1;
```

### CREATE OR REPLACE TABLE
```sql
CREATE OR REPLACE TABLE tbl AS SELECT * FROM source;
```

### query() and query_table() Functions
```sql
SELECT * FROM query_table('my_table');
SELECT * FROM query('SELECT * FROM my_table WHERE id > 10');

-- Dynamic table name in prepared statement
PREPARE q AS SELECT * FROM query_table($1);
EXECUTE q('employees');
```

---

## 21. EXPRESSIONS AND OPERATORS

### CASE Expression
```sql
-- Simple CASE
SELECT CASE status
    WHEN 'A' THEN 'Active'
    WHEN 'I' THEN 'Inactive'
    ELSE 'Unknown'
END FROM tbl;

-- Searched CASE
SELECT CASE
    WHEN score >= 90 THEN 'A'
    WHEN score >= 80 THEN 'B'
    WHEN score >= 70 THEN 'C'
    ELSE 'F'
END AS grade FROM students;
```

### Subqueries
```sql
-- Scalar subquery
SELECT city FROM weather
WHERE temp_lo = (SELECT max(temp_lo) FROM weather);

-- EXISTS subquery
SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id);

-- IN subquery
SELECT * FROM tbl WHERE id IN (SELECT id FROM active_users);

-- Correlated subquery
SELECT e.name,
       (SELECT avg(salary) FROM employees WHERE dept_id = e.dept_id) AS dept_avg
FROM employees e;
```

### Casting
```sql
-- CAST function
SELECT CAST(col AS INTEGER) FROM tbl;
SELECT CAST('2024-01-01' AS DATE);

-- :: shorthand (PostgreSQL-style)
SELECT col::INTEGER FROM tbl;
SELECT '2024-01-01'::DATE;
SELECT '{"key": "val"}'::JSON;

-- TRY_CAST (returns NULL on failure instead of error)
SELECT TRY_CAST(col AS INTEGER) FROM tbl;

-- TRY expression wrapper
SELECT TRY(col::INTEGER) FROM tbl;
```

### Comparison operators
```sql
=   !=   <>   <   >   <=   >=
IS NULL         IS NOT NULL
IS TRUE         IS NOT TRUE
IS FALSE        IS NOT FALSE
BETWEEN x AND y
NOT BETWEEN x AND y
IN (val1, val2, ...)
NOT IN (val1, val2, ...)
LIKE pattern    NOT LIKE pattern
ILIKE pattern   NOT ILIKE pattern
SIMILAR TO regex
~  (regex match)
!~ (regex not match)
~~  (LIKE)
!~~ (NOT LIKE)
```

### Logical operators
```sql
AND
OR
NOT
XOR
```

### IN operator
```sql
SELECT * FROM tbl WHERE col IN (1, 2, 3);
SELECT * FROM tbl WHERE col IN (SELECT id FROM ref);
SELECT * FROM tbl WHERE (col1, col2) IN (SELECT a, b FROM ref);  -- row constructor
```

### Star Expression (column selection)
```sql
SELECT * FROM tbl;
SELECT * EXCLUDE (col1) FROM tbl;
SELECT * REPLACE (expr AS col) FROM tbl;
SELECT COLUMNS('regex') FROM tbl;
SELECT COLUMNS(lambda) FROM tbl;
SELECT t1.*, t2.col FROM t1 JOIN t2 ON t1.id = t2.id;
```

### Collations
```sql
SELECT * FROM tbl ORDER BY name COLLATE nocase;
SELECT * FROM tbl ORDER BY name COLLATE de;   -- German locale
```

---

## 22. DATA TYPES

| Category   | Types |
|-----------|-------|
| Integer   | TINYINT (INT1), SMALLINT (INT2), INTEGER (INT4), BIGINT (INT8), HUGEINT, UBIGINT, UINTEGER, USMALLINT, UTINYINT |
| Float     | FLOAT (REAL, FLOAT4), DOUBLE (FLOAT8) |
| Decimal   | DECIMAL(p,s), NUMERIC(p,s) |
| Boolean   | BOOLEAN (BOOL) |
| Text      | VARCHAR, CHAR(n), TEXT, STRING |
| Blob      | BLOB, BYTEA |
| Date/Time | DATE, TIME, TIMESTAMP, TIMESTAMP WITH TIME ZONE (TIMESTAMPTZ), INTERVAL |
| Complex   | LIST, ARRAY(type, n), STRUCT, MAP, UNION |
| Other     | JSON, UUID, BIT (BITSTRING), ENUM |

```sql
-- Creating complex type columns
CREATE TABLE tbl (
    id        INTEGER,
    tags      INTEGER[],              -- array
    tags2     VARCHAR[3],             -- fixed-size array
    data      STRUCT(x INT, y INT),   -- struct
    meta      MAP(VARCHAR, INTEGER),  -- map
    options   UNION(num INT, str VARCHAR)
);

-- Interval literals
INTERVAL '1' DAY
INTERVAL '2 hours 30 minutes'
INTERVAL 3 MONTHS

-- Typecasting
SELECT col::BIGINT, col::VARCHAR, col::DATE FROM tbl;

-- NULL literal
SELECT NULL::INTEGER;
```

---

## 23. FUNCTIONS OVERVIEW

### String Functions
```sql
length(s)                   -- character length
len(s)                      -- alias
lower(s)                    -- lowercase
upper(s)                    -- uppercase
trim(s)                     -- remove whitespace
ltrim(s)   rtrim(s)
substring(s, start, len)
s[start:end]                -- slice notation
substr(s, start, len)
replace(s, from, to)
regexp_replace(s, pattern, replacement)
regexp_extract(s, pattern [, group])
regexp_matches(s, pattern)  -- boolean match
split(s, sep)               -- returns list
string_split(s, sep)
concat(s1, s2, ...)
s1 || s2                    -- concatenation operator
format('{} {}', a, b)       -- fmt-style formatter
printf('%s %d', s, n)       -- C-style formatter
like_escape(s, pattern, esc)
starts_with(s, prefix)
ends_with(s, suffix)
contains(s, substr)
position(substr IN s)
strpos(s, substr)
ascii(s)
chr(n)
repeat(s, n)
reverse(s)
lpad(s, n, fill)
rpad(s, n, fill)
md5(s)
sha256(s)
encode(s)
decode(s)
to_base64(s)
from_base64(s)
```

### Numeric Functions
```sql
abs(x)            ceil(x)         floor(x)
round(x [, n])    trunc(x)        sign(x)
sqrt(x)           cbrt(x)         power(x, y)  x^y
exp(x)            ln(x)           log(x)       log2(x)
sin(x)  cos(x)  tan(x)  asin(x)  acos(x)  atan(x)  atan2(y,x)
degrees(x)        radians(x)      pi()
mod(x, y)         x % y
greatest(a, b)    least(a, b)
random()          setseed(s)
```

### Date / Time Functions
```sql
current_date                   -- today's date
current_time                   -- current time
current_timestamp  now()       -- current timestamp
today()                        -- alias for current_date
yesterday()

date_part('year', ts)          -- extract part
extract(year FROM ts)
year(ts)  month(ts)  day(ts)  hour(ts)  minute(ts)  second(ts)

date_trunc('month', ts)
date_add(ts, INTERVAL '1' DAY)
datesub('day', ts1, ts2)
datediff('day', ts1, ts2)
age(ts)
age(ts1, ts2)
epoch(ts)
to_timestamp(epoch)
strftime(ts, format)
strptime(str, format)
make_date(year, month, day)
make_timestamp(year, month, day, hour, min, sec)
```

### List / Array Functions
```sql
list_value(1, 2, 3)            -- create list
[1, 2, 3]                      -- list literal
len(lst)  length(lst)
list_extract(lst, i)  lst[i]
list_slice(lst, start, end)
list_contains(lst, val)
list_position(lst, val)
list_unique(lst)
list_sort(lst)
list_reverse_sort(lst)
list_concat(lst1, lst2)  lst1 || lst2
list_append(lst, val)
list_prepend(val, lst)
list_filter(lst, x -> x > 0)   -- lambda
list_transform(lst, x -> x*2)  -- lambda
list_reduce(lst, (acc, x) -> acc + x)
list_apply(lst, lambda)
flatten(lst_of_lst)
unnest(lst)                    -- expand list to rows
range(start, stop, step)
generate_series(start, stop, step)
array_to_string(lst, sep)
string_to_array(s, sep)
```

### Struct Functions
```sql
struct_pack(x := 1, y := 2)     -- create struct
{'x': 1, 'y': 2}                -- struct literal
struct_extract(s, 'field')
s.field                          -- dot access
struct_insert(s, new_field := val)
row(a, b, c)                     -- row constructor
```

### JSON Functions
```sql
json(s)                         -- parse to JSON
json_extract(j, '$.key')
j -> '$.key'                    -- extract (returns JSON)
j ->> '$.key'                   -- extract (returns text)
json_extract_string(j, path)
json_keys(j)
json_array_length(j)
json_type(j)
json_valid(j)
to_json(val)
json_object(k1, v1, k2, v2)
json_array(v1, v2, v3)
json_group_array(col)           -- aggregate
json_group_object(key, val)     -- aggregate
read_json('file.json')
```

### Aggregate Functions Reference
```sql
count(*)  count(col)  count(DISTINCT col)
sum(col)  avg(col)  min(col)  max(col)
median(col)
mode(col)
stddev(col)  stddev_pop(col)  stddev_samp(col)
variance(col)  var_pop(col)  var_samp(col)
corr(x, y)
covar_pop(x, y)  covar_samp(x, y)
regr_slope(y, x)  regr_intercept(y, x)
first(col [ORDER BY ...])
last(col [ORDER BY ...])
list(col [ORDER BY ...])
string_agg(col, sep [ORDER BY ...])
group_concat(col, sep)         -- alias
bool_and(col)  bool_or(col)  any(col)  every(col)
bit_and(col)  bit_or(col)  bit_xor(col)
histogram(col)
entropy(col)
kurtosis(col)
skewness(col)
quantile_cont(col, q)          -- q in [0,1]
quantile_disc(col, q)
reservoir_quantile(col, q)
approx_count_distinct(col)
approx_quantile(col, q)
max(col, n)                    -- top-n list
min(col, n)
arg_max(arg, val, n)
arg_min(arg, val, n)
fsum(col)                      -- Kahan summation
product(col)
sum_no_overflow(col)
```

### Window Functions Reference
```sql
-- Ranking
row_number()
rank()
dense_rank()
percent_rank()
cume_dist()
ntile(n)

-- Value
first_value(col)
last_value(col)
nth_value(col, n)
lag(col [, offset [, default]])
lead(col [, offset [, default]])

-- All aggregate functions can also be used as window functions
sum(col) OVER (...)
avg(col) OVER (...)
count(col) OVER (...)
min(col) OVER (...)
max(col) OVER (...)
```

### Utility / Meta Functions
```sql
typeof(expr)                   -- returns data type name
pg_typeof(expr)                -- alias
nullif(a, b)                   -- returns NULL if a = b
ifnull(a, b)                   -- returns b if a is NULL
coalesce(a, b, c, ...)         -- returns first non-null
if(cond, then, else)
iff(cond, then, else)          -- alias
isnan(x)  isinf(x)  isfinite(x)
current_setting('param')
version()
uuid()
gen_random_uuid()

-- DuckDB meta functions
duckdb_tables()
duckdb_views()
duckdb_columns()
duckdb_schemas()
duckdb_databases()
duckdb_indexes()
duckdb_functions()
duckdb_settings()
duckdb_extensions()
duckdb_types()
```

---

## APPENDIX: QUERY EXECUTION ORDER

SQL clauses are logically executed in this order (different from the written order):

1. `FROM` / `JOIN`
2. `WHERE`
3. `GROUP BY`
4. `HAVING`
5. `WINDOW`
6. `SELECT`
7. `QUALIFY`
8. `DISTINCT`
9. `ORDER BY`
10. `LIMIT` / `OFFSET`

The `SAMPLE` clause is applied immediately after `FROM` (before `WHERE`).

---

## APPENDIX: DUCKDB VS STANDARD SQL

| Feature | DuckDB Extension | Standard SQL |
|--------|-----------------|--------------|
| FROM-first syntax | ✅ | ❌ |
| GROUP BY ALL | ✅ | ❌ |
| ORDER BY ALL | ✅ | ❌ |
| SELECT * EXCLUDE | ✅ | ❌ |
| SELECT * REPLACE | ✅ | ❌ |
| UNION BY NAME | ✅ | ❌ |
| Prefix aliases (x: expr) | ✅ | ❌ |
| Lateral column aliases | ✅ | ❌ |
| QUALIFY clause | ✅ | ❌ |
| ASOF JOIN | ✅ | ❌ |
| POSITIONAL JOIN | ✅ | ❌ |
| LIMIT n% | ✅ | ❌ |
| Trailing commas | ✅ | ❌ |
| List comprehensions | ✅ | ❌ |
| Direct file reads | ✅ | ❌ |
| :: cast shorthand | PostgreSQL-compat | ❌ |
| RECURSIVE CTE | ✅ | ✅ |
| WINDOW functions | ✅ | ✅ |
| PIVOT / UNPIVOT | ✅ | ❌ (non-standard) |
| MERGE INTO | ✅ | ✅ |

---

*Document generated from DuckDB official documentation (duckdb.org/docs/stable). Last updated: 2026.*
