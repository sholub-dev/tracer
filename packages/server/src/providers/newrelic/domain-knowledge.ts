/**
 * New Relic domain knowledge — NRQL syntax, event types, field references,
 * anti-patterns, and debugging methodology. Pure prompt text constants.
 */

export const NR_AUTH_STOP_RULE = `## Authentication Failure — STOP IMMEDIATELY
If any query returns an authentication or permission error (e.g. "Invalid API key", "401", "403", "Unauthorized"), **STOP ALL FURTHER TOOL CALLS** and report:
1. The exact error message received.
2. That the New Relic API key needs to be checked in Settings.
Do NOT retry — auth errors cannot be resolved by the sub-agent.`;

const NRQL_QUICK_REFERENCE = `## NRQL Reference

### Clauses
- \`SELECT func(attr) FROM EventType\` — required. Event types are **case-sensitive** (\`Transaction\` not \`transaction\`).
- \`WHERE attr op value\` — filter. Operators: \`=\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`IN ('a','b')\`, \`IS [NOT] NULL\`.
  - \`LIKE '%pattern%'\` — **case-sensitive**, \`%\` wildcard. Leading wildcard \`LIKE '%x'\` is slow.
  - \`RLIKE '(?i)timeout|refused'\` — regex (RE2 syntax). Must match ENTIRE string for extraction; use \`.*pattern.*\` for partial matching. Use \`(?i)\` flag for case-insensitive matching.
- \`FACET attr [, attr2]\` — group by (max 5 attributes). Default LIMIT 10 facet values, max 5000. LIMIT applies per-facet group.
- \`FACET CASES (WHERE cond AS 'label', ...)\` — custom grouping buckets. Order matters: first match wins.
- \`LIMIT n\` — max rows/facets. Default 10 for FACET, 100 for non-FACET. \`LIMIT MAX\` for maximum allowed.
- \`SINCE time_expr\` — always include. NR default is 1 hour if omitted. Supports: \`N hours ago\`, \`today\`, \`yesterday\`, \`'2024-01-15T14:00'\`, epoch ms.
- \`UNTIL time_expr\` — end time (default NOW).
- \`COMPARE WITH N time_unit ago\` — overlay current vs prior period. Requires SINCE.
- \`TIMESERIES N time_unit\` or \`TIMESERIES AUTO\` — time-bucketed series. Max 366 buckets. Be explicit with bucket size — AUTO can hide short spikes.
- \`SLIDE BY N time_unit\` — sliding windows. Cannot use with TIMESERIES AUTO.
- \`EXTRAPOLATE\` — compensate for APM event sampling. Only works with: count, average, sum, histogram, rate, percentage, apdex, stddev. Does NOT work with: uniqueCount, percentile, min, max, latest, earliest.
- \`ORDER BY attr [ASC|DESC]\` — sort non-aggregation results only (not for FACET queries).
- \`WITH TIMEZONE 'America/New_York'\` — affects time display and time functions. Default UTC.
- Subqueries: \`WHERE x IN (SELECT ... FROM ...)\` or \`FROM (SELECT ... FACET y) WHERE ...\` — max 3 per query, cannot reference outer query attributes.

### Key Functions
**Aggregation:** \`count(*)\`, \`average(attr)\`, \`sum\`, \`min\`, \`max\`, \`percentile(attr, 50, 95, 99)\`, \`uniqueCount(attr)\`, \`uniques(attr)\`, \`histogram(attr)\`, \`median(attr)\`, \`stddev\`, \`latest(attr)\`, \`earliest(attr)\`.
**Rate/trend:** \`rate(aggregator, interval)\` — frequency per time unit. \`derivative(attr)\` — rate of change. \`filter(aggregator, WHERE cond)\` — conditional aggregation in SELECT, e.g. \`filter(count(*), WHERE error IS TRUE)\`. \`percentage(count(*), WHERE cond)\` — % matching condition.
**String/extraction:** \`capture(attr, r'.*(?P<name>pattern).*')\` — RE2 regex extraction. Named groups \`(?P<name>...)\`. Must match FULL string. \`aparse(attr, 'anchor*pattern')\` — simpler/faster anchor-based extraction. \`concat(a, b)\`, \`lower()\`, \`upper()\`, \`length()\`, \`substring(attr, start, end)\`, \`position(str, sub)\`, \`replace(str, search, repl)\`.
**Conditional:** \`if(condition, true_val, false_val)\` — per-row conditional.
**Time grouping:** \`hourOf(timestamp)\`, \`dateOf()\`, \`weekdayOf()\`, \`dayOfMonthOf()\`, \`monthOf()\` — UTC by default, use WITH TIMEZONE.
**Type conversion:** \`numeric(val)\`, \`string(val)\`, \`boolean(val)\`. JSON: \`jsonParse(str_attr)\`, \`mapKeys()\`, \`mapValues()\`.
**Discovery:** \`keyset() FROM EventType\` — list all attributes. \`SHOW EVENT TYPES\` — list all event types.

### Case Sensitivity
- **Event types**: case-sensitive (\`Transaction\`, not \`transaction\`).
- **Attribute names**: case-sensitive (\`appName\`, not \`appname\`).
- **NRQL keywords/functions**: case-insensitive (\`SELECT\`, \`select\`, \`Count()\` all work).
- **\`=\` and \`LIKE\`**: case-sensitive. For case-insensitive matching, use \`RLIKE '(?i)pattern'\` or normalize with \`lower()\`.`;

const NR_ANTI_PATTERNS = `## Common Mistakes — AVOID THESE
- No \`DISTINCT\` keyword — use \`uniques(field)\` or \`FACET field\`.
- No \`GROUP BY\` — use \`FACET\`.
- No backslashes in NRQL strings. Backtick dotted field names: \`SELECT \\\`error.message\\\` FROM TransactionError\`.
- \`WHERE attr != 'value'\` does NOT include rows where attr is NULL. Use \`WHERE attr != 'value' OR attr IS NULL\`.
- NULL values are excluded from FACET groups.
- \`count(*)\` counts all rows. \`count(attr)\` counts non-null values only.
- \`SELECT *\` over long ranges is slow — always aggregate for > 1 hour.
- \`Span\` data is sampled — never use for aggregate metrics (counts, averages). Use \`Transaction\` or \`Metric\` instead.
- RLIKE is slower than LIKE — use LIKE when wildcards suffice.
- \`COMPARE WITH\` + \`percentile()\` returns a JSON object (\`{"99": 0.984375}\`) instead of a plain number. To compare percentile values across periods, run two separate queries with explicit \`SINCE\`/\`UNTIL\` ranges rather than using \`COMPARE WITH\`.`;

export const NR_INSIDE_OUT_DEBUGGING = `## Inside-Out Debugging

**With a specific identifier** (ID, error message, trace ID, user):
1. Find it — TransactionError first (\`\\\`error.message\\\` LIKE '%value%'\`, \`request.uri LIKE '%value%'\`). No match → Transaction → Log.
2. Extract context — traceId, appName, transactionName, error.class, timestamp.
3. Expand ONLY if needed — \`FROM Transaction WHERE traceId = '...'\` for the request chain, but only if the error context doesn't already answer the question.
4. If multiple identifiers surface, investigate 1-2 representative samples. If they show the same pattern, stop — that IS the pattern.

**Without a specific identifier** (vague symptoms):
1. Golden Signals — \`SELECT count(*), average(duration), percentage(count(*), WHERE error IS TRUE) FROM Transaction WHERE appName = '...' SINCE 1 hour ago\` — get multiple signals in ONE query.
2. FACET to scope — drill by appName, transactionName, or error.class to narrow down.
3. Once you have a specific identifier, switch to the "with identifier" flow above.

**Diagnostic safeguards:**
- **No data?** If your first 2 queries across different event types return empty, verify data exists: \`SELECT count(*) FROM Transaction SINCE 1 day ago\`. If zero, report no data — stop investigating.

**Identifier extraction:** \`error.message\` often contains IDs — extract with \`capture()\` or \`LIKE\` and search across types. \`request.uri\` has entity IDs (e.g. \`/api/users/12345\`). Custom attributes: \`keyset() FROM Transaction\`.

NEVER start with schema discovery (\`keyset()\`, \`SHOW EVENT TYPES\`) when you have a specific value.`;

export const NR_SERVICE_HEALTH_RUNBOOK = `## Service Health Runbook

### Step 0 — Identify Entity Types
Before running any checks, determine which entity types exist for the service:
- **APM application present** → run the APM Health Checklist below
- **Browser application present** → run the Browser Health Checklist below
- **Both present** → run both checklists
- **Neither found** → report that no monitorable entity was found and stop

---

### APM Health Checklist
Run all 4 checks for any APM application entity.

**[ ] Check 1 — Response Time P99**
Measure the 99th percentile response time for all transactions.
_Why:_ P99 catches worst-case latency that average metrics hide. Degradation here means the slowest 1% of users are experiencing a significant problem even if the average looks fine.
_Baseline:_ Compare against the same time range exactly 1 week ago (same day of week).
_Flag if:_ Current P99 is more than 50% higher than the baseline.

**[ ] Check 2 — Transaction Error Rate**
Measure the percentage of all transactions that ended in an error.
_Why:_ Error rate directly reflects the fraction of user requests that are failing. Even a small uptick is significant because it represents real users hitting errors.
_Baseline:_ Compare against the same time range 1 week ago (same day of week).
_Flag if:_ Current rate is more than 50% relatively higher than baseline, OR the absolute increase is more than 1 percentage point when the baseline was near zero.

**[ ] Check 3 — External Services Errors**
Measure the error rate of outbound HTTP calls this service makes to external services or APIs.
_Why:_ A failing downstream dependency will cascade into this service's errors. This distinguishes "our code is broken" from "something we depend on is broken."
_Applicability:_ Only run this check if the service makes external calls. If it does not, mark as N/A.
_Baseline:_ Compare non-2xx response rate against the same time range 1 week ago (same day of week).
_Flag if:_ Non-2xx rate is more than 2× the baseline, or it newly appears where the baseline was near zero.

**[ ] Check 4 — Success Transactions Drop**
Measure the count of transactions that completed successfully (no error).
_Why:_ A drop in successful transactions signals a blockage or anomaly even when the error rate is stable — requests may simply not be arriving or being processed at expected volumes.
_Baseline:_ Compare count against the same time range exactly 1 week ago (same day of week). **Never compare different days of the week — traffic patterns differ significantly between weekdays and weekends.**
_Flag if:_ Count is more than 20% lower than the baseline.

---

### Browser Health Checklist
Run all 5 checks for any Browser application entity.

**[ ] Check 1 — Browser JS Errors**
Measure the count of JavaScript errors recorded in users' browsers.
_Why:_ JS errors silently break features and flows without producing HTTP errors — they are completely invisible to server-side APM.
_Baseline:_ Compare count against the same time range 1 week ago (same day of week).
_Flag if:_ Count is more than 50% higher than baseline.

**[ ] Check 2 — AJAX Request Error Rate**
Measure the percentage of AJAX/XHR requests from the browser that received a non-2xx HTTP response.
_Why:_ Catches API failures from the client's perspective, including calls to third-party APIs or CDN endpoints that server-side APM may miss entirely.
_Baseline:_ Compare against the same time range 1 week ago (same day of week).
_Flag if:_ Error rate is more than 50% relatively higher than baseline, or the absolute increase is more than 1 percentage point when baseline was near zero.

**[ ] Check 3 — Browser LCP P75**
Measure the 75th percentile of Largest Contentful Paint (LCP) — the time until the page's primary content is visible to the user.
_Why:_ LCP is the primary user-perceived load speed signal. P75 means 3 out of 4 users experience this load time or better. A regression here directly impacts perceived performance for the majority of users.
_Baseline:_ Compare against the same time range 1 week ago (same day of week).
_Flag if:_ P75 is more than 30% higher (slower) than baseline.

**[ ] Check 4 — AJAX Response Time P75**
Measure the 75th percentile of AJAX request round-trip time as measured from the browser.
_Why:_ Slow AJAX responses degrade interactivity even when the initial page load looks fine. This catches API latency that users feel during active interactions.
_Baseline:_ Compare against the same time range 1 week ago (same day of week).
_Flag if:_ P75 is more than 30% higher than baseline.

**[ ] Check 5 — AJAX Success Requests Drop**
Measure the count of AJAX requests that completed with a successful (2xx) response.
_Why:_ A drop can indicate a broken feature preventing users from reaching certain flows, a routing or CDN blockage, or an authentication/session issue causing requests to be rejected upstream.
_Baseline:_ Compare against the same time range exactly 1 week ago (same day of week). **Never compare different days of the week.**
_Flag if:_ Count is more than 20% lower than the baseline.

---

### Baseline Comparison Rule
**Always compare the same day of week, same time range, 7 days prior.**
- Correct: "Tuesday 14:00–15:00" vs "last Tuesday 14:00–15:00"
- **WRONG: comparing Monday vs Tuesday, or weekday vs weekend.** Traffic patterns differ significantly — cross-day comparisons produce false positives and miss real issues.

---

### Reporting Format
After completing all applicable checks, report results as a table:

| Check | Current | Baseline (1w ago) | Delta | Status |
|-------|---------|-------------------|-------|--------|
| Response Time P99 | ... | ... | +X% | ✅ Pass / ⚠️ Flagged |
| Transaction Error Rate | ... | ... | +X% | ✅ Pass / ⚠️ Flagged |
| External Services Errors | ... | ... | ... | ✅ Pass / ⚠️ Flagged / — N/A |
| Success Transactions | ... | ... | -X% | ✅ Pass / ⚠️ Flagged |

End with an overall verdict on its own line:
- \`Service appears healthy.\` — all checks pass
- \`X check(s) flagged: [list check names].\` — one or more checks flagged

If a check could not be evaluated (no baseline data available, service has no external calls, etc.), mark it as **N/A** with a brief note. Never silently skip a check.`;

const NR_QUERY_DEFAULTS = `## Query Defaults
- Always include \`SINCE\`. Default: \`SINCE 24 hours ago\`. "recent" → 1 hour. "today" → today.
- Default: \`LIMIT 10\`. Increase to 20–50 only when needed. Never start with 100+.`;

const NR_EVENT_TYPES = `## Event Types & Field Reference

### CRITICAL: Field Name Mismatches Across Event Types
| Concept | Transaction/Span | Log | Infrastructure |
|---------|-----------------|-----|----------------|
| Trace ID | \`traceId\` (camelCase) | \`trace.id\` (dotted, needs backticks) | — |
| Span ID | \`guid\` | \`span.id\` (dotted, needs backticks) | — |
| App/Service | \`appName\` | \`entity.name\` | — |
| Host | \`host\` | \`hostname\` | \`hostname\` |
| Txn name | \`name\` | — | — |
| Txn name (error) | — (use \`transactionName\` in TransactionError) | — | — |

Same values, different field names. \`FROM Transaction WHERE traceId = 'abc'\` but \`FROM Log WHERE \\\`trace.id\\\` = 'abc'\`.

### Event Types

**Transaction** — One event per request per service. ~2000 events/min/instance before sampling.
Fields: \`duration\`, \`name\`, \`appName\`, \`traceId\`, \`guid\`, \`httpResponseCode\`, \`request.uri\`, \`request.method\`, \`error\` (boolean), \`host\`, \`entity.guid\`, \`databaseDuration\`, \`externalDuration\`, \`parent.app\`/\`parent.type\`/\`parent.transportDuration\`.
Use for: health checks, error rates, latency, throughput, cross-service tracing.

**TransactionError** — Error details. Separate sampling pool (~100/harvest cycle).
Fields: \`error.message\`, \`error.class\`, \`error.expected\`, \`transactionName\`, \`request.uri\`, \`traceId\`, \`appName\`. Plus most Transaction fields.
Key difference: Transaction only has boolean \`error\`; TransactionError has the actual error message/class.

**Log** — Forensic detail. Auto-decorated with trace linking when logs-in-context is enabled.
Fields: \`message\`, \`level\` / \`log.level\`, \`entity.name\`, \`hostname\`, \`trace.id\`, \`span.id\`, \`entity.guid\`.
Note: Linking fields (\`trace.id\`, \`span.id\`) require agent logs-in-context. Missing = agent too old or feature not enabled.

**Span** — Sub-transaction operations (DB, HTTP, method timings). **HEAVILY SAMPLED: ~10 traces/min (120 for Java), max 2000 spans/min.** Never use for aggregate counts/averages — counts will be far too low.
Fields: \`name\`, \`duration\`, \`category\` (generic/http/datastore/external), \`span.kind\`, \`traceId\`, \`parentId\`, \`nr.entryPoint\`, \`http.url\`, \`http.statusCode\`, \`db.statement\`, \`error.class\`, \`error.message\`.
Use ONLY for: tracing individual request paths when Transaction's \`duration\` isn't granular enough.

**Metric** — Dimensional metrics. **NEVER SAMPLED** — always accurate. Use when event sampling is suspected.
Query: \`FROM Metric SELECT average(apm.service.transaction.duration) WHERE appName = 'x'\`.

**SystemSample / ProcessSample** — Infrastructure host/process metrics. **Requires separate infrastructure agent** (not guaranteed with APM).
Fields: \`cpuPercent\`, \`memoryUsedPercent\`, \`diskUsedPercent\`, \`hostname\`, \`processDisplayName\`.`;

const NR_CROSS_SIGNAL = `## Cross-Signal Correlation
- **Transaction → TransactionError**: Same \`traceId\`. Transaction has boolean \`error\`; TransactionError has \`error.message\`/\`error.class\`.
- **Transaction → Log**: \`traceId\` (Transaction) = \`trace.id\` (Log, backtick-quoted). \`appName\` (Transaction) = \`entity.name\` (Log).
- **Transaction → Span**: Same \`traceId\`. Use Span ONLY for sub-request breakdown — never for aggregates (heavily sampled).
- **Any → Metric**: When event counts seem low, compare: \`FROM Transaction SELECT count(*)\` vs \`FROM Metric SELECT rate(count(apm.service.transaction.duration), 1 minute)\`. If Metric is significantly higher, events are sampled — add \`EXTRAPOLATE\`.
- **\`entity.guid\`**: Universal cross-type linker across Transaction, Span, Log, Metric, Infrastructure.
- **Diagnostic shortcut**: Health → Transaction | Error cause → TransactionError | Slow? → Transaction FACET name, then Span for breakdown | Which service? → Transaction WHERE traceId | Infra → SystemSample WHERE hostname = '...'`;

export const NR_DOMAIN_KNOWLEDGE = `${NR_QUERY_DEFAULTS}

${NR_EVENT_TYPES}

${NR_CROSS_SIGNAL}

${NRQL_QUICK_REFERENCE}

${NR_ANTI_PATTERNS}

${NR_SERVICE_HEALTH_RUNBOOK}`;
