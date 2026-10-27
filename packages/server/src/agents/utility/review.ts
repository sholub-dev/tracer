import { generateText, type ModelMessage, type UIMessage } from "ai";
import { turnStart } from "@tracer-sh/shared";
import { CONFIG } from "../../config.js";
import type { ProviderOptions } from "../../llm/resolve.js";
import { recordEachCall } from "../../llm/usage.js";
import type { Db } from "../../db/driver.js";
import type { Ledger } from "../../tools/analysis-tool.js";
import type { AlertSummary } from "../../monitors/alert-summary.js";
import { truncate } from "./summary.js";

const FINDING_TOOL = "report_finding";
const SUMMARY_TOOL = "report_alert_summary";

const TOOL_INPUT_MAX_CHARS = 2000;
const TOOL_RESULT_MAX_CHARS = 8000;
const QUESTION_MAX_CHARS = 4000;

const INSTRUCTIONS = `You are a skeptical reviewer of a debugging conclusion. You see the question, the tool calls with their results, the agent's ledger and the names of the tools the agent has. You cannot run queries.

Depth comes first. A conclusion that names only what failed, where, when and how much, without why, is the most serious problem, also when every fact in it is true. Check these first:
- The ledger's split shows, from results, whether the request volume, the rate per request (errors or latency) or the mix moved against a normal window, and which slice (endpoint, service, host, version, caller or client) holds most of the change, with its share. A split that is missing or not backed by a result is a problem.
- Errors that stopped while the requests also stopped are not resolved: the traffic ended. A conclusion that calls it stopped, fixed or resolved is a problem. So is one that calls it ended at a dip when a later point in a result rises again.
- A result in the run that names a caller, a client, an endpoint, a share or a normal level that changes the picture, and that the conclusion leaves out, is a problem.
- A status conclusion that calls something healthy, stable or normal while a result shows a measure far from its normal level (a third or more), and the conclusion does not name it, is a problem.
- A conclusion that calls traffic a bot, automated, scripted or an attack needs two results: one that shows an indicator in that traffic (one source's share, a rate or interval no person keeps, enumerated values, an automation client), and one that shows this traffic holds the change in the symptom. Check actor.indicator the same way: a rise in volume or rate against normal, a common user agent, or a past session's finding is not an indicator, and is a problem.

Then check each point:
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

const SUMMARY_INSTRUCTIONS = `You check the alert details that a debugging agent posts to Slack. You see the tool calls with their results and the details. You cannot run queries.

Check only these fields against the results:
- Each issue's count and error class come from one result row, or one filtered query, for that endpoint. A count that is the endpoint total, written next to one error class, is a problem. The class is written without its package.
- On a latency or traffic alert, each line shows the value next to its normal level, both from results. An error count on such a line is a problem.
- userImpact: for an error line, the failure status code or message from the same result as the count, or exactly "none". For a latency or traffic line it is exactly "none": the value already says it. A success code (200, 204) is not an impact.
- endpoint is a route or an operation that a result names. The service name and "/" are not endpoints.
- started and status agree with the times in the results. "back to normal" is a problem when any later point in a result is back over the alert's limit or far above the normal level: the status is the latest point, not the first dip.
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

/**
 * The run as text for a reviewer. Over the size cap it drops the oldest lines, but keeps the question and the shown cards.
 */
export function buildTranscript(messages: ModelMessage[], start: number, stepResults: StepResult[] = []): string {
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
  // The headers stay, so a kept line of an earlier question never reads as part of this reply.
  const keep = lines.map((l) => l.header === true || (l.callId !== undefined && shown.has(l.callId)));
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
