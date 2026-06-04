/**
 * PostHog domain knowledge — HogQL syntax, event model, field references,
 * and debugging methodology. Pure prompt text constants.
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
- Default LIMIT is 100; the max for a programmatic personal-API-key request is 50,000 (set an explicit \`LIMIT\`). **OFFSET pagination is rejected** for personal API keys — paginate with a \`timestamp\` keyset filter instead.
- Time filtering uses \`timestamp\` with ClickHouse intervals: \`WHERE timestamp >= now() - interval 24 hour\`. Also \`toStartOfDay(now())\`, \`toDateTime('2024-01-15 14:00:00')\`.

### Properties
- Event properties: \`properties.$current_url\`, \`properties.$browser\`, or custom \`properties.my_prop\`. PostHog auto-captured properties are prefixed with \`$\`.
- Person properties: \`person.properties.email\`, etc.
- Use \`coalesce(a, b)\` for fallbacks. Strings use single quotes. \`ILIKE\` is case-insensitive matching.

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
- Custom events — any application-defined event name (e.g. \`user signed up\`, \`order completed\`).

### Correlation
- Group repeated errors by \`properties.$exception_list[1].type\` and \`properties.$exception_list[1].value\` (\`$exception_fingerprint\` is optional and frequently null, so don't rely on it alone).
- Follow one actor across events with \`distinct_id\` (or \`person_id\` for identified users).
- Reconstruct a user journey by selecting that \`distinct_id\`'s events ordered by \`timestamp\`.`;

export const POSTHOG_INSIDE_OUT_DEBUGGING = `## Investigation Methodology

**With a specific identifier** (error message, URL, user id/email, event name):
1. Find it — for errors, \`SELECT ... FROM events WHERE event = '$exception' AND properties.$exception_list[1].value ILIKE '%value%'\`. For a user, filter by \`distinct_id\` or \`person.properties.email\`.
2. Extract context — \`properties.$exception_list[1].type\`, \`properties.$exception_list[1].value\`, \`$current_url\`, \`distinct_id\`, \`timestamp\`.
3. Expand only if needed — pull that \`distinct_id\`'s surrounding events ordered by \`timestamp\` to see what the user did before/after.

**Without a specific identifier** (vague symptoms):
1. Quantify — \`SELECT count() FROM events WHERE event = '$exception' AND timestamp >= now() - interval 1 hour\`, then \`GROUP BY properties.$exception_list[1].type\` to see what's spiking.
2. For usage/behaviour questions, \`GROUP BY\` the relevant property (\`$pathname\`, \`$browser\`, a custom property) and order by \`count()\`.

**No data?** If the first couple of queries return empty, verify events exist at all: \`SELECT count() FROM events WHERE timestamp >= now() - interval 1 day\`. If zero, report no data — do not keep guessing.

**Important:** PostHog is a product-analytics + error-tracking tool, NOT an APM. There is no server request duration, throughput, or error-rate metric. Use \`$exception\` events for errors and event \`count()\` for volume; never invent latency or error-rate numbers that PostHog does not record.`;

const POSTHOG_QUERY_DEFAULTS = `## Query Defaults
- Always include a \`timestamp\` filter. Default: \`timestamp >= now() - interval 24 hour\`. "recent" → 1 hour. "today" → \`timestamp >= toStartOfDay(now())\`.
- Default \`LIMIT 10\` for exploratory lookups; increase only when needed.`;

export const POSTHOG_DOMAIN_KNOWLEDGE = `${POSTHOG_QUERY_DEFAULTS}

${POSTHOG_EVENT_MODEL}

${HOGQL_QUICK_REFERENCE}`;
