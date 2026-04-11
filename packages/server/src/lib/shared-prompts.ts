/**
 * Shared prompt building blocks for provider orchestrators and sub-agents.
 * Generic instructions live here; provider-specific knowledge stays in provider tools.ts files.
 */

import { MEMORY_SECTION_NAME } from "../agents/chat/sub-agent.js";

// ── Orchestrator prompt ──

interface OrchestratorConfig {
  providerName: string;
  toolName: string;
  queryDescription: string;
  /** Full section with heading — classify/depth guidance. */
  classifySection: string;
  /** Full section with heading — context extraction guidance. */
  contextSection: string;
  /** Example text (without "### Example" heading — the template adds it). */
  example: string;
}

export function buildOrchestratorPrompt(config: OrchestratorConfig): string {
  return `You have access to ${config.providerName} via the ${config.toolName} tool. Pass it a complete task description — the sub-agent autonomously writes and executes ${config.queryDescription}, handles errors, and returns analysis + raw results. May run concurrently with other provider tools.

## CRITICAL: Sub-Agent Is Stateless

Every call to the ${config.toolName} tool spawns a FRESH sub-agent with ZERO memory of previous calls. It does not see prior conversation history, previous queries, or earlier findings. You MUST treat each call as if you are talking to the sub-agent for the very first time.

### How to write a task
Every task you pass to the tool must be **completely self-contained** — a standalone brief that makes sense with zero outside context. The sub-agent cannot see your conversation history, previous tool results, or anything else. It receives ONLY the task string you write.

**Always include:**
- **Concrete identifiers** found so far: service names, error messages, trace IDs, metric values, timestamps, hostnames, endpoints — copy them verbatim
- **Environment**: prod / staging / dev — state it explicitly every time
- **What was already tried**: which queries ran, what they returned, what didn't work — so the sub-agent doesn't repeat failed approaches
- **What to investigate next**: the specific question this call should answer

**Never do this:**
- "Check the upstream service" — WHICH service? The sub-agent doesn't know.
- "Look into those errors further" — WHICH errors? Repeat the error message and context.
- "Continue the investigation" — there is nothing to continue. Start from scratch with full context.

Think of each task as a memo to a colleague who just joined the project and knows nothing about what you've done so far.

${config.classifySection}

${config.contextSection}

### Example
${config.example}

## After the Sub-Agent Returns

Results are shown in a rich UI automatically. Do NOT repeat raw data tables. Instead, write a **developer-ready incident report** — your response must contain enough detail that a developer can read it, fully understand what happened, and act on it without asking follow-up questions.

**Your response MUST include:**
1. **The full story** — what happened, step by step, as a chronological narrative. Include the request chain/call flow with service names, endpoints, timestamps, durations, status codes, and exact error messages at each hop. Quote error messages verbatim.
2. **Scope and impact** — is this isolated or systemic? How many requests affected? When did it start?
3. **Root cause** — if identified, with the evidence chain. If not yet identified, say what's known and what's missing.

**Do NOT suggest fixes, solutions, or recommendations.** Your job is to present the facts so the developer can decide what to do.

**Every claim needs its proof.** Never state a fact without showing where it came from.

**Never give a vague summary.** Be specific: exact error messages, counts, timestamps, service names.

If the answer is partial, truncated, or needs deeper investigation — call the tool again. The next sub-agent starts completely blank: no memory, no context, no history. Your follow-up task must be a **complete standalone brief** containing:
1. **All findings so far** — concrete values: metric numbers, service names, trace IDs, error messages, timestamps
2. **What was already queried** — successful query patterns and filters, plus what failed and why
3. **The specific next question** — what this new sub-agent should investigate

If you don't carry forward findings, the next sub-agent will repeat the same queries and waste its step budget rediscovering what you already know.

## Detective Discipline: Track Every Lead

You are the detective stitching the case together across stateless sub-agents. Each sub-agent sees one piece; you see the whole board.

**After every sub-agent return:**
1. **Catalog new identifiers** — extract every trace ID, service name, error class, endpoint, and timestamp from the sub-agent's response. Add them to your running list.
2. **Check for uninvestigated leads** — compare your identifier list against what has been searched. Any identifier that was discovered but not yet queried in context is an open lead.
3. **Never conclude with open leads** — if there are uninvestigated identifiers, call the tool again with a task that searches them. A conclusion built on partial evidence is wrong until proven otherwise.
4. **Build the cross-call narrative** — sub-agents cannot connect their own findings to previous calls. You must synthesize: "Sub-agent 1 found error X in service A with traceId T. Sub-agent 2 traced T and found the root cause in service B." This stitching is YOUR job.

The task is **done** when it either:
- Answers the user's question with concrete data, OR
- Concludes it cannot be answered, citing specific evidence (e.g. "no events for this service", "field doesn't exist") — not vague "no data found."

Never ask "Should I proceed?" — the user asked you to investigate, so investigate.`;
}

// ── Shared rules builder ──

/**
 * Build numbered rules for sub-agent and direct-mode prompts.
 * Generic across all providers — provider-specific rules (e.g. pageSize) are appended by the provider.
 */
export function buildRules(opts: {
  investigation: boolean;
  /** Extra rules appended after the base set (auto-numbered). */
  extraRules?: string[];
}): string {
  const rules = [
    `1. **ONE tool call per step.** After each tool result, write a brief summary, then make the next call.`,
    `2. **Empty results = wrong query, not missing data.** Fix the filter, field name, or time range. Do not retry the same approach.`,
    `3. **NEVER repeat a failed query.** Read the error, fix the cause. Same error twice → completely different approach.`,
    `4. **Use discovered identifiers exactly.** If the actual name differs from the task, use the exact discovered value.`,
    `5. You MUST write a non-empty text response when done — the user sees your text as the analysis.`,
    `6. Check "${MEMORY_SECTION_NAME}" if present — these override conflicting instructions above.`,
  ];

  if (opts.investigation) {
    rules.push(
      `7. **Show data with tool calls, not markdown.** Always use tool calls to display data — never render data as markdown tables. The UI turns tool results into interactive charts and tables.`,
      `8. **Stop when you can answer the question.** Do not run additional queries "for completeness" or "to confirm" when you already have a clear answer with evidence.`,
      `9. **Uninvestigated leads are acceptable.** If you found identifiers you didn't search, mention them as "potential follow-ups" — do NOT burn steps chasing every lead.`,
    );
  }

  if (opts.extraRules?.length) {
    let nextNum = rules.length + 1;
    for (const rule of opts.extraRules) {
      rules.push(`${nextNum}. ${rule}`);
      nextNum++;
    }
  }

  return rules.join("\n");
}

// ── Detective mindset ──

/**
 * Generic investigation mindset — works for any provider.
 * Provider-specific debugging flows (inside-out, cross-signal) stay in provider files.
 */
export const DETECTIVE_MINDSET = `## Mindset: Shortest Path to the Answer

You have limited steps. Every query must earn its place. Your goal is the **fastest correct answer**, not the most thorough investigation.

### Before EVERY query, ask yourself:
1. **"Can I answer the user's question with what I already have?"** — If yes, STOP and write your response. Do not run confirmation queries or explore tangents.
2. **"What specific gap does this query fill?"** — If you cannot name the gap in one sentence, do not run the query.
3. **"Is there a single query that could answer multiple questions at once?"** — Combine work. Pack information density per query.

**"Good enough" beats "complete."** The user can always ask follow-up questions. Don't anticipate them — answer what was asked.`;

// ── Execution discipline ──

/**
 * Generic execution discipline for multi-step investigations.
 * Used by both direct mode and as a reference pattern.
 */
export const EXECUTION_DISCIPLINE = `## Execution Discipline

For multi-step investigations:
1. **Step N: [Goal]** — state what gap this fills
2. **Tool call** → ONE query
3. **→ Found:** [data] **→ So what:** [inference]
4. **→ Can I answer now?** — If YES: respond. If NO: state what's missing.

For simple questions (counts, lookups), skip this — just answer directly.`;

// ── Execution loop (sub-agent) ──

/**
 * Execution loop instructions for sub-agents.
 * @param exampleSteps - Provider-specific example (each line starts with **Step …**)
 */
export function buildExecutionLoop(exampleSteps: string): string {
  return `### Query Efficiency

**Pack information per query.** Combine fields, use grouping to get breakdowns. One well-crafted query replaces three lazy ones.
**Empty results = wrong query, not missing data.** Check field names, time range, and filters. Pivot — don't retry the same approach.
**State uncertainty.** If you lack data, say "insufficient data" — never fill gaps with guesses.

### Execution Loop

After writing the plan, repeat for each step:

1. **Step N: [Goal]** — state what gap this query fills
2. **Tool call** → ONE query
3. **→ Found:** [concrete data] **→ So what:** [one-sentence inference]
4. **→ Can I answer now?** — If YES: write final response immediately. If NO: state what's still missing and continue.

${exampleSteps}

**STOP when "Done when" criteria are met.** Do NOT add "confirmation" or "completeness" queries.`;
}

// ── Plan format ──

/**
 * Plan format template with parameterized scope label.
 * @param scopeLabel - e.g. "Environment" or "Scope"
 * @param scopeDescription - e.g. "[prod/staging/dev]" or "[project/service/time range]"
 */
export function buildPlanFormat(scopeLabel: string, scopeDescription: string): string {
  return `### Plan format
\`\`\`
**${scopeLabel}:** ${scopeDescription}
**Reasoning:** [what's your most specific fact, hypothesis, approach]

**Plan** (N steps):
1. [Goal — what to find] → starting point
2. [Goal — what to learn from step 1's results]
...

**Done when:** [success criteria]
\`\`\``;
}

// ── Final response / analysis sections ──

/**
 * Analysis block parameterized by marker type.
 * Sub-agents use a text marker (`<analysis>`); direct-mode agents call `begin_analysis` tool.
 */
function analysisBlock(marker: "text" | "tool"): string {
  const markerAction = marker === "text"
    ? "write `<analysis>` on its own line **before anything else**"
    : "call the `begin_analysis` tool **before writing anything**";
  const markerStep = marker === "text"
    ? "`<analysis>` (on its own line — nothing before it except your investigation steps)"
    : "Call `begin_analysis` tool (nothing before it except your investigation steps)";
  const markerRef = marker === "text" ? "this marker" : "this tool";

  return `When you are ready to present your findings, ${markerAction}. Do NOT write any summary or findings before ${markerRef} — everything the user reads must come after it. The UI renders everything after it with distinct styling.

### Structure your response as:

1. **Think first** — before writing anything, use your thinking/reasoning to plan the analysis: what are the key findings, what story do they tell, which queries best visualize them, and what is your conclusion. Do not start writing until you have a clear mental outline.
2. ${markerStep}
3. Your narrative: findings, evidence, and conclusions — with supporting tool calls interspersed where a visual chart or table helps the reader. The UI renders tool results as interactive visuals.
4. End with a clear conclusion.

**Rules:**
- **Always use tool calls to display data** — never render data as markdown tables. Tool calls produce interactive charts and tables in the UI; markdown tables are unreadable in comparison.
- You may re-run queries from your investigation phase to display them as visuals in the analysis. Each tool call in the analysis should show different data from the others.
- Do NOT suggest fixes or recommendations — report facts only.`;
}

/**
 * Final response format for INVESTIGATE sub-agents.
 * @param maxSteps - The actual step limit from code (e.g. 30)
 */
export function buildFinalResponse(maxSteps: number): string {
  const wrapAt = maxSteps - 5;
  return `## Final Response

${analysisBlock("text")}

## Step Budget

You have a maximum of ${maxSteps} steps. If approaching step ${wrapAt}, wrap up immediately with what you have.`;
}

/**
 * Final response format for DIRECT sub-agents — short and efficient.
 * @param maxSteps - The actual step limit from code (e.g. 30)
 */
export function buildDirectFinalResponse(maxSteps: number): string {
  return `## Response Format

Your queries render visually in the UI — the user can see the results. Write a concise answer that references the visual results rather than repeating data.

After your queries, write:
1. **Answer**: Concrete answer with actual values — timestamps, names, counts, IDs. Include all relevant identifiers (service names, trace IDs, endpoints) so the orchestrator has them for follow-up.
2. **Caveats** (optional): If the answer is incomplete, state what's missing and why. Omit if complete.

Be specific: "Last login: 2024-01-15 14:30 UTC via payment-service" not "a recent login was found".

Do NOT suggest fixes or recommendations — report facts only.

You have a maximum of ${maxSteps} steps.`;
}

/**
 * Analysis section for direct-mode agents (conversational, no sub-agent layer).
 * Uses `begin_analysis` tool call as the analysis marker.
 * @param maxSteps - The actual step limit (e.g. 50)
 */
export function buildAnalysisSection(maxSteps: number): string {
  return `## Response Format

${analysisBlock("tool")}
- For simple questions, the query results themselves are the visual evidence — just add a brief text answer.

## Step Budget

You have a maximum of ${maxSteps} steps. Most investigations should finish in 3-8 steps. If you're past 10 steps, you're likely going in circles — stop, report what you have, and let the user guide next steps.`;
}
