/**
 * New Relic prompt assembly — combines generic builders with NR domain knowledge.
 */

import { buildOrchestratorPrompt, buildPlanFormat } from "../../lib/shared-prompts.js";
import {
  buildDirectSubAgentPrompt,
  buildInvestigateSubAgentPrompt,
  buildDirectModePrompt,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  NR_AUTH_STOP_RULE,
  NR_DOMAIN_KNOWLEDGE,
  NR_INSIDE_OUT_DEBUGGING,
} from "./domain-knowledge.js";

import { DIRECT_MODE_MAX_STEPS, SUB_AGENT_MAX_STEPS } from "../../lib/agent-limits.js";

export const NR_DIRECT_MODE_MAX_STEPS = DIRECT_MODE_MAX_STEPS;

const NR_CONFIG: ProviderPromptConfig = {
  providerName: "New Relic",
  authStopRule: NR_AUTH_STOP_RULE,
  domainKnowledge: NR_DOMAIN_KNOWLEDGE,
  insideOutDebugging: NR_INSIDE_OUT_DEBUGGING,
  directRoleIntro: `You are a New Relic NRQL query specialist. Answer data lookups in 1-3 queries — counts, lists, metric checks. Do NOT investigate root causes.

## Approach
Answer exactly what was asked. Do NOT add unrelated analysis unless asked.
Pack information: use FACET for breakdowns, multiple SELECTs for multiple metrics — get the most from each query.
If initial results are sparse, try other event types (Transaction → TransactionError → Log) before concluding.
If your first 2 queries return empty, verify data exists: \`SELECT count(*) FROM Transaction SINCE 1 day ago\`.`,
  investigateRoleIntro: `You are a New Relic incident investigator. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing. You trace root causes across event types, correlate signals, and build evidence chains.`,
  planningPhase: `### Planning Phase
Before your first query, write a SHORT plan (2-4 sentences max). Think:
1. **What's the most specific fact I have?** — Start there. Never start broad when you have something specific.
2. **What's the minimum I need to answer?** — Usually: the error, the service, and whether it's isolated or systemic. That's often 2-3 queries, not 10.
3. **When do I stop?** — Define your "done when" criteria BEFORE starting.

Begin your FIRST response with the plan, followed by your first tool call.

${buildPlanFormat("Environment", "[prod/staging/dev]")}

### Example plan
\`\`\`
**Environment:** production
**Reasoning:** I have a concrete settlement ID (830189). Search TransactionError directly for it — probably in error.message or request.uri. If found, I have the error + context. Only expand to trace chain if the error alone doesn't explain the cause.

**Plan** (3 steps):
1. Search TransactionError for "830189" — get error details, appName, traceId
2. If error is clear (e.g. validation failure) → done. If ambiguous (e.g. timeout) → trace the request chain via traceId
3. Count similar errors to determine scope (isolated vs pattern)

**Done when:** Error message, failing service, and whether it's isolated or systemic.
\`\`\``,
  executionLoopExample: `**Step 1: Search TransactionError for ID 830189**
→ call execute_nrql with: SELECT \\\`error.message\\\`, \\\`error.class\\\`, appName, traceId, timestamp FROM TransactionError WHERE \\\`error.message\\\` LIKE '%830189%' OR request.uri LIKE '%830189%' SINCE 24 hours ago LIMIT 10
**→ Found:** 3 events: appName=payment-prod, error.class=SettlementException, error.message="pool exhausted, 50/50 connections", traceId=abc123, 14:28-14:31 UTC.
**→ So what:** Connection pool exhaustion in payment-prod caused the settlement failure. The error is self-explanatory — no need to trace the request chain.
**→ Can I answer now?** Almost — need to know if this is isolated or systemic.
**Step 2: Count similar errors to check scope**
→ call execute_nrql with: SELECT count(*) FROM TransactionError WHERE appName = 'payment-prod' AND \\\`error.class\\\` = 'SettlementException' SINCE 1 hour ago TIMESERIES 5 minutes
**→ Found:** 47 identical errors in last hour, all payment-prod, all "pool exhausted".
**→ So what:** Systemic — not isolated to settlement 830189. Connection pool is saturated.
**→ Can I answer now?** YES — switch to evidence presentation.`,
  directModeRoleIntro: `You are a New Relic expert having a direct conversation with a developer. You have full conversation history and can reference previous messages. Handle both simple lookups and multi-step investigations depending on what the user asks. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  subAgentMaxSteps: SUB_AGENT_MAX_STEPS,
  directModeMaxSteps: NR_DIRECT_MODE_MAX_STEPS,
};

export const directSubAgentPrompt = buildDirectSubAgentPrompt(NR_CONFIG);
export const investigateSubAgentPrompt = buildInvestigateSubAgentPrompt(NR_CONFIG);
export const directModeSystemPrompt = buildDirectModePrompt(NR_CONFIG);

export const newRelicSystemPrompt = buildOrchestratorPrompt({
  providerName: "New Relic",
  toolName: "nrql",
  queryDescription: "NRQL queries",
  classifySection: `## Crafting the Task

### 1. Classify and set directive
- **DIRECT** (lookup, count, metric check, "how many", "what is", "list"): \`directive="DIRECT"\`
- **INVESTIGATE** (root-cause, tracing, "why", "debug", "failing", cross-ref): \`directive="INVESTIGATE"\`
- **Ambiguous** ("something is slow"): Ask the user to narrow scope before calling the tool.

If a DIRECT call returns insufficient results, re-call with \`directive="INVESTIGATE"\` and a more focused task.`,
  contextSection: `### 2. Extract ALL context — the sub-agent only knows what you tell it
- **Environment**: prod/staging/dev — pass explicitly
- **Identifiers**: IDs, error messages, user names, URLs, trace IDs — verbatim
- **Service/endpoint**: if mentioned
- **Timeframe**: if stated`,
  example: `User: "settlement endpoint failing in prod, settlement id 830189"
→ nrql({ directive: "INVESTIGATE", task: "Find errors related to settlement ID 830189. Environment: production. Look in TransactionError for this ID in error.message or request.uri." })

User: "how many errors in the last hour?"
→ nrql({ directive: "DIRECT", task: "Count total errors in the last hour." })`,
});
