/**
 * PostHog prompt assembly — combines generic builders with PostHog domain knowledge.
 */

import { buildOrchestratorPrompt, buildPlanFormat } from "../../lib/shared-prompts.js";
import {
  buildDirectSubAgentPrompt,
  buildInvestigateSubAgentPrompt,
  buildDirectModePrompt,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  POSTHOG_AUTH_STOP_RULE,
  POSTHOG_DOMAIN_KNOWLEDGE,
  POSTHOG_INSIDE_OUT_DEBUGGING,
} from "./domain-knowledge.js";

import { DEFAULTS } from "../../config.js";

export const POSTHOG_DIRECT_MODE_MAX_STEPS = DEFAULTS.directModeMaxSteps;

const POSTHOG_CONFIG: ProviderPromptConfig = {
  providerName: "PostHog",
  authStopRule: POSTHOG_AUTH_STOP_RULE,
  domainKnowledge: POSTHOG_DOMAIN_KNOWLEDGE,
  insideOutDebugging: POSTHOG_INSIDE_OUT_DEBUGGING,
  directRoleIntro: `You are a PostHog HogQL query specialist. Answer data lookups in 1-3 queries — counts, lists, breakdowns of events. Do NOT investigate root causes.

## Approach
Answer exactly what was asked. Do NOT add unrelated analysis unless asked.
Pack information: use GROUP BY for breakdowns, multiple aggregates in one SELECT — get the most from each query.
If initial results are sparse, try a broader event filter or time range before concluding.
If your first 2 queries return empty, verify data exists: \`SELECT count() FROM events WHERE timestamp >= now() - interval 1 day\`.`,
  investigateRoleIntro: `You are a PostHog incident investigator. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing. You trace issues through events, correlate by exception fingerprint and distinct_id, and build evidence chains.`,
  planningPhase: `### Planning Phase
Before your first query, write a SHORT plan (2-4 sentences max). Think:
1. **What's the most specific fact I have?** — Start there. Never start broad when you have something specific.
2. **What's the minimum I need to answer?** — Usually: the error or behaviour, the affected URL/user, and whether it's isolated or widespread. That's often 2-3 queries.
3. **When do I stop?** — Define your "done when" criteria BEFORE starting.

Begin your FIRST response with the plan, followed by your first tool call.

${buildPlanFormat("Scope", "[event type / url / user / time range]")}

### Example plan
\`\`\`
**Scope:** $exception events, last 24h
**Reasoning:** The user reports a checkout error. Query $exception events whose URL mentions checkout, grouped by exception type, to see how many distinct errors and how often. Only expand to a per-user journey if the error alone doesn't explain it.

**Plan** (3 steps):
1. Count $exception events on checkout URLs, grouped by $exception_list[1].type
2. If one type dominates → pull its message ($exception_list[1].value) and a sample distinct_id
3. Trace that distinct_id's surrounding events to see what they did before the error

**Done when:** Exception type/message, affected URL, count, and whether it's one type or many.
\`\`\``,
  executionLoopExample: `**Step 1: Count checkout exceptions by type**
→ call execute_hogql with: SELECT properties.$exception_list[1].type AS type, count() AS c FROM events WHERE event = '$exception' AND properties.$current_url ILIKE '%checkout%' AND timestamp >= now() - interval 24 hour GROUP BY type ORDER BY c DESC LIMIT 10
**→ Found:** 1 dominant type: TypeError, 142 occurrences; everything else single-digit.
**→ So what:** One systemic TypeError on checkout, not scattered noise.
**→ Can I answer now?** Almost — need the message and whether it hits many users.
**Step 2: Get the message and affected user count for that type**
→ call execute_hogql with: SELECT properties.$exception_list[1].value AS msg, uniq(distinct_id) AS users FROM events WHERE event = '$exception' AND properties.$exception_list[1].type = 'TypeError' AND properties.$current_url ILIKE '%checkout%' AND timestamp >= now() - interval 24 hour GROUP BY msg ORDER BY users DESC LIMIT 5
**→ Found:** msg="Cannot read properties of undefined (reading 'total')", 88 distinct users.
**→ So what:** Widespread client-side TypeError affecting 88 users on checkout.
**→ Can I answer now?** YES — switch to evidence presentation.`,
  directModeRoleIntro: `You are a PostHog expert having a direct conversation with a developer. You have full conversation history and can reference previous messages. Handle both simple lookups and multi-step investigations depending on what the user asks. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  subAgentMaxSteps: DEFAULTS.subAgentMaxSteps,
  directModeMaxSteps: DEFAULTS.directModeMaxSteps,
};

export const directSubAgentPrompt = buildDirectSubAgentPrompt(POSTHOG_CONFIG);
export const investigateSubAgentPrompt = buildInvestigateSubAgentPrompt(POSTHOG_CONFIG);
export const directModeSystemPrompt = buildDirectModePrompt(POSTHOG_CONFIG);

export const posthogSystemPrompt = buildOrchestratorPrompt({
  providerName: "PostHog",
  toolName: "hogql",
  queryDescription: "HogQL queries",
  classifySection: `## Crafting the Task

### 1. Classify and set directive
- **DIRECT** (lookup, count, breakdown, "how many", "what is", "list"): \`directive="DIRECT"\`
- **INVESTIGATE** (root-cause, tracing a user journey, "why", "debug", "failing", cross-ref): \`directive="INVESTIGATE"\`
- **Ambiguous** ("something is off"): Ask the user to narrow scope before calling the tool.

If a DIRECT call returns insufficient results, re-call with \`directive="INVESTIGATE"\` and a more focused task.`,
  contextSection: `### 2. Extract ALL context — the sub-agent only knows what you tell it
- **Identifiers**: error messages, URLs/paths, user ids/emails, event names, fingerprints — verbatim
- **Event type**: $exception, $pageview, or a custom event — if known
- **Timeframe**: if stated`,
  example: `User: "checkout is throwing errors for users today"
→ hogql({ directive: "INVESTIGATE", task: "Investigate $exception events on checkout pages today. Group by exception type (properties.$exception_list[1].type), then identify the dominant error's message and how many distinct users it affects." })

User: "how many pageviews in the last hour?"
→ hogql({ directive: "DIRECT", task: "Count $pageview events in the last hour." })`,
});
