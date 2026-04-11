# New Relic Provider — NRQL Response Types

This document covers all NRQL result shapes returned by NerdGraph, how to detect them, and which frontend component renders each type.

## NerdGraph Query Structure

All NRQL queries are executed via NerdGraph's GraphQL API:

```graphql
{
  actor {
    account(id: ACCOUNT_ID) {
      nrql(query: "SELECT count(*) FROM Transaction") {
        results
      }
    }
  }
}
```

The `results` array is extracted and passed to the frontend as `data` in tool call results. The shape of each row in `results[]` varies by query clauses.

## NRQL Clauses

| Clause | Key Syntax | Notes |
|--------|-----------|-------|
| `SELECT` | `SELECT attr \| function(attr) [AS 'label']` | Required |
| `FROM` | `FROM EventType [, EventType2]` | Required, supports multiple event types |
| `WHERE` | `WHERE attr op value [AND\|OR ...]` | `=`, `!=`, `<`, `>`, `LIKE`, `IN`, `IS NULL`, `IS NOT NULL` |
| `AS` | `... AS 'label'` | Alias for attributes or functions |
| `FACET` | `FACET attr [, attr2, ...]` | Groups results (max 5 attrs). Default LIMIT 10 |
| `FACET CASES` | `FACET CASES (WHERE cond AS 'label', ...)` | Custom conditional buckets |
| `LIMIT` | `LIMIT n` | Default: 10 (FACET), 100 (SELECT *). Max: 5000 |
| `OFFSET` | `LIMIT n OFFSET m` | Skip rows. Non-aggregation only |
| `ORDER BY` | `ORDER BY attr [ASC\|DESC]` | Non-aggregation queries only |
| `SINCE` | `SINCE time_expr` | `1 hour ago`, `2024-01-15`, `yesterday` |
| `UNTIL` | `UNTIL time_expr` | Defaults to NOW |
| `COMPARE WITH` | `COMPARE WITH time_expr` | Adds `comparison` field to results |
| `TIMESERIES` | `TIMESERIES [interval \| AUTO \| MAX]` | Time-bucketed data. AUTO picks bucket size |
| `SLIDE BY` | `TIMESERIES interval SLIDE BY step` | Overlapping sliding windows |
| `EXTRAPOLATE` | `... EXTRAPOLATE` | Compensates APM sampling |
| `WITH TIMEZONE` | `WITH TIMEZONE 'tz_name'` | IANA timezone names |
| `WITH ... AS` | `WITH fn(attr) AS x SELECT ...` | NRQL variables |
| `JOIN` | `FROM A [INNER\|LEFT] JOIN (subquery) ON attr` | Join with subquery |
| `SHOW EVENT TYPES` | `SHOW EVENT TYPES` | List all available event types |

## NRQL Functions

### Aggregation

| Function | Description |
|----------|-------------|
| `count(*)` | Total number of events |
| `sum(attr)` | Sum of attribute values |
| `average(attr)` | Arithmetic mean |
| `min(attr)` | Minimum value |
| `max(attr)` | Maximum value |
| `latest(attr)` | Most recent value |
| `earliest(attr)` | Oldest value |
| `uniqueCount(attr)` | Count of distinct values |
| `uniques(attr [, limit])` | List of distinct values |
| `percentile(attr, p1 [, p2, ...])` | Percentile values |
| `median(attr)` | Median (50th percentile) |
| `histogram(attr, max, buckets)` | Distribution histogram |
| `stddev(attr)` | Standard deviation |
| `rate(sum(attr), interval)` | Rate of change per interval |
| `derivative(attr)` | Rate of change between adjacent points |
| `filter(func, WHERE cond)` | Apply aggregation with inline filter |
| `funnel(attr, WHERE ... AS ...)` | Conversion funnel analysis |
| `apdex(attr, threshold)` | Application performance index |
| `percentage(count(*), WHERE cond)` | Percentage matching condition |
| `buckets(attr, max, count)` | Group into equal-width buckets (use with FACET) |
| `predictLinear(attr, duration)` | Linear prediction over duration |
| `keyset()` | List all attribute names on an event type |

### Non-Aggregation

| Function | Description |
|----------|-------------|
| `abs(attr)` | Absolute value |
| `ceil(attr)` | Round up to integer |
| `floor(attr)` | Round down to integer |
| `round(attr [, precision])` | Round to precision |
| `clamp_max(attr, max)` | Cap at maximum value |
| `clamp_min(attr, min)` | Cap at minimum value |
| `pow(base, exp)` | Exponentiation |
| `sqrt(attr)` | Square root |
| `log(attr)` | Base-10 logarithm |
| `ln(attr)` | Natural logarithm |
| `if(cond, true_val, false_val)` | Conditional expression |
| `capture(attr, 'regex')` | Extract regex capture group |
| `concat(a, b, ...)` | String concatenation |
| `lower(attr)` | Lowercase string |
| `upper(attr)` | Uppercase string |
| `length(attr)` | String length |
| `substring(attr, start [, len])` | Extract substring |
| `replace(attr, 'search', 'replace')` | String replacement |
| `trim(attr)` | Remove leading/trailing whitespace |
| `aparse(attr, 'pattern')` | Anchor-based string parsing |
| `split(attr, 'delimiter', index)` | Split string and return segment |

### Type Conversion

| Function | Description |
|----------|-------------|
| `numeric(attr)` | Cast to number |
| `string(attr)` | Cast to string |
| `boolean(attr)` | Cast to boolean |

### Math Operators

`+`, `-`, `*`, `/` are supported in `SELECT` expressions (e.g. `SELECT bytesReceived / 1024 AS 'KB'`).

## Operational Notes

- Default time window: `SINCE 24 hours ago`
- `TIMESERIES AUTO` preferred over explicit intervals — NR picks optimal bucket size
- Field discovery: `keyset() FROM EventType` to list fields, `uniques(fieldName)` to list values
- Cross-event correlation fields: `trace.id`, `entity.guid`, `spanId`
- No `DISTINCT` keyword — use `uniques()` or `uniqueCount()` instead
- `WHERE LIKE` is case-insensitive; `=` is case-sensitive
- `COMPARE WITH` requires a `SINCE` clause

## Result Type Detection

Detection is based on field names present in `results[0]`:

| Priority | Check | Type | Renderer |
|----------|-------|------|----------|
| 1 | `beginTimeSeconds` present | TIMESERIES (any variant) | `TimeseriesChart` |
| 2 | Key matching `histogram.*` (single row) | Histogram | `HistogramChart` |
| 3 | `comparison` present | COMPARE WITH | Pivot cards/table |
| 4 | Single row, single key with array value | uniques() | List table |
| 5 | Single row, all numeric, no facet | Scalar aggregation | Metric cards |
| 6 | `facet` present | FACET grouping | Table |
| 7 | Multi-row, no facet | Raw event selection | Table |

## All NRQL Result Types

### 1. Simple Aggregation (Scalar)

```sql
SELECT count(*), average(duration) FROM Transaction
```

```json
[{ "count": 1234, "average.duration": 0.45 }]
```

Single row, all numeric values. Rendered as metric cards.

### 2. FACET (Grouped)

```sql
SELECT count(*) FROM Transaction FACET appName
```

```json
[
  { "count": 500, "facet": ["App-A"], "appName": "App-A" },
  { "count": 300, "facet": ["App-B"], "appName": "App-B" }
]
```

- `facet` field contains the group key(s) as an array
- Named keys (e.g. `appName`) duplicate the facet values — these are detected and deduplicated in table columns

### 3. TIMESERIES

```sql
SELECT count(*) FROM Transaction TIMESERIES 5 MINUTES SINCE 1 HOUR AGO
```

```json
[
  { "count": 16, "beginTimeSeconds": 1704067200, "endTimeSeconds": 1704067500, "inspectedCount": 16 },
  { "count": 18, "beginTimeSeconds": 1704067500, "endTimeSeconds": 1704067800, "inspectedCount": 18 }
]
```

- `beginTimeSeconds` / `endTimeSeconds`: Unix seconds (bucket boundaries)
- One row per time bucket
- `inspectedCount` is an internal NR field — hidden from display
- **Rendered as a line chart** via `TimeseriesChart`

### 4. FACET + TIMESERIES

```sql
SELECT count(*) FROM Transaction FACET appName TIMESERIES 5 MINUTES
```

```json
[
  { "count": 10, "facet": ["App-A"], "appName": "App-A", "beginTimeSeconds": 1704067200, "endTimeSeconds": 1704067500 },
  { "count": 8,  "facet": ["App-B"], "appName": "App-B", "beginTimeSeconds": 1704067200, "endTimeSeconds": 1704067500 },
  { "count": 12, "facet": ["App-A"], "appName": "App-A", "beginTimeSeconds": 1704067500, "endTimeSeconds": 1704067800 }
]
```

- Flat: one row per (facet value, time bucket) combination
- **Rendered as a multi-line chart** — one line per facet value, with legend

### 5. COMPARE WITH

```sql
SELECT count(*) FROM Transaction COMPARE WITH 1 DAY AGO
```

```json
[
  { "count": 1234, "comparison": "current" },
  { "count": 1100, "comparison": "previous" }
]
```

- `comparison` field distinguishes periods
- Without facet: rendered as side-by-side metric cards
- With facet: rendered as a pivot table

### 6. COMPARE WITH + TIMESERIES

```sql
SELECT count(*) FROM Transaction COMPARE WITH 1 DAY AGO TIMESERIES 5 MINUTES
```

```json
[
  { "count": 10, "comparison": "current",  "beginTimeSeconds": 1704067200, "endTimeSeconds": 1704067500 },
  { "count": 8,  "comparison": "previous", "beginTimeSeconds": 1704067200, "endTimeSeconds": 1704067500 }
]
```

- **Rendered as a comparison line chart** — solid line for current, dashed for previous

### 7. uniques()

```sql
SELECT uniques(appName) FROM Transaction
```

```json
[{ "uniques.appName": ["App-A", "App-B", "App-C"] }]
```

Single row, single key with array value. Rendered as a list table.

### 8. Histogram

```sql
SELECT histogram(duration, 1000, 10) FROM Transaction
```

```json
[{ "histogram.duration": { "0": 50, "100": 125, "200": 200, "300": 150, "400": 75 } }]
```

- Single row, single key matching `histogram.*`
- Value is an object mapping bucket boundaries (as string keys) to counts
- **Rendered as a bar chart** via `HistogramChart`

### 9. Percentile

```sql
SELECT percentile(duration, 50, 90, 99) FROM Transaction
```

```json
[{ "percentile.duration": { "50": 0.12, "90": 0.45, "99": 1.23 } }]
```

Single row, key matching `percentile.*`. Currently renders as scalar card with JSON value.

### 10. Apdex

```sql
SELECT apdex(duration, 0.5) FROM Transaction
```

```json
[{ "apdex": 0.95 }]
```

Single row, single numeric key. Rendered as scalar card.

### 11. FACET buckets()

```sql
SELECT count(*) FROM Transaction FACET buckets(duration, 1000, 5)
```

```json
[
  { "count": 100, "facet": "0-200",   "buckets(duration, 1000, 5)": "0-200" },
  { "count": 250, "facet": "200-400", "buckets(duration, 1000, 5)": "200-400" }
]
```

Standard FACET result with bucket range strings. Rendered as table.

### 12. Funnel

```sql
SELECT funnel(sessionId, WHERE pageUrl = '/home' AS 'Home', WHERE pageUrl = '/cart' AS 'Cart') FROM PageView
```

```json
[{ "funnel.Home": 1000, "funnel.Cart": 350 }]
```

Single row with `funnel.*` keys. Rendered as scalar cards.

### 13. Raw Event Selection

```sql
SELECT * FROM Transaction LIMIT 10
```

```json
[
  { "timestamp": 1704067200000, "name": "WebTransaction/...", "duration": 0.12, ... },
  { "timestamp": 1704067201000, "name": "WebTransaction/...", "duration": 0.35, ... }
]
```

Multi-row, no `facet` or time bucket keys. Rendered as table. Timestamp fields are auto-detected and formatted.

### 14. Single Scalar

```sql
SELECT count(*) FROM Transaction
```

```json
[{ "count": 1234 }]
```

Single row, single numeric key. Rendered as metric card.

## Hidden/Internal Fields

These fields are present in results but hidden from display:

| Field | Source | Reason |
|-------|--------|--------|
| `beginTimeSeconds` | TIMESERIES | Used for chart X-axis, not shown in tables |
| `endTimeSeconds` | TIMESERIES | Used for chart X-axis, not shown in tables |
| `inspectedCount` | Various | Internal NR sampling metadata |

## Common Event Types

| Event Type | Description | Key Fields |
|-----------|-------------|------------|
| `Transaction` | APM transactions | `name`, `duration`, `error`, `appName`, `host` |
| `TransactionError` | APM errors | `error.class`, `error.message`, `name`, `appName` |
| `Log` | Log entries | `message`, `level`, `timestamp` |
| `PageView` | Browser page loads | `pageUrl`, `duration`, `userAgentName` |
| `SyntheticCheck` | Synthetic monitors | `monitorName`, `result`, `duration` |
| `SystemSample` | Infrastructure | `cpuPercent`, `memoryUsedPercent`, `hostname` |
| `Span` | Distributed tracing spans | `name`, `duration`, `trace.id`, `span.kind`, `entity.name` |
| `ProcessSample` | Host process metrics | `processDisplayName`, `cpuPercent`, `memoryResidentSizeBytes`, `hostname` |
| `NetworkSample` | Network interface stats | `receiveBytesPerSecond`, `transmitBytesPerSecond`, `hostname` |
| `ContainerSample` | Docker/container metrics | `containerName`, `cpuPercent`, `memoryUsageBytes`, `hostname` |
| `StorageSample` | Disk/storage metrics | `diskUsedPercent`, `diskFreeBytes`, `mountPoint`, `hostname` |
| `BrowserInteraction` | Browser SPA interactions | `actionText`, `category`, `duration`, `browserInteractionName` |

## Frontend Component Map

```
NrqlResultView (entry point)
├─ TimeseriesChart          ← beginTimeSeconds detected
│  ├─ SimpleTimeseriesChart ← no facet, no comparison
│  ├─ FacetTimeseriesChart  ← facet present
│  └─ CompareTimeseriesChart← comparison present
├─ HistogramChart           ← histogram.* key detected
├─ List table               ← uniques() array value
├─ Comparison cards/table   ← comparison field
├─ Scalar cards             ← single row, all numeric
└─ Table                    ← everything else
```
