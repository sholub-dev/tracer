/**
 * PostHog domain knowledge — HogQL syntax, event model, field references,
 * anti-patterns, schema discovery, and debugging methodology. Pure prompt text constants.
 */

export const POSTHOG_AUTH_STOP_RULE = `## Authentication Failure — STOP IMMEDIATELY
If any query returns an authentication or permission error (e.g. "Invalid personal API key", "401", "403", "Unauthorized", "Forbidden"), **STOP ALL FURTHER TOOL CALLS** and report:
1. The exact error message received.
2. That the PostHog personal API key (and its scopes) and Project ID need to be checked in Settings.
Do NOT retry — auth errors cannot be resolved by the sub-agent.`;

const HOGQL_QUICK_REFERENCE = `## HogQL Reference

HogQL is PostHog's SQL dialect (ClickHouse SQL under the hood). Queries read from analytics tables — primarily \`events\`.

### Clauses
- \`SELECT ... FROM events\` — the main table. Standard SQL: \`WHERE\`, \`GROUP BY\`, \`HAVING\`, \`ORDER BY\`, \`LIMIT\`. Unlike NRQL, HogQL HAS \`GROUP BY\` and \`DISTINCT\`.
- **LIMIT:** the API applies \`LIMIT 100\` when you omit one. For exploration set an explicit small \`LIMIT\` (10); increase to 20-50 only when needed; never start with 100+. Max for a personal-API-key request is 50,000. **OFFSET pagination is rejected** for personal API keys — paginate with a \`timestamp\` keyset filter instead.
- Time filtering uses \`timestamp\` with ClickHouse intervals: \`WHERE timestamp >= now() - interval 24 hour\`. Also \`toStartOfDay(now())\`, \`toDateTime('2024-01-15 14:00:00')\`.
- **Trends over time render as a line chart.** For any "over time" / "trend" / "by hour|day" question, \`GROUP BY\` a time bucket — \`toStartOfMinute|Hour|Day(timestamp)\` — select it as the FIRST column alongside your metric(s), and \`ORDER BY\` it. One numeric metric (optionally one breakdown column for multiple lines) plots as a timeseries; otherwise results show as a table. Example: \`SELECT toStartOfHour(timestamp) AS t, count() AS events FROM events WHERE timestamp >= now() - interval 24 hour GROUP BY t ORDER BY t\`.

### Properties
- Event properties: \`properties.$current_url\`, \`properties.$browser\`, or custom \`properties.my_prop\`. PostHog auto-captured properties are prefixed with \`$\`.
- Person properties: \`person.properties.email\`, etc.
- Use \`coalesce(a, b)\` for fallbacks. Strings use single quotes. \`ILIKE\` is case-insensitive matching; plain \`LIKE\` is case-sensitive.

### Functions
- Aggregation: \`count()\`, \`countIf(cond)\`, \`uniq(expr)\`, \`avg()\`, \`sum()\`, \`min()\`, \`max()\`, \`quantile(0.95)(expr)\`.
- Time: \`now()\`, \`toStartOfDay/Hour/Week/Month(ts)\`, \`dateDiff('unit', a, b)\`, \`toDate(ts)\`.
- String: \`concat()\`, \`lower()\`, \`upper()\`, \`length()\`, \`substring()\`, \`splitByChar()\`.`;

const POSTHOG_EVENT_MODEL = `## Event Model & Key Events

Everything PostHog records lives in the \`events\` table. There is **one row per event**, each with an \`event\` name, a \`timestamp\`, a \`distinct_id\` (the actor), and a JSON \`properties\` map.

Key auto-captured events:
- \`$pageview\` / \`$pageleave\` — navigation. Useful properties: \`$current_url\`, \`$pathname\`, \`$referrer\`.
- \`$autocapture\` — clicks and form interactions captured automatically.
- \`$exception\` — front-end errors / exceptions (PostHog Error Tracking). The exception type and message live INSIDE the \`$exception_list\` array (1-indexed): read them as \`properties.$exception_list[1].type\` and \`properties.$exception_list[1].value\` — there are no flat \`$exception_type\`/\`$exception_message\` properties on current SDKs. \`$exception_fingerprint\` is an OPTIONAL top-level property (only set when a custom fingerprint was provided, so it is often null); \`$exception_level\` holds severity.
- \`$identify\` — links an anonymous \`distinct_id\` to an identified person.
- Custom events — any application-defined event name (e.g. \`user signed up\`, \`order completed\`).`;

const POSTHOG_CROSS_SIGNAL = `## Cross-Signal Correlation
- **Actor identity:** \`distinct_id\` is the actor on every event; \`person_id\` is the identified user. \`$identify\` links an anonymous \`distinct_id\` to an identified person. Follow one actor across events with \`distinct_id\` (or \`person_id\` for identified users).
- **User journey:** reconstruct what an actor did by selecting that \`distinct_id\`'s events \`ORDER BY timestamp\` — the events before/after the one of interest are the context.
- **Session grouping:** \`properties.$session_id\` ties events within a single session together.
- **Error grouping:** group repeated errors by \`properties.$exception_list[1].type\` + \`properties.$exception_list[1].value\` (\`$exception_fingerprint\` is optional and frequently null, so don't rely on it alone).
- **Diagnostic shortcut:** What's erroring? → \`$exception\` FACET by type | Who's affected? → \`uniq(distinct_id)\` | What did one user do? → that \`distinct_id\`'s events ORDER BY timestamp | Usage/volume → event \`count()\` GROUP BY property.`;

const POSTHOG_ANTI_PATTERNS = `## Common Mistakes — AVOID THESE
- \`LIKE\` is **case-sensitive**. For case-insensitive matching use \`ILIKE '%pattern%'\`.
- Exceptions: \`$exception_list\` is **1-indexed** — read \`properties.$exception_list[1].type\` / \`[1].value\`. There are NO flat \`$exception_type\` / \`$exception_message\` properties; filtering on those returns empty.
- \`$exception_fingerprint\` is frequently NULL — dedup errors by \`type\` + \`value\`, never by fingerprint alone.
- **OFFSET pagination is rejected** for personal API keys — paginate with a \`timestamp\` keyset filter, not \`OFFSET\`.
- PostHog is **NOT an APM**. There is no server request duration, throughput, or error-rate metric. Use \`$exception\` events for errors and event \`count()\` for volume; never invent latency or error-rate numbers PostHog does not record.
- Don't \`SELECT *\` over long ranges — aggregate with \`count()\` / \`GROUP BY\` instead.
- Property namespaces differ: event properties are \`properties.$x\`; person properties are \`person.properties.x\`. Confusing the two returns empty results.
- String literals use single quotes; to include a literal single quote, double it (e.g. \`'O''Brien'\`). Don't add unnecessary backslash escapes.`;

const POSTHOG_SCHEMA_DISCOVERY = `## Schema Discovery (only when stuck)
You have no fixed property catalog. When you don't know the event name or which properties exist, discover them — but only when you don't already have a concrete value to filter on:
- **Event names:** \`SELECT event, count() FROM events WHERE timestamp >= now() - interval 7 day GROUP BY event ORDER BY count() DESC LIMIT 50\` — shows which events actually fire and how often.
- **An event's properties:** \`SELECT properties FROM events WHERE event = '...' ORDER BY timestamp DESC LIMIT 1\` — inspect one recent row's JSON to see the available keys, then query those keys directly.

**NEVER start with schema discovery when you already have a specific value** (an error message, URL, user id, event name) — go straight to the filtered query.`;

export const POSTHOG_INSIDE_OUT_DEBUGGING = `## Investigation Methodology

**With a specific identifier** (error message, URL, user id/email, event name):
1. Find it — for errors, \`SELECT ... FROM events WHERE event = '$exception' AND properties.$exception_list[1].value ILIKE '%value%'\`. For a user, filter by \`distinct_id\` or \`person.properties.email\`.
2. Extract context — \`properties.$exception_list[1].type\`, \`properties.$exception_list[1].value\`, \`$current_url\`, \`distinct_id\`, \`timestamp\`.
3. Expand ONLY if needed — pull that \`distinct_id\`'s surrounding events ordered by \`timestamp\` to see what the user did before/after, but only if the error context doesn't already answer the question.
4. If multiple matches surface, investigate 1-2 representative samples. If they show the same pattern, STOP — that IS the pattern.

**Without a specific identifier** (vague symptoms):
1. Golden signals — get multiple signals in ONE query: \`SELECT count() AS total, uniq(distinct_id) AS users, countIf(event = '$exception') AS errors FROM events WHERE timestamp >= now() - interval 1 hour\`. Don't run separate single-metric counts.
2. Scope — \`GROUP BY\` the relevant property (\`properties.$exception_list[1].type\`, \`$pathname\`, \`$browser\`, a custom property) and order by \`count()\` to see what's spiking.
3. Once you have a specific identifier, switch to the "with identifier" flow above.

**Diagnostic safeguards:**
- **No data?** If the first couple of queries return empty, verify events exist at all: \`SELECT count() FROM events WHERE timestamp >= now() - interval 1 day\`. If zero, report no data — stop investigating, do not keep guessing.

**Important:** PostHog is a product-analytics + error-tracking tool, NOT an APM. There is no server request duration, throughput, or error-rate metric. Use \`$exception\` events for errors and event \`count()\` for volume; never invent latency or error-rate numbers that PostHog does not record.`;

const POSTHOG_QUERY_DEFAULTS = `## Query Defaults
- Always include a \`timestamp\` filter. Default: \`timestamp >= now() - interval 24 hour\`. "recent" → 1 hour. "today" → \`timestamp >= toStartOfDay(now())\`.
- Default \`LIMIT 10\` for exploratory lookups. Increase to 20-50 only when needed; never start with 100+.`;

export const POSTHOG_DOMAIN_KNOWLEDGE = `${POSTHOG_QUERY_DEFAULTS}

${POSTHOG_EVENT_MODEL}

${POSTHOG_CROSS_SIGNAL}

${HOGQL_QUICK_REFERENCE}

${POSTHOG_ANTI_PATTERNS}

${POSTHOG_SCHEMA_DISCOVERY}`;
