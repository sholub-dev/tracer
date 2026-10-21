import { generateText, type ModelMessage, type UIMessage } from "ai";
import { turnStart, type Finding } from "@tracer-sh/shared";
import { CONFIG } from "../../config.js";
import type { ProviderOptions } from "../../llm/resolve.js";
import { recordEachCall } from "../../llm/usage.js";
import type { Db } from "../../db/driver.js";
import type { Ledger } from "../../tools/analysis-tool.js";
import type { AlertSummary } from "../../monitors/alert-summary.js";
import { truncate } from "./summary.js";

// Earlier cards are not evidence; the card under review and the earlier problems are given apart.
const FINDING_TOOL = "report_finding";
const SUMMARY_TOOL = "report_alert_summary";

const TOOL_INPUT_MAX_CHARS = 2000;
const TOOL_RESULT_MAX_CHARS = 8000;
const QUESTION_MAX_CHARS = 4000;

const INSTRUCTIONS = `You are a skeptical reviewer of a debugging conclusion. You see the question, the tool calls with their results, the agent's ledger and the names of the tools the agent has. You cannot run queries.

Check each point:
- The ledger says "lookup", but the question or an earlier user message asks why or what is wrong; or it says "status", but a result shows a problem. Then it is a cause and every point below applies.
- Every number, identifier and time in the conclusion appears in a result.
- Each link of the chain names a query. Each reason in a link or in the conclusion (because, due to, a state such as expired, blocked or queued, a place such as a queue or a pool) is stated in a result. A reason no result states is a problem, also when it sounds likely.
- An empty result rules out only what the source records: no span or no log line for a call does not rule out the call when the calling code is not instrumented.
- The symptom is verified in the data, not only reported.
- The suspected cause starts before the symptom, to the minute, and a result shows how it produced the symptom: the same trace, request, time bucket or resource. A symptom that starts before its cause is a problem.
- Each word in the conclusion that names a mechanism or a source (saturated, queued, backlog, throttled, exhausted, external, internal, unavailable) is measured by a result. A mechanism inferred from a pattern, such as time missing from the measured parts, is tested against the other mechanisms that give the same pattern.
- When the question asks for the worst, biggest or which one, one result ranks all the candidates, not a set the agent picked, and the conclusion names the second and the margin. The ranking counts the requests or users affected inside the spike or drop, for latency and Apdex too: the most extra slow requests wins, not the most seconds or the lowest score. A ranking by seconds or score alone is a problem; never ask the agent for one. a winner by ratio or average over a few requests, ahead of a candidate that affects far more, is a problem, and so is a winner by a whole-window total that shows no spike.
- An open alert or issue is a claim: the conclusion reports it as a problem only when a result shows its symptom in the data.
- A word that classifies (legacy, batch, routine, automated, expected) is shown by a result.
- A verb that ties two facts (drove, produced, caused, led to) has a result that ties them: the same request, trace, host or minute. A resource called saturated is at its limit in a result.
- The suspected cause is new or higher than in a normal window. It is not background noise.
- The suspected cause explains the scale and scope of the symptom: all affected services and endpoints, not a small share.
- No competing explanation is left untested.
- The chain does not stop at a link whose own data the agent's tools can query. A slow or failing dependency (another service, a database, a host, external calls) is a link, not a root cause: a result must show why it is slow or failing, from its own data. "Calls to X are slow" needs a query inside X when a tool can query X. A change, a resource limit or a load shift needs a result that shows how it produced the next link.
- The user asked why again, or questioned the answer: the conclusion reaches a deeper link than the earlier answer. A reworded earlier answer is a problem.
- The affected part is compared with healthy peers or a healthy period, when the data holds them.
- The conclusion claims no action, escalation, notification, owner or team that no result shows. Only tool calls that succeeded count as the agent's own actions.
- When the chain reaches a change in client or user activity (traffic, logins, sign-ups, applications, payments), the conclusion says who drove it and whether it is legitimate or abuse, from a result. A rise in traffic alone is not a root cause. A verdict of "not abuse" names the result that rules abuse out.
- No result that contradicts the conclusion is ignored.
- A pattern seen in 1-2 samples is confirmed with a count before the agent generalizes it.
- The confidence label is not higher than the evidence.
- A number that may sit in a cut part of a result (it ends with "cut for the review") or in a step the transcript omits is not absent. Flag it only when a visible result contradicts it.

Reply "OK" when you find no problem.
Otherwise list at most 3 problems, most serious first. Write each as one sentence that names the result or the missing check.
Do not suggest fixes for the system under investigation. Do not write a preamble.`;

const CARD_INSTRUCTIONS = `You are a skeptical reviewer of the answer card a debugging agent wrote. You see the question, the tool calls with their results, including the challenges its analysis step returned, and the card. You cannot run queries.

Check each point:
- The headline answers the question as asked. For a follow-up question, that is the follow-up, not the earlier question of the session. For a why or root-cause question it names the deepest cause the chain shows, or says that the cause is not found and where the data stops; a symptom alone is a problem. The headline holds the number that sizes the answer. For a worst, biggest or which question it names the winner and its lead over the second, and the ranking result compares all candidates on the measure the question names, each at its worst interval inside the window the question names against its own normal level. A ranking inside the winner's spike window only, or by whole-window averages that hide a short spike, is a problem. A spike, drop or jump is ranked by its change against a normal window, not by totals or open alerts. Two numbers for the same drop or spike, such as a ranking change and the size over the affected window, each name their measure and window. A lead between two ratios is stated as both ratios, not as an "x" difference. When the data does not show the premise of the question (its size, time or service), the headline states the measured value. The size is the average over the affected window against a normal window, not a peak minute against a quiet minute. A word for a ratio (doubled, tripled, halved) matches the measured ratio.
- Every number, time and identifier in the card appears in a result. When the card uses more than one window, each number names its window. Two numbers for the same measure that disagree without their windows are a problem. A number the card derives (a sum, a share, a ratio, a difference) follows from the numbers it is derived from.
- Each word that names a mechanism, a state, an order, a class or a causal tie (saturated, queued, sequential, cascading, triggered, drove, due to, batch, uncoordinated, routine, standard, healthy) is shown by a result. Read every such word, not only these examples. A resource is saturated only at its limit. A part whose time or rate did not change against its normal window is not the cause of a change; naming it as the cause is a problem.
- Each challenge the analysis step returned is settled by a later result, or the card has confidence likely or lower and names in gap the cause it leaves open. A card that a challenge contradicts is a problem.
- Confirmed needs a result that shows the cause itself and a result that rules out the strongest alternative. A likely or unverified card has a gap. The gap states, in plain words, the unknown that changes what the reader does (who, why, legitimate or abuse, or a cause no result ruled out), then what the results show about it. A gap that asks a question, names a log type, source or window to check, or asks for more telemetry on a cause the chain already shows is a problem.
- The impact of a problem card says who or what is affected and how much, with a number from a result: requests, users, errors or minutes. An impact without a size is a problem. An average that rose does not mean every request got slower: an impact such as "195,396 requests experienced elevated latency", where the count is the total requests in the window, is a problem.
- In a status answer, each service value stands next to its baseline from a result. A state word (healthy, normal, stable, no degradation) that covers a value without a baseline is a problem.
- The verdict fits the results: problem when a result shows a degradation such as a rise in latency or errors, no_problem only when the results show none. Traffic that looks legitimate does not make a degradation no_problem.
- The kind fits: root_cause for a why question or a check that found a problem, summary for a status, count, trend or lookup.
- The action field names only a change to a system that a tool call in this reply made and that succeeded. A query or a review is not an action.
- No field states the same fact twice. A small count or a label that names a list item is not a repeat.
- The headline has at most 25 words, and each chain link at most 20.
- A number that may sit in a cut part of a result (it ends with "cut for the review") or in a step the transcript omits is not absent. Flag it only when a visible result contradicts it.

Write the reply in two sections, in this order.

CLAIMS
One line per number, time, identifier, ranking, word that names a mechanism, a state, an order, a class or a causal tie, and the confidence label in the card. Skip pure labels. Write each line as:
- <card field>: <the claim, short> | <exact text copied from one result line that shows it, or NONE>
Copy the text from a result. Do not retype it from memory. Write NONE when no visible result shows the claim.

PROBLEMS
List every problem, at most 6, most serious first, each as a line "- <one sentence that names the card field and the result or the missing check>". Write the single word OK when you find no problem.
A claim marked NONE is a problem, unless the card puts it in gap or labels it as not verified.
Do not suggest fixes for the system under investigation. Do not write a preamble.`;

const SUMMARY_INSTRUCTIONS = `You check the alert details that a debugging agent posts to Slack. You see the tool calls with their results and the details. You cannot run queries.

Check only these fields against the results:
- Each issue's count and error class come from one result row, or one filtered query, for that endpoint. A count that is the endpoint total, written next to one error class, is a problem. The class is written without its package.
- On a latency or traffic alert, each line shows the value next to its normal level, both from results. An error count on such a line is a problem.
- userImpact: for an error line, the failure status code or message from the same result as the count, or exactly "none". For a latency or traffic line it is exactly "none": the value already says it. A success code (200, 204) is not an impact.
- endpoint is a route or an operation that a result names. The service name and "/" are not endpoints.
- started and status agree with the times in the results.
- A number that may sit in a cut part of a result (it ends with "cut for the review") is not absent. Flag it only when a visible result contradicts it.

Write the reply in two sections, in this order.

CLAIMS
One line per count, value, class, status code and time in the details. Write each line as:
- <field>: <the claim, short> | <exact text copied from one result line that shows it, or NONE>

PROBLEMS
List every problem, at most 4, each as a line "- <one sentence that names the field and the result>". Write the single word OK when you find no problem.
A claim marked NONE is a problem.
Do not write a preamble.`;

function userText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** Index in `model` of the user message that began the turn. `model` is the history as converted, before any message is appended. */
export function questionIndex(history: UIMessage[], model: ModelMessage[]): number {
  const users = model.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const later = history.slice(turnStart(history)).filter((m) => m.role === "user").length;
  return users[users.length - 1 - later] ?? -1;
}

const HARNESS = { tracer: { harness: true } };

/** A user-role note the harness adds; the transcript shows it as a note, not as the person's words. */
export function harnessNote(content: string): ModelMessage {
  return { role: "user", content, providerOptions: HARNESS };
}

const isHarnessNote = (m: ModelMessage) => (m.providerOptions as { tracer?: { harness?: boolean } } | undefined)?.tracer?.harness === true;

const CUT = "… (cut for the review)";

const cut = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) + CUT : text);

/** The problems a reviewer listed, or null for a pass. Reviewers sometimes reason first and end with "OK". */
export function reviewProblems(text: string): string | null {
  const last = text.trim().split("\n").filter((l) => l.trim()).at(-1);
  return last && !/^\W*(OK|none)\W*$/i.test(last) ? text.trim() : null;
}

/**
 * The problems of a card review, or null for a pass. The reviewer first lists the claims it checked;
 * only the PROBLEMS section goes back to the agent.
 */
export function cardProblems(text: string): string | null {
  // The last header wins: reasoning before it can mention the word, and "PROBLEMS OK" can share a line.
  const header = [...text.matchAll(/^[ \t#*]*PROBLEMS\b[ \t*:]*/gm)].at(-1);
  if (header?.index === undefined) return reviewProblems(text);
  const problems = text.slice(header.index + header[0].length).trim();
  return problems ? reviewProblems(problems) : null;
}

/** A tool result as the model read it: the plain text, without the result wrapper. */
export function resultText(output: unknown): string {
  const o = output as { type?: string; value?: unknown } | null | undefined;
  let text: string;
  if (o && typeof o.type === "string" && "value" in o) text = typeof o.value === "string" ? o.value : JSON.stringify(o.value) ?? "";
  else text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
  return text.replace(/^<tool_result>\n/, "").replace(/\n<\/tool_result>$/, "");
}

/** A result of a read that ran in the same step as the reviewed call, which the step input lacks. */
export type StepResult = { toolName: string; input: unknown; text: string };

type Line = { text: string; callId?: string; header?: boolean };

function renderMessage(m: ModelMessage, shown: Set<string> = new Set()): Line[] {
  if (m.role === "assistant") {
    if (typeof m.content === "string") return [{ text: `Agent: ${m.content}` }];
    return m.content.flatMap((p): Line[] => {
      if (p.type === "text") return [{ text: `Agent: ${p.text}` }];
      if (p.type === "tool-call" && shown.has(p.toolCallId)) return [{ text: `Answer shown to the person: ${truncate(p.input, TOOL_INPUT_MAX_CHARS)}`, callId: p.toolCallId }];
      if (p.type === "tool-call" && p.toolName !== FINDING_TOOL && p.toolName !== SUMMARY_TOOL) return [{ text: `Tool call ${p.toolName}: ${truncate(p.input, TOOL_INPUT_MAX_CHARS)}`, callId: p.toolCallId }];
      return [];
    });
  }
  if (m.role === "user") return [{ text: `${isHarnessNote(m) ? "Harness note" : "User"}: ${truncate(userText(m), QUESTION_MAX_CHARS)}` }];
  if (m.role === "tool") {
    return m.content.flatMap((p): Line[] =>
      p.type === "tool-result" && p.toolName !== FINDING_TOOL && p.toolName !== SUMMARY_TOOL ? [{ text: `Result ${p.toolName}: ${cut(resultText(p.output), TOOL_RESULT_MAX_CHARS)}`, callId: p.toolCallId }] : [],
    );
  }
  return [];
}

/** Independent check of the Slack fields of the alert summary against the run's tool results. Fails open: any error returns null. */
export function reviewSummary(
  db: Db,
  sessionId: string,
  model: Parameters<typeof generateText>[0]["model"],
  modelId: string,
  summary: AlertSummary,
  messages: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  providerOptions: ProviderOptions | undefined,
  questionStart: number,
  stepResults: StepResult[] = [],
): Promise<string | null> {
  const content = `<run>\n${buildTranscript(messages, questionStart, stepResults)}\n</run>\n\n<details>\n${JSON.stringify({ started: summary.started, status: summary.status, issues: summary.issues }, null, 2)}\n</details>`;
  return review(db, sessionId, model, modelId, SUMMARY_INSTRUCTIONS, content, abortSignal, providerOptions, cardProblems);
}

/** The ids of the cards the person saw: a follow-up refers to these, not to the drafts the review sent back. */
function shownCards(messages: ModelMessage[]): Set<string> {
  return new Set(messages.flatMap((m) => m.role !== "tool" ? [] : m.content.flatMap((p) =>
    p.type === "tool-result" && p.toolName === FINDING_TOOL && (p.output as { value?: { recorded?: unknown } }).value?.recorded === true ? [p.toolCallId] : [])));
}

/** The ids of the tool calls whose title is one of `titles`. */
function callsTitled(messages: ModelMessage[], titles: string[]): Set<string> {
  const wanted = new Set(titles.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type !== "tool-call") continue;
      const title = (p.input as { title?: unknown } | null)?.title;
      if (typeof title === "string" && wanted.has(title.trim().toLowerCase())) ids.add(p.toolCallId);
    }
  }
  return ids;
}

/**
 * The run as text for a reviewer. Over the size cap it drops the oldest lines, but keeps the question and
 * the calls titled in `keepTitles`: a card cites its evidence by query title, and that query often ran first.
 */
export function buildTranscript(messages: ModelMessage[], start: number, stepResults: StepResult[] = [], keepTitles: string[] = []): string {
  const question = start >= 0 ? `Question: ${truncate(userText(messages[start]), QUESTION_MAX_CHARS)}\n` : "";
  // A follow-up question can rest on results of earlier questions in the session.
  const shown = start > 0 ? shownCards(messages.slice(0, start)) : new Set<string>();
  const earlier = start > 0 ? messages.slice(0, start).flatMap((m) => renderMessage(m, shown)) : [];
  const lines: Line[] = [
    ...(earlier.length ? [{ text: "Earlier in this session:", header: true }, ...earlier, { text: "The reply to the question:", header: true }] : []),
    ...messages.slice(start + 1).flatMap((m) => renderMessage(m)),
  ];
  if (stepResults.length) {
    lines.push({ text: "Results from this step (these calls ran in the same step as the reviewed call):", header: true });
    for (const r of stepResults) {
      lines.push({ text: `Tool call ${r.toolName}: ${truncate(r.input, TOOL_INPUT_MAX_CHARS)}` }, { text: `Result ${r.toolName}: ${cut(resultText(r.text), TOOL_RESULT_MAX_CHARS)}` });
    }
  }
  const pinned = new Set([...callsTitled(messages, keepTitles), ...shown]);
  // The headers stay, so a kept line of an earlier question never reads as part of this reply.
  const keep = lines.map((l) => l.header === true || (l.callId !== undefined && pinned.has(l.callId)));
  let used = question.length + lines.reduce((n, l, i) => n + (keep[i] ? l.text.length + 1 : 0), 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    if (used + lines[i].text.length + 1 > CONFIG.reviewTranscriptMaxChars) break;
    keep[i] = true;
    used += lines[i].text.length + 1;
  }
  const dropped = keep.filter((k) => !k).length;
  const omitted = dropped ? `(${dropped} earlier lines omitted)\n` : "";
  return question + omitted + lines.filter((_, i) => keep[i]).map((l) => l.text).join("\n");
}

/** Independent check of a cause conclusion against the run's tool results. Fails open: any error returns null. */
export function reviewConclusion(
  db: Db,
  sessionId: string,
  model: Parameters<typeof generateText>[0]["model"],
  modelId: string,
  ledger: Ledger,
  messages: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  providerOptions: ProviderOptions | undefined,
  questionStart: number,
  toolNames: string[],
  stepResults: StepResult[] = [],
): Promise<string | null> {
  const content = `<tools>\n${toolNames.join(", ")}\n</tools>\n\n<run>\n${buildTranscript(messages, questionStart, stepResults)}\n</run>\n\n<ledger>\n${JSON.stringify(ledger, null, 2)}\n</ledger>`;
  return review(db, sessionId, model, modelId, INSTRUCTIONS, content, abortSignal, providerOptions, reviewProblems);
}

/** Independent check of the answer card against the run's tool results. Fails open: any error returns null. */
export function reviewCard(
  db: Db,
  sessionId: string,
  model: Parameters<typeof generateText>[0]["model"],
  modelId: string,
  card: Finding,
  messages: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  providerOptions: ProviderOptions | undefined,
  questionStart: number,
  earlierProblems: string[],
  stepResults: StepResult[] = [],
): Promise<string | null> {
  const earlier = earlierProblems.length
    ? `\n\n<earlier_review>\nThe first review listed these problems: ${earlierProblems.join(" ")}\nThis card is the rewritten version. Also check that each listed problem is fixed: by a later result, a reworded claim, a lower confidence label or a claim moved to gap.\n</earlier_review>`
    : "";
  const content = `<run>\n${buildTranscript(messages, questionStart, stepResults, card.chain?.map((l) => l.query ?? "") ?? [])}\n</run>\n\n<card>\n${JSON.stringify(card, null, 2)}\n</card>${earlier}`;
  return review(db, sessionId, model, modelId, CARD_INSTRUCTIONS, content, abortSignal, providerOptions, cardProblems);
}

/** The review reads only the text, so the run's thinking budget stays and the streamed thoughts go. */
function withoutThoughts(options: ProviderOptions | undefined): ProviderOptions | undefined {
  if (!options) return options;
  return Object.fromEntries(
    Object.entries(options).map(([name, value]) => {
      const config = (value as { thinkingConfig?: object }).thinkingConfig;
      return [name, config ? { ...value, thinkingConfig: { ...config, includeThoughts: false } } : value];
    }),
  ) as ProviderOptions;
}

async function review(
  db: Db,
  sessionId: string,
  model: Parameters<typeof generateText>[0]["model"],
  modelId: string,
  instructions: string,
  content: string,
  abortSignal: AbortSignal | undefined,
  providerOptions: ProviderOptions | undefined,
  verdict: (text: string) => string | null,
): Promise<string | null> {
  if (abortSignal?.aborted) return null;
  // Not AbortSignal.any or AbortSignal.timeout: they need iOS 17.4 and 16, and the app supports iOS 15.
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortSignal!.reason);
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("The review timed out", "TimeoutError")), CONFIG.reviewTimeoutMs);
  try {
    const { text } = await generateText({
      model,
      temperature: 0,
      providerOptions: withoutThoughts(providerOptions),
      instructions,
      messages: [{ role: "user", content }],
      abortSignal: controller.signal,
      onLanguageModelCallEnd: recordEachCall(db, sessionId, "review", modelId),
    });
    return verdict(text);
  } catch (err) {
    if (!abortSignal?.aborted) console.warn("[review] Failed to review:", err);
    return null;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}
