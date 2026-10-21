/**
 * New Relic domain knowledge — NRQL syntax, event types, field references,
 * anti-patterns, and debugging methodology. Pure prompt text constants.
 */

export const NR_AUTH_STOP_RULE = `## Authentication Failure — STOP IMMEDIATELY
If any query returns an authentication or permission error (e.g. "Invalid API key", "401", "403", "Unauthorized"), **STOP ALL FURTHER TOOL CALLS** and report:
1. The exact error message received.
2. That the New Relic API key needs checking in Settings.
Do NOT retry.
Sibling calls in the same step may return the same auth error; treat them as one failure.`;

const NRQL_QUICK_REFERENCE = `## NRQL Reference

### Clauses
- \`SELECT func(attr) FROM EventType\` — required. Event types are **case-sensitive** (\`Transaction\` not \`transaction\`).
- \`WHERE attr op value\` — filter. Operators: \`=\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`, \`IN ('a','b')\`, \`IS [NOT] NULL\`.
  - \`LIKE '%pattern%'\` — **case-sensitive**, \`%\` wildcard. Leading wildcard \`LIKE '%x'\` is slow.
  - \`RLIKE '(?i)timeout|refused'\` — regex (RE2 syntax). Must match ENTIRE string for extraction; use \`.*pattern.*\` for partial matching. Use \`(?i)\` flag for case-insensitive matching.
- \`FACET attr [, attr2]\` — group by (max 5 attributes). Default LIMIT 10 facet values, max 5000. LIMIT caps the number of facet values (the number of combinations for several attributes), not the rows inside a group.
- \`FACET CASES (WHERE cond AS 'label', ...)\` — custom grouping buckets. Order matters: first match wins.
- \`LIMIT n\` — max rows/facets. Default 10 for FACET, 100 for non-FACET. \`LIMIT MAX\` for maximum allowed.
- \`SINCE time_expr\` — always include. NR default is 1 hour if omitted. Supports: \`N hours ago\`, \`today\`, \`yesterday\`, \`'2024-01-15T14:00'\`, epoch ms.
- \`UNTIL time_expr\` — end time (default NOW).
- \`COMPARE WITH N time_unit ago\` — current vs prior period. Requires SINCE. Charts support it: with TIMESERIES the previous period draws dashed over the current one, so \`COMPARE WITH 1 week ago\` + TIMESERIES is the preferred way to show current against a baseline. Scalar and FACET results show current and previous side by side.
- \`TIMESERIES N time_unit\` or \`TIMESERIES AUTO\` — time-bucketed series. At most 366 buckets: choose the bucket size so that window / bucket is 366 or less. Be explicit with bucket size — AUTO can hide short spikes.
- \`SLIDE BY N time_unit\` — sliding windows. Cannot use with TIMESERIES AUTO.
- \`EXTRAPOLATE\` — compensate for APM event sampling. Only works with: count, average, sum, histogram, rate, percentage, apdex, stddev. Does NOT work with: uniqueCount, percentile, min, max, latest, earliest.
- \`ORDER BY attr [ASC|DESC]\` — sorts the rows of a non-aggregation query.
- \`FACET x ORDER BY max(duration) LIMIT n\` — ranks the facets by a function that is not the first in SELECT. It sorts highest first. Write no ASC or DESC there: \`ORDER BY agg DESC\` after FACET is a syntax error. Ascending order is not available. For the lowest values use \`LIMIT MAX\`, or \`FACET CASES\`, or a filter.
- \`WITH TIMEZONE 'America/New_York'\` — affects literal times, time display and time functions. Tracer adds the user's timezone automatically; do not add it yourself.
- Subqueries: \`WHERE x IN (SELECT ... FROM ...)\` or \`FROM (SELECT ... FACET y) WHERE ...\` — max 3 per query, cannot reference outer query attributes.

### Key Functions
**Aggregation:** \`count(*)\`, \`average(attr)\`, \`sum\`, \`min\`, \`max\`, \`percentile(attr, 50, 95, 99)\`, \`uniqueCount(attr)\`, \`uniques(attr)\`, \`histogram(attr)\`, \`median(attr)\`, \`stddev\`, \`latest(attr)\`, \`earliest(attr)\`.
**Rate/trend:** \`rate(aggregator, interval)\` — frequency per time unit. \`derivative(attr)\` — rate of change. \`filter(aggregator, WHERE cond)\` — conditional aggregation in SELECT, e.g. \`filter(count(*), WHERE error IS TRUE)\`. \`percentage(count(*), WHERE cond)\` — % matching condition.
**String/extraction:** \`capture(attr, r'.*(?P<name>pattern).*')\` — RE2 regex extraction. Named groups \`(?P<name>...)\`. Must match FULL string. \`aparse(attr, 'anchor*pattern')\` — simpler/faster anchor-based extraction. \`concat(a, b)\`, \`lower()\`, \`upper()\`, \`length()\`, \`substring(attr, start, end)\`, \`position(str, sub)\`, \`replace(str, search, repl)\`.
**Conditional:** \`if(condition, true_val, false_val)\` — per-row conditional.
**Time grouping:** \`hourOf(timestamp)\`, \`dateOf()\`, \`weekdayOf()\`, \`dayOfMonthOf()\`, \`monthOf()\` — in the user's timezone (added automatically).
**Type conversion:** \`numeric(val)\`, \`string(val)\`, \`boolean(val)\`. JSON: \`jsonParse(str_attr)\`, \`mapKeys()\`, \`mapValues()\`.
**Series labels:** Series and column names show to the user verbatim. Name them with \`AS\` (\`count(*) AS 'Requests'\`). Compound functions such as \`apdex()\` return several sub-fields (\`score\`, \`s\` satisfied, \`t\` tolerating, \`f\` frustrated, \`count\`) and each becomes its own series. Select the one you mean, for example \`apdex(...) AS 'Apdex'\` for the score, and say which sub-field the chart shows.
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
- A FACET can return a group for rows where the attribute is null. It shows as "(none)".
- \`count(*)\` counts all rows. \`count(attr)\` counts non-null values only.
- \`SELECT *\` over long ranges is slow — always aggregate for > 1 hour.
- \`Span\` data is sampled — never use for aggregate metrics (counts, averages). Use \`Transaction\` or \`Metric\` instead.
- RLIKE is slower than LIKE — use LIKE when wildcards suffice.
- \`COMPARE WITH\` + \`percentile()\` returns a JSON object (\`{"99": 0.984375}\`) instead of a plain number. To compare percentile values across periods, run two separate queries with explicit \`SINCE\`/\`UNTIL\` ranges rather than using \`COMPARE WITH\`.`;

export const NR_INSIDE_OUT_DEBUGGING = `## Inside-Out Debugging

**With a specific identifier** (ID, error message, trace ID, user):
1. Find it. Look in the event type most likely to hold it: TransactionError, Transaction, Log or Span (for example \`\\\`error.message\\\` LIKE '%value%'\`, \`request.uri LIKE '%value%'\`). Try the other types when it does not match.
2. Extract context — traceId, appName, transactionName, error.class, timestamp.
3. Follow the chain. The first error or slow part is a link, not the end. Take the trace (\`FROM Transaction WHERE traceId = '...'\`, or \`FROM Span\` for the call path). Find the callee or resource that owns the failing or slow part. Investigate it the same way.
4. If multiple identifiers surface, investigate 1-2 representative samples. Then count how many of all matches share their pattern (FACET by the shared attribute). Only a count makes it THE pattern.

**Without a specific identifier** (vague symptoms):
1. Read throughput, latency and errors over a window that includes a normal period before the problem, so the onset shows. Get several signals in one query, for example \`SELECT count(*), average(duration), percentage(count(*), WHERE error IS TRUE) FROM Transaction WHERE appName = '...' TIMESERIES\`.
2. FACET by app, transaction, host or error class to find the part that changed. Then follow it.
3. Once you have a specific identifier, switch to the "with identifier" flow above.

**Slow responses or an Apdex drop:** a response time is a sum of parts. Find the part that grew, follow it to the service or resource that owns it, and start again there.
- Measure what the user measures. The app's own Apdex is in the metric \`apm.service.apdex\` (per transaction: \`apm.service.transaction.apdex\`). Read it with \`apdex(apm.service.apdex)\`. \`average()\` or \`min()\` of it is not a score. Nested aggregates such as \`min(apdex(...))\` or \`max(percentage(...))\` are not allowed. Server-side errors count as frustrated at any response time, so an Apdex drop can be errors, not slowness. \`apdex(duration, t: ...)\` ignores errors and uses a T you choose.
- Split the time against a normal window: database, external calls, and the service's own code (Transaction \`databaseDuration\`, \`externalDuration\`, \`databaseCallCount\`, \`externalCallCount\`). More calls per request and slower calls are different causes.
- Each part has an owner with its own data. External time: \`apm.service.external.host.duration\` by \`external.host\` names the called host; find its service and investigate it. Database time: \`apm.service.datastore.operation.duration\` by \`datastoreType\`, \`table\`, \`operation\`, and \`db.statement\` on datastore spans. Own time: load, \`apm.service.cpu.usertime.utilization\`, \`apm.service.memory.physical\`, \`apm.service.instance.count\`, host samples, and CPU throttling in \`K8sContainerSample\`. Changes: \`ChangeTrackingEvent\` and \`Deployment\`.
- Caller to callee: take \`external.host\`, or the downstream span in a trace (\`http.url\`, \`category\`). Find the service that owns it (its \`appName\`). Query that service with the same method.
- Compare a host or instance with its healthy peers (\`FACET host\`). This separates one bad node from a service-wide cause.
- Find the onset to the minute with \`TIMESERIES\` of the part that grew. Then look for changes at that minute.
- Fields differ by agent and setup. Before you call a field or metric absent, confirm it with \`keyset()\` or \`uniques(metricName)\`.

**Diagnostic safeguards:**
- **No data?** Check the app name, the event type and the field with \`keyset()\`. Widen the window. Report no data only when the source holds nothing for the entity.

**Identifier extraction:** \`error.message\` often contains IDs — extract with \`capture()\` or \`LIKE\` and search across types. \`request.uri\` has entity IDs (e.g. \`/api/users/12345\`). Custom attributes: \`keyset() FROM Transaction\`.`;

export const NR_SERVICE_HEALTH_RUNBOOK = `## Service Health Runbook

Judge health per entity type from its signals against a normal window. Find which entity types exist for the service (APM application, Browser application, or both). If none exists, report that no monitorable entity was found.

**Signals**
- APM: latency P99 and median, error rate, throughput and success count, outbound call errors and duration.
- Browser: JS errors, AJAX error rate and time, LCP, AJAX volume.

**Method**
- Choose the baseline from the traffic pattern. The same weekday and hour a week earlier is the usual choice. Never compare a weekday with a weekend. Pick a window free of known incidents and say which one you picked.
- Report each change with both numbers. Judge its size against the normal variation of that signal.
- A moved signal is a symptom. Follow it with the slow-response method or the chain.
- Put several moved signals on one timeline. A shared onset points to one cause.
- If you cannot evaluate a signal, mark it N/A and give the reason.

### Reporting Format
Do not write a results table or a verdict line. Put the result in the finding card: the headline gives the overall verdict, and the details give each signal's current value against its baseline. Show the signals that matter most with queries (for example \`COMPARE WITH 1 week ago\` for current against baseline).`;

const NR_QUERY_DEFAULTS = `## Query Defaults
- Always include \`SINCE\`. Match the window to the question. Look wider than the incident, to find its onset and a normal baseline.
- Use a \`LIMIT\` that shows the whole distribution you reason about. Raise it when a facet may hide the cause.
- A FACET result keeps the facets with the highest value of the first function. For the lowest values (the worst Apdex) or the biggest change (\`COMPARE WITH\`), use \`LIMIT MAX\`, so that every candidate is in the result. You see every row the query returns, up to a text budget per result. A note tells you when rows are cut.
- To rank all candidates by a spike or a drop, take each one's worst interval against its own normal level, counted in requests. Put a TIMESERIES per candidate in a subquery and aggregate it outside, for example \`SELECT max(n) - average(n), max(n), average(n) FROM (SELECT filter(count(*), WHERE error IS TRUE) AS n FROM Transaction WHERE appName LIKE 'PROD-%' FACET appName TIMESERIES 5 minutes LIMIT MAX) FACET appName SINCE 1 day ago LIMIT 10\`. For latency or Apdex, count slow requests instead: \`WHERE apdexPerfZone = 'F'\`. SINCE goes on the outer query only.`;

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

**Transaction** — One event per request per service. Sampled on high-volume agents: use Metric or EXTRAPOLATE for totals.
Fields: \`duration\`, \`name\`, \`appName\`, \`traceId\`, \`guid\`, \`httpResponseCode\`, \`request.uri\`, \`request.method\`, \`error\` (boolean), \`host\`, \`entity.guid\`, \`databaseDuration\`, \`databaseCallCount\`, \`externalDuration\`, \`externalCallCount\`, \`parent.app\` (the caller's app identifier, not its name)/\`parent.type\`/\`parent.transportDuration\`.
Use for: health checks, error rates, latency, throughput, cross-service tracing.

**TransactionError** — Error details. Separate sampling pool (~100/harvest cycle).
Fields: \`error.message\`, \`error.class\`, \`error.expected\`, \`transactionName\`, \`request.uri\`, \`traceId\`, \`appName\`. Plus most Transaction fields.
Key difference: Transaction only has boolean \`error\`; TransactionError has the actual error message/class.

**Log** — Forensic detail. Auto-decorated with trace linking when logs-in-context is enabled.
Fields: \`message\`, \`level\` / \`log.level\`, \`entity.name\`, \`hostname\`, \`trace.id\`, \`span.id\`, \`entity.guid\`.
Note: Linking fields (\`trace.id\`, \`span.id\`) require agent logs-in-context. If missing, the data does not link logs to traces; the reason is unknown.

**Span** — Sub-transaction operations (DB, HTTP, method timings). Sampled (roughly 10 traces/min, more for Java), so counts and averages are too low. Totals come from Transaction or Metric.
Fields: \`name\`, \`duration\`, \`category\` (generic/http/datastore/external), \`span.kind\`, \`traceId\`, \`parentId\`, \`nr.entryPoint\`, \`http.url\`, \`http.statusCode\`, \`db.statement\`, \`error.class\`, \`error.message\`.
Use it to follow one request: which child call or datastore span took the time, and which service the call went to.
A Span has no \`transaction.name\`. To scope spans to one transaction, filter by trace: \`WHERE traceId IN (SELECT traceId FROM Transaction WHERE appName = 'x' AND name = 'y' LIMIT MAX)\`.

**Metric** — Dimensional metrics. **NEVER SAMPLED** — always accurate. Use when event sampling is suspected.
Query: \`FROM Metric SELECT average(apm.service.transaction.duration) WHERE appName = 'x'\`.

**SystemSample / ProcessSample** — Infrastructure host/process metrics. **Requires separate infrastructure agent** (not guaranteed with APM).
Fields: \`cpuPercent\`, \`memoryUsedPercent\`, \`diskUsedPercent\`, \`hostname\`, \`processDisplayName\`.`;

const NR_CROSS_SIGNAL = `## Cross-Signal Correlation
- **Transaction → TransactionError**: Same \`traceId\`. Transaction has boolean \`error\`; TransactionError has \`error.message\`/\`error.class\`.
- **Transaction → Log**: \`traceId\` (Transaction) = \`trace.id\` (Log, backtick-quoted). \`appName\` (Transaction) = \`entity.name\` (Log).
- **Transaction → Span**: Same \`traceId\`. Use Span to follow one request: which child call took the time and which service it went to. Take totals from Transaction or Metric (Span is sampled).
- **Any → Metric**: When event counts seem low, compare: \`FROM Transaction SELECT count(*)\` vs \`FROM Metric SELECT rate(count(apm.service.transaction.duration), 1 minute)\`. If Metric is significantly higher, events are sampled — add \`EXTRAPOLATE\`.
- **\`entity.guid\`**: Universal cross-type linker across Transaction, Span, Log, Metric, Infrastructure.
- **Diagnostic shortcut**: Health → Transaction | Error cause → TransactionError | Slow or Apdex drop? → the "Slow responses or an Apdex drop" flow | Which service? → Transaction WHERE traceId | Infra → SystemSample WHERE hostname = '...'`;

const NR_ALERTS = `## Alerts: Issues, Incidents, Policies
- A **condition** belongs to a **policy**. A condition opens an **incident**. New Relic groups related incidents into one **issue**.
- Issue states are CREATED, ACTIVATED, DEACTIVATED and CLOSED. Read them from the issue tools for "what is open now".
- Incident history: NRQL on \`NrAiIncident\`. Fields: \`incidentId\`, \`event\` ('open' or 'close'), \`policyName\`, \`policyId\`, \`conditionName\`, \`conditionId\`.`;

export const NR_DOMAIN_KNOWLEDGE = `${NR_QUERY_DEFAULTS}

${NR_EVENT_TYPES}

${NR_CROSS_SIGNAL}

${NRQL_QUICK_REFERENCE}

${NR_ANTI_PATTERNS}

${NR_SERVICE_HEALTH_RUNBOOK}

${NR_ALERTS}`;
