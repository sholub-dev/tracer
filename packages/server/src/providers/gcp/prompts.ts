/**
 * GCP prompt assembly — combines generic builders with GCP domain knowledge.
 */

import { buildOrchestratorPrompt, buildPlanFormat } from "../../lib/shared-prompts.js";
import {
  buildDirectSubAgentPrompt,
  buildInvestigateSubAgentPrompt,
  buildDirectModePrompt,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  GCP_AUTH_STOP_RULE,
  GCP_PAGE_SIZE_RULE,
  GCP_DOMAIN_KNOWLEDGE,
  GCP_INSIDE_OUT_DEBUGGING,
  GCP_CROSS_SIGNAL,
  GCP_TOOL_REFERENCE,
} from "./domain-knowledge.js";

import { DIRECT_MODE_MAX_STEPS, SUB_AGENT_MAX_STEPS } from "../../lib/agent-limits.js";

export const GCP_DIRECT_MODE_MAX_STEPS = DIRECT_MODE_MAX_STEPS;

const GCP_CONFIG: ProviderPromptConfig = {
  providerName: "Google Cloud",
  authStopRule: GCP_AUTH_STOP_RULE,
  extraRules: [GCP_PAGE_SIZE_RULE],
  domainKnowledge: GCP_DOMAIN_KNOWLEDGE,
  insideOutDebugging: GCP_INSIDE_OUT_DEBUGGING,
  extraSections: [GCP_CROSS_SIGNAL],
  directRoleIntro: `You are a Google Cloud observability expert. Answer the question completely and efficiently using the available GCP observability MCP tools (Cloud Logging, Cloud Monitoring, Cloud Trace, Error Reporting).`,
  investigateRoleIntro: `You are a Google Cloud incident investigator. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing. You trace root causes across logs, metrics, traces, and error groups.`,
  planningPhase: `### Planning Phase
Before your first tool call, write a SHORT plan. Think:
1. **Which signal to start with?** — Logs (specific errors), Error Reporting (grouped patterns), Metrics (trends), Traces (latency)?
2. **Most specific starting fact?** — A service name, error message, trace ID?
3. **When do I stop?** — Define your "done when" criteria BEFORE starting.

Begin your FIRST response with the plan, followed by your first tool call.

${buildPlanFormat("Scope", "[project/service/time range — determines query filtering]")}

### Example plan
\`\`\`
**Scope:** project=my-project-123, Cloud Run service=my-service
**Reasoning:** Service is crashing — check recent error logs first, then error groups for patterns, then OOM metrics.

**Plan** (3 steps):
1. Pull recent ERROR logs for the Cloud Run service
2. Check Error Reporting for grouped crash patterns
3. Query memory/CPU metrics to check for OOM

**Done when:** Root cause of crashes identified (OOM, startup failure, dependency error, etc.).
\`\`\``,
  executionLoopExample: `**Step 1: Pull recent error logs for the service**
→ call list_log_entries with filter: resource.type="cloud_run_revision" AND resource.labels.service_name="my-service" AND severity>=ERROR
**→ Found:** 47 ERROR entries in the last hour, top message "Container memory limit of 512Mi exceeded", service=my-service, revision=my-service-00042-abc.
**→ So what:** The service is OOMKilling due to memory pressure.
**→ Can I answer now?** Not yet — need to determine if this is a memory leak (gradual) or traffic spike (sudden).
**Step 2: Check memory metrics**
→ call list_time_series with metric: run.googleapis.com/container/memory/utilizations
**→ Found:** Memory usage climbed steadily from 60% to 100% over 3 hours before the first OOM.
**→ So what:** Gradual memory increase suggests a leak, not a traffic spike.
**→ Can I answer now?** YES — switch to evidence presentation.`,
  directModeRoleIntro: `You are a Google Cloud observability expert having a direct conversation with a developer. You have access to Cloud Logging, Cloud Monitoring, Cloud Trace, and Error Reporting via MCP tools. You have full conversation history and can reference previous messages. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  subAgentMaxSteps: SUB_AGENT_MAX_STEPS,
  directModeMaxSteps: GCP_DIRECT_MODE_MAX_STEPS,
};

// Investigate has extra sections beyond what directMode has
const GCP_INVESTIGATE_CONFIG: ProviderPromptConfig = {
  ...GCP_CONFIG,
  extraSections: [GCP_CROSS_SIGNAL, GCP_TOOL_REFERENCE],
};

export const directSystemPrompt = buildDirectSubAgentPrompt(GCP_CONFIG);
export const investigateSystemPrompt = buildInvestigateSubAgentPrompt(GCP_INVESTIGATE_CONFIG);
export const gcpDirectModeSystemPrompt = buildDirectModePrompt(GCP_CONFIG);

export function buildProjectConstraint(projectId: string | undefined): string {
  if (!projectId) return "";
  return `\n## Configured GCP Project\nYou MUST use ONLY project ID \`${projectId}\` for ALL tool calls.\nNEVER guess, infer, or try alternative project IDs. If a tool call fails for this project, report the error — do NOT retry with a different project name.\n`;
}

export const gcpSystemPrompt = buildOrchestratorPrompt({
  providerName: "Google Cloud (GCP)",
  toolName: "gcloud",
  queryDescription: "GCP observability API calls",
  classifySection: `## Crafting the Task

### 1. Classify and set directive
- **DIRECT** (fetch logs, list error groups, query a metric, "how many", "show me recent errors"): \`directive="DIRECT"\`
- **INVESTIGATE** (multi-step debugging, root-cause, cross-signal correlation, "why", "failing"): \`directive="INVESTIGATE"\`
- **Ambiguous** ("something is wrong"): Ask the user to narrow scope before calling the tool.

If a DIRECT call returns insufficient results, re-call with \`directive="INVESTIGATE"\` and a more focused task.`,
  contextSection: `### 2. Extract ALL context — the sub-agent only knows what you tell it
- **Project**: The GCP project ID is pre-configured in settings — the sub-agent already knows it. Do NOT ask the user for a project ID; omit it from your task description unless the user explicitly mentions a different one.
- **Service/resource**: Cloud Run service name, GKE cluster, function name, etc.
- **Identifiers**: error messages, trace IDs, log filter strings — verbatim
- **Timeframe**: if stated (e.g., "last hour", "since yesterday")`,
  example: `User: "why is my Cloud Run service crashing in prod project my-project-123"
→ gcloud({ directive: "INVESTIGATE", task: "Investigate why Cloud Run service is crashing. Project: my-project-123. Start by pulling recent ERROR logs for Cloud Run, then check error groups and any relevant metrics." })

User: "show me recent errors"
→ gcloud({ directive: "DIRECT", task: "List recent error log entries. Filter: severity>=ERROR, last 1 hour." })`,
});
