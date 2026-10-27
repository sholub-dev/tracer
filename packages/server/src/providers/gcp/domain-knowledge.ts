/**
 * GCP domain knowledge — Cloud Logging syntax, resource types, metric types,
 * tool parameters, anti-patterns, and debugging methodology. Pure prompt text constants.
 */

export const GCP_AUTH_STOP_RULE = `## Authentication Failure — STOP IMMEDIATELY
If any tool returns an authentication or permission error (e.g. "unauthenticated", "permission denied", "credentials", "401", "403", "UNAUTHENTICATED", "insufficient permissions"), **STOP ALL FURTHER TOOL CALLS** and report:
1. The exact error message received.
2. That the credentials need checking in Settings.
Do NOT retry. Do NOT try alternative tools.
Sibling calls in the same step may return the same auth error; treat them as one failure.`;

export const GCP_PAGE_SIZE_RULE = `Use specific filters (severity, resource type, service name, time range). On a size-limit error, narrow the filter or the window, or lower pageSize, and retry. The tools return no page token. When the first page does not answer the question, narrow the filter or the window. For logs, repeat the call with \`timestamp < "<oldest timestamp seen>"\` and \`orderBy: "timestamp desc"\`.`;

const GCP_LOGGING_FILTER_SYNTAX = `## Cloud Logging Filter Syntax
- Comparison operators: \`=\`, \`!=\`, \`>\`, \`>=\`, \`<\`, \`<=\`, \`:\` (has/substring), \`=~\` (regex), \`!~\` (not regex)
- Boolean: \`AND\`, \`OR\`, \`NOT\` (AND is implicit between expressions)
- Severity levels: DEFAULT, DEBUG, INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT, EMERGENCY
- Severity comparison: \`severity >= ERROR\` — NOT quoted, NOT prefixed with anything
- Text search: \`textPayload:"error message"\` or \`jsonPayload.message:"error"\`
- Resource filter: \`resource.type="cloud_run_revision"\` — string values MUST be double-quoted
- Resource labels: \`resource.labels.service_name="my-service"\`
- Log name: \`logName="projects/PROJECT/logs/LOG_ID"\` or \`log_id("LOG_ID")\`
- Timestamp: \`timestamp >= "2024-01-15T00:00:00Z"\`
- NEVER use SQL syntax (WHERE, SELECT, FROM) — this is NOT SQL
- NEVER quote severity values: \`severity >= ERROR\` not \`severity >= "ERROR"\``;

const GCP_RESOURCE_TYPES = `## Common Resource Types & Labels
- \`cloud_run_revision\`: labels: service_name, revision_name, location, configuration_name
- \`cloud_run_job\`: labels: job_name, location
- \`cloud_function\`: labels: function_name, region
- \`gce_instance\`: labels: instance_id, zone
- \`k8s_container\`: labels: cluster_name, namespace_name, container_name, pod_name, location
- \`k8s_pod\`: labels: cluster_name, namespace_name, pod_name, location
- \`k8s_node\`: labels: cluster_name, node_name, location
- \`gae_app\`: labels: module_id, version_id, zone
- \`cloud_sql_database\`: labels: database_id, region
- \`global\`: for logs not tied to a specific resource`;

const GCP_METRIC_TYPES = `## Common Metric Types (for list_time_series)
- Cloud Run: \`run.googleapis.com/request_count\`, \`run.googleapis.com/request_latencies\`, \`run.googleapis.com/container/memory/utilizations\`, \`run.googleapis.com/container/cpu/utilizations\`, \`run.googleapis.com/container/instance_count\`
- Cloud Functions: \`cloudfunctions.googleapis.com/function/execution_count\`, \`cloudfunctions.googleapis.com/function/execution_times\`, \`cloudfunctions.googleapis.com/function/active_instances\`
- GCE: \`compute.googleapis.com/instance/cpu/utilization\`, \`compute.googleapis.com/instance/network/received_bytes_count\`
- GKE: \`kubernetes.io/container/cpu/core_usage_time\`, \`kubernetes.io/container/memory/used_bytes\`, \`kubernetes.io/container/restart_count\`
- Cloud SQL: \`cloudsql.googleapis.com/database/cpu/utilization\`, \`cloudsql.googleapis.com/database/memory/utilization\`
- Load Balancing: \`loadbalancing.googleapis.com/https/request_count\`, \`loadbalancing.googleapis.com/https/total_latencies\`
- Use \`list_metric_descriptors\` to discover available metrics when unsure.`;

const GCP_TOOL_PARAMS = `## Tool Parameter Reference

### list_log_entries
\`\`\`json
{ "resourceNames": ["projects/PROJECT_ID"], "filter": "resource.type=\\"cloud_run_revision\\" AND severity>=ERROR", "pageSize": 20, "orderBy": "timestamp desc" }
\`\`\`
GOTCHA: \`resourceNames\` is an ARRAY of \`"projects/PROJECT_ID"\` strings, NOT a bare \`"PROJECT_ID"\` and NOT \`projectName\`
GOTCHA: Always include \`orderBy: "timestamp desc"\` — default is \`timestamp asc\` (oldest first)
Paging: there is no page token. Repeat the call with \`timestamp < "<oldest timestamp seen>"\` in the filter, or narrow the filter.

### list_time_series
\`\`\`json
{ "name": "projects/PROJECT_ID", "filter": "metric.type=\\"run.googleapis.com/request_count\\" AND resource.type=\\"cloud_run_revision\\"", "interval": { "startTime": "RFC3339", "endTime": "RFC3339" }, "aggregation": { "alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_RATE" } }
\`\`\`
GOTCHA: \`interval\` is REQUIRED — always compute startTime/endTime from the user's timeframe
GOTCHA: Join metric filter conditions with \`AND\`; use \`metric.labels.X\` and \`resource.labels.X\` for labels. \`interval.endTime\` is required, \`startTime\` is optional.

### list_traces
\`\`\`json
{ "projectId": "PROJECT_ID", "filter": "latency:100ms", "startTime": "RFC3339", "endTime": "RFC3339", "pageSize": 10 }
\`\`\`
Filters: \`latency:100ms\` (at least this slow), \`root:NAME_PREFIX\`, \`+root:EXACT_NAME\`, \`http.status_code:500\`, \`method:Get\`. \`orderBy\` takes \`duration desc\`, \`start desc\`, \`name\`, \`trace_id\`.

### get_trace
\`\`\`json
{ "projectId": "PROJECT_ID", "traceId": "TRACE_ID" }
\`\`\`

### list_group_stats
\`\`\`json
{ "projectName": "projects/PROJECT_ID", "timeRangePeriod": "PERIOD_6_HOURS", "order": "COUNT_DESC", "pageSize": 20 }
\`\`\`
\`timeRangePeriod\`: PERIOD_1_HOUR, PERIOD_6_HOURS, PERIOD_1_DAY, PERIOD_1_WEEK, PERIOD_30_DAYS. \`order\`: COUNT_DESC, LAST_SEEN_DESC, CREATED_DESC, AFFECTED_USERS_DESC. There is no custom start/end time.

### list_metric_descriptors
\`\`\`json
{ "name": "projects/PROJECT_ID", "filter": "metric.type = starts_with(\\"run.googleapis.com\\")" }
\`\`\`
Use this FIRST when you don't know the exact metric type.

### Other tools
- \`list_alerts\` (\`parent: "projects/PROJECT_ID"\`, \`filter: 'state="OPEN"'\`): active and past incidents. Check it to see what fires now.
- \`list_alert_policies\` (\`name: "projects/PROJECT_ID"\`): configured alert conditions and thresholds.
- \`list_log_names\`, \`list_buckets\`, \`list_views\`, \`list_sinks\`, \`list_log_scopes\` (\`parent\`): log discovery and routing setup.`;

const GCP_ANTI_PATTERNS = `## Common Mistakes — AVOID THESE

### Filter Syntax Errors
1. Using bare \`PROJECT_ID\` where \`"projects/PROJECT_ID"\` is required (\`list_log_entries\` takes \`resourceNames: ["projects/ID"]\`; \`list_time_series\`, \`list_metric_descriptors\`, \`list_alert_policies\` take \`name\`; \`list_group_stats\` takes \`projectName\`)
2. Quoting severity: \`severity >= ERROR\` NOT \`severity >= "ERROR"\`
3. Boolean operators MUST be uppercase: \`AND\`, \`OR\`, \`NOT\` — lowercase \`and\`/\`or\`/\`not\` silently fails or produces wrong results
4. \`:\` (has/substring) vs \`=\` (exact match) confusion: \`textPayload:"error"\` matches substring, \`textPayload="error"\` requires exact string equality. Use \`:\` for searching within messages.
5. Using SQL syntax in Cloud Logging filters — it is NOT SQL (no WHERE, SELECT, FROM)
6. Missing \`interval\` for \`list_time_series\` — it is REQUIRED
7. Sending \`timeRange\` start/end to \`list_group_stats\` — use \`timeRangePeriod\` and \`order\`
8. Forgetting \`orderBy: "timestamp desc"\` — default returns oldest entries first

### Tool Misuse
9. Using \`list_group_stats\` to search for a specific error — it returns GROUPED error patterns by stack trace similarity, NOT arbitrary error log searches. For specific error text, use \`list_log_entries\` with \`textPayload:"your error message"\`.
10. Expecting full trace details from \`list_traces\` — it returns ROOT SPAN ONLY. You MUST call \`get_trace\` with the \`traceId\` to see the full span tree.
11. Guessing metric types — use \`list_metric_descriptors\` first if unsure. Metric type strings must be exact.

### Platform Gotchas
12. Cloud Run STDOUT/STDERR loses severity — apps writing plain text to stdout produce \`textPayload\` with \`severity=DEFAULT\`. Only structured JSON output preserves severity levels.
13. Trace filter syntax: no spaces allowed except between separate filter terms. Misspelled filter keys silently become label filters instead of erroring.
14. \`source()\` at org/folder level does NOT include child project logs — query each project explicitly.
15. Query performance: >200 time series buckets degrades response time. Use tighter filters or coarser \`alignmentPeriod\`.
16. Empty results with no filter adjustments — try: broader time range, remove resource.type filter, or filter by just \`severity>=ERROR\``;

const GCP_QUERY_DEFAULTS = `## Query Defaults
- Use a **specific filter**. Filter by severity, resource type, service name, or time window.
- Choose pageSize so the page shows what you need. Results show what the API returned (up to a text limit). When a result says it shows N of M, narrow the filter or the window, or lower pageSize.
- There is no page token. For more logs, repeat the call with \`timestamp < "<oldest timestamp seen>"\` added to the filter and \`orderBy: "timestamp desc"\`.
- For metrics: fetch the metric types the question needs. Avoid broad dumps.`;

const GCP_FIELD_REFERENCE = `## GCP Field Reference & Payload Types

### Log Entry Payload Inconsistencies
| Concept | textPayload | jsonPayload | protoPayload (audit) |
|---------|------------|-------------|---------------------|
| Message | the entire string | \`.message\`, \`.msg\`, \`.error\`, \`.text\` | \`.status.message\` |
| Severity | top-level \`severity\` | top-level \`severity\` | top-level \`severity\` |
| Error detail | search the text | \`.error\`, \`.exception\`, \`.stack_trace\` | \`.status.code\` + \`.status.message\` |
| HTTP info | not structured | \`.httpRequest.*\` | \`.requestMetadata.*\` |
| User/principal | not available | app-specific | \`.authenticationInfo.principalEmail\` |

Cloud Run STDOUT/STDERR → \`textPayload\` with **severity=DEFAULT** (original severity is LOST).
Cloud Run structured JSON → \`jsonPayload\` with proper severity IF the app writes JSON to stdout.

### Cross-Signal Field Mapping
| Concept | Log Entry | Trace/Span | Metric | Error Reporting |
|---------|-----------|------------|--------|-----------------|
| Trace link | \`trace\` = \`"projects/P/traces/ID"\` | \`traceId\` (bare hex) | — | — |
| Span link | \`spanId\` | \`spanId\` | — | — |
| Service | \`resource.labels.service_name\` | span \`displayName\` or labels | \`resource.labels.service_name\` | \`serviceContext.service\` |
| Project | \`resource.labels.project_id\` | \`projectId\` parameter | \`name\` = \`projects/ID\` | \`projectId\` parameter |
| Timestamp | \`timestamp\` (RFC3339) | \`startTime\`/\`endTime\` (RFC3339) | \`interval.startTime\`/\`endTime\` | \`firstSeenTime\`/\`lastSeenTime\` |

### CRITICAL: Trace ID Format Mismatch
- In logs: \`trace\` = \`"projects/my-project/traces/abc123def456"\` (full resource path)
- In traces: \`traceId\` = \`"abc123def456"\` (bare hex string)
- Logs → Traces: STRIP the prefix — extract hex ID after \`/traces/\`
- Traces → Logs: ADD the prefix — \`trace="projects/PROJECT/traces/TRACE_ID"\`

### Error Reporting Structure
- \`list_group_stats\` returns: \`group.groupId\`, \`count\`, \`affectedUsersCount\`, \`affectedServices\`, \`firstSeenTime\`, \`lastSeenTime\`, \`representative.message\`
- Error groups are clustered by STACK TRACE SIMILARITY — they are for recurring exceptions, NOT arbitrary error searches
- To search for a specific error message, use \`list_log_entries\` with \`severity>=ERROR\` and \`textPayload:"message"\` or \`jsonPayload.message:"message"\``;

export const GCP_CROSS_SIGNAL = `## Cross-Signal Correlation
- **Logs → Traces**: Log entries have a \`trace\` field (format: \`"projects/P/traces/TRACE_ID"\`). Extract TRACE_ID and use \`get_trace\`.
- **Logs → Metrics**: \`resource.type\` + \`resource.labels\` in logs match metric filters — same service in logs = same filter in metrics.
- **Error Reporting → Logs**: Use the error message from \`list_group_stats\` to filter logs: \`textPayload:"<message>"\`.
- **Traces → Logs**: Filter logs by trace ID: \`trace="projects/PROJECT/traces/TRACE_ID"\``;

export const GCP_INSIDE_OUT_DEBUGGING = `## Inside-Out Debugging

**With a specific identifier** (service name, error message, trace ID):
1. Start with the signal that matches the question: logs for an error text (\`list_log_entries\` with a filter for that identifier), metrics for latency or saturation, traces for a request path.
2. Extract context — resource type, service name, trace ID, severity pattern, timestamps.
3. Follow the chain. A log error or a slow span is a link, not the end. Use \`get_trace\` to see which child span or downstream service took the time or failed. Investigate that service the same way. Use \`list_time_series\` to find the onset and compare it with a normal window.
4. If multiple trace IDs surface, investigate 1-2 representative samples. Then count how many of all matching entries share their pattern (a filtered log count or Error Reporting group counts). Only a count makes it THE pattern.

**Without a specific identifier** (vague symptoms):
1. Look at what is happening — \`list_log_entries\` with \`severity>=ERROR\`, plus metrics for the affected resource.
2. Check Error Reporting — \`list_group_stats\` for grouped patterns.
3. Once you have a specific identifier, switch to the "with identifier" flow above.

**Diagnostic safeguards:**
- **No data?** Check the project, the resource type, the labels and the window. Widen the window. Remove the resource.type filter. Report no data only when the source holds nothing for the entity.
- **Suspiciously few results?** Check the filter syntax — remember: boolean operators must be uppercase (AND, OR, NOT), severity is unquoted, string values must be double-quoted.

**Moving across the system:**
- Service to callees: use \`get_trace\` and read the span tree. The child span with the largest share of the time is the next link.
- Service to its database and platform resources: query the metrics of the resource it uses (Cloud SQL, Load Balancing, GKE, GCE) with \`list_time_series\`.
- Compare a revision, instance or pod with its peers. Use labels such as \`revision_name\`, \`instance_id\` or \`pod_name\`. This separates one bad unit from a service-wide cause.
- Changes at the onset: look for a new \`revision_name\` first seen at that time. Check audit logs (\`protoPayload\`) for changes at that time.`;

export const GCP_DOMAIN_KNOWLEDGE = `${GCP_QUERY_DEFAULTS}

${GCP_LOGGING_FILTER_SYNTAX}

${GCP_RESOURCE_TYPES}

${GCP_METRIC_TYPES}

${GCP_FIELD_REFERENCE}

${GCP_TOOL_PARAMS}

${GCP_ANTI_PATTERNS}`;
