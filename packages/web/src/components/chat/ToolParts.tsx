import { memo, useRef, useState } from "react";
import { AlertCircle, ClipboardCheck, Copy, History, LayoutGrid, Loader2, Timer, type LucideIcon } from "lucide-react";
import { CLIENT_TOOL_NAMES, type ProgressPart } from "@tracer-sh/shared";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Markdown } from "../../lib/markdown";
import ResultView, { JsonTree } from "../charts/ResultView";
import { useProgress, type ProgressStore } from "../../lib/progress-store";
import { hasErrorOutput } from "../../lib/chat-utils";
import { MonitorSavedCard, type MonitorSavedOutput } from "../monitors/MonitorSavedCard";
import { FoldTrigger } from "../common/FoldTrigger";
import { ProviderDot } from "../common/ProviderDot";
import { WorkingIndicator } from "./ChatIndicators";
import { IconButton } from "../common/IconButton";
import { copyText } from "./MessageActions";
import { ReasoningBlock } from "./ReasoningBlock";
import { ANSWER_PROSE_COMPACT } from "./prose";
import { providerLabel } from "../../lib/providers";

export interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
  input?: Record<string, unknown>;
}

interface SubAgentOutput {
  analysis?: string;
  queries?: Array<{ query: string; results: unknown; totalRows?: number }>;
  parts?: ProgressPart[];
  error?: string;
}

const SMALL_TOOLS: Record<string, { done: string; loading: string; errorLabel: string; icon: LucideIcon }> = {
  [CLIENT_TOOL_NAMES.CREATE_WIDGET]: { done: "Widget created", loading: "Creating widget", errorLabel: "Widget error", icon: LayoutGrid },
  [CLIENT_TOOL_NAMES.UPDATE_WIDGET]: { done: "Widget updated", loading: "Updating widget", errorLabel: "Widget error", icon: LayoutGrid },
  [CLIENT_TOOL_NAMES.DELETE_WIDGET]: { done: "Widget deleted", loading: "Deleting widget", errorLabel: "Widget error", icon: LayoutGrid },
  "tool-read_past_session": { done: "Read a past investigation", loading: "Reading a past investigation", errorLabel: "Past investigation not available", icon: History },
  "tool-report_finding": { done: "Finding reported", loading: "Reporting finding", errorLabel: "Finding not recorded", icon: ClipboardCheck },
  "tool-report_issue_status": { done: "Reported alert status", loading: "Reporting alert status", errorLabel: "Alert status not recorded", icon: ClipboardCheck },
  "tool-report_alert_summary": { done: "Reported alert summary", loading: "Reporting alert summary", errorLabel: "Alert summary not recorded", icon: ClipboardCheck },
  "tool-dismiss_alert": { done: "Alert already closed, not posted", loading: "Dismissing alert", errorLabel: "Alert not dismissed", icon: ClipboardCheck },
  "tool-set_timer": { done: "Follow-up timer set", loading: "Setting follow-up timer", errorLabel: "Follow-up timer not set", icon: Timer },
};

const MONITOR_TOOLS = new Set<string>([CLIENT_TOOL_NAMES.SAVE_MONITOR, CLIENT_TOOL_NAMES.DELETE_MONITOR]);

// Bare names are from older sessions; GCP's MCP tools have dynamic names, so anything else is GCP.
const PROVIDER_BY_TOOL: Record<string, string> = {
  "tool-execute_nrql": "newrelic",
  "tool-nrql": "newrelic",
  "tool-newrelic": "newrelic",
  "tool-list_nr_issues": "newrelic",
  "tool-ack_nr_issue": "newrelic",
  "tool-close_nr_issue": "newrelic",
  "tool-execute_hogql": "posthog",
  "tool-hogql": "posthog",
  "tool-posthog": "posthog",
  "tool-get_jira_issue": "jira",
  "tool-add_jira_comment": "jira",
};

export const isMonitorTool = (type: string) => MONITOR_TOOLS.has(type);

export const providerOf = (type: string) => PROVIDER_BY_TOOL[type] ?? "gcp";

/** Parts that never render: the analysis marker, removed propose_monitor drafts, and a recorded finding (shown as a card). */
export function isHiddenPart(part: { type: string; state?: string }) {
  return (
    part.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS ||
    part.type === "tool-propose_monitor" ||
    part.type === "step-start" ||
    (part.type === "tool-report_finding" && part.state === "output-available")
  );
}

export function isProviderTool(type: string) {
  return type.startsWith("tool-") && !(type in SMALL_TOOLS) && !MONITOR_TOOLS.has(type) && !isHiddenPart({ type });
}

function isSubAgentOutput(output: unknown): output is SubAgentOutput {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  return "parts" in output || "queries" in output || "analysis" in output || "error" in output;
}

function legacyToParts(output: SubAgentOutput): ProgressPart[] {
  const parts: ProgressPart[] = (output.queries ?? []).map((q) => ({ type: "query", query: q.query, results: q.results, totalRows: q.totalRows }));
  if (output.analysis) parts.push({ type: "text", content: output.analysis });
  return parts;
}

/** Ordered progress parts of a provider tool: live progress first, then the saved output. */
function stepParts(part: ToolPart, progress: ProgressPart[] | undefined): ProgressPart[] {
  const output = part.state === "output-available" ? part.output : undefined;
  if (progress?.length) return progress;
  if (isSubAgentOutput(output)) return output.parts?.length ? output.parts : legacyToParts(output);
  return [];
}

export function stepQueryCount(part: ToolPart, store: ProgressStore): number {
  return stepParts(part, store.getSnapshot(part.toolCallId ?? "")?.parts).filter((p) => p.type === "query").length;
}

function stepTitle(part: ToolPart, provider: string): string {
  const title = part.input?.title ?? part.input?.task;
  if (typeof title === "string" && title.trim()) return title.trim();
  if (part.type === "tool-get_jira_issue") return `Jira issue ${String(part.input?.issueKey ?? "")}`.trim();
  if (part.type === "tool-add_jira_comment") return `Comment on ${String(part.input?.issueKey ?? "Jira")}`;
  if (part.type === "tool-list_nr_issues") return "Alert issues";
  if (part.type === "tool-ack_nr_issue") return `Acknowledge issue ${String(part.input?.issueId ?? "")}`.trim();
  if (part.type === "tool-close_nr_issue") return `Close issue ${String(part.input?.issueId ?? "")}`.trim();
  if (provider === "gcp") return part.type.slice(5).replace(/_/g, " ");
  return "Query";
}

function isRowResult(results: unknown): boolean {
  return Array.isArray(results) && results.length > 0 && results.every((r) => r !== null && typeof r === "object");
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// A tool that returns its records as rows, or as one `{ key: rows }` field, shows them like a query result.
function rowsOf(output: unknown): unknown[] | null {
  if (isRowResult(output)) return output as unknown[];
  if (!isPlainObject(output) || isSubAgentOutput(output)) return null;
  const values = Object.values(output);
  const lists = values.filter(Array.isArray);
  const rows = lists[0];
  const others = values.filter((v) => !Array.isArray(v));
  const primitive = (v: unknown) => v === null || typeof v !== "object";
  return lists.length === 1 && rows.every(isPlainObject) && others.every(primitive) ? rows : null;
}

function inputText(part: ToolPart): string | null {
  if (typeof part.input?.query === "string") return part.input.query;
  return part.input && Object.keys(part.input).length ? JSON.stringify(part.input, null, 2) : null;
}

export const QueryBlock = memo(function QueryBlock({ query }: { query: string }) {
  return (
    <div className="relative">
      <pre className="max-h-64 overflow-auto rounded-md border bg-background py-2.5 pr-11 pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
        <code>{query}</code>
      </pre>
      <IconButton label="Copy query" size="icon-xs" className="absolute top-1.5 right-1.5 text-muted-foreground" onClick={() => copyText(query, "Query copied")}>
        <Copy />
      </IconButton>
    </div>
  );
});

function ErrorLine({ children }: { children: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-[13px]/[18px] text-destructive">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

export function Narration({ content, isAnimating }: { content: string; isAnimating: boolean }) {
  if (!content.trim()) return null;
  return <Markdown text={content} isAnimating={isAnimating} className="max-w-[68ch] text-sm leading-relaxed text-ink-2" />;
}

function ProgressItems({ parts, isAnimating, resultsOnly = false }: { parts: ProgressPart[]; isAnimating: boolean; resultsOnly?: boolean }) {
  if (resultsOnly) return <>{parts.map((p, i) => (p.type === "query" ? <ResultView key={i} data={p.results} totalRows={p.totalRows} /> : null))}</>;
  let inAnalysis = false;
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "analysis-start") {
          inAnalysis = true;
          return null;
        }
        if (p.type === "query") {
          return (
            <div key={i} className="space-y-2">
              {p.query && <QueryBlock query={p.query} />}
              <ResultView data={p.results} totalRows={p.totalRows} />
            </div>
          );
        }
        if (p.type === "reasoning") return <ReasoningBlock key={i} content={p.content} isAnimating={isAnimating} />;
        if (p.type === "tool-call") return isAnimating ? <WorkingIndicator key={i} label={`Running ${p.toolName.replace(/_/g, " ")}`} /> : null;
        if (inAnalysis && p.type === "text") {
          return <Markdown key={i} text={p.content} isAnimating={isAnimating} className={ANSWER_PROSE_COMPACT} />;
        }
        return <Narration key={i} content={p.content} isAnimating={isAnimating} />;
      })}
    </>
  );
}

interface JiraIssueView {
  key: string;
  summary: string;
  description: string | null;
  status: string;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  created: string | null;
  updated: string | null;
  dueDate: string | null;
  resolution: string | null;
  comments?: Array<{ id: string | null; author: string | null; body: string | null; created: string | null }>;
}

function jiraIssueOf(o: unknown): JiraIssueView | null {
  const issue = o && typeof o === "object" && "issue" in o ? (o as { issue: unknown }).issue : null;
  return issue && typeof issue === "object" ? (issue as JiraIssueView) : null;
}

function jiraCommentUrl(o: unknown): string | null {
  const r = (o ?? {}) as { posted?: unknown; url?: unknown };
  if (r.posted !== true || typeof r.url !== "string") return null;
  try { return new URL(r.url).protocol === "https:" ? r.url : null; } catch { return null; }
}

const jiraDate = (s: string | null) => (s ? s.slice(0, 10) : null);

const JiraIssueCard = memo(function JiraIssueCard({ issue }: { issue: JiraIssueView }) {
  // Older chats stored a slimmer issue shape, so every list may be missing.
  const labels = issue.labels ?? [];
  const comments = issue.comments ?? [];
  const rows = ([
    ["Type", issue.issueType],
    ["Priority", issue.priority],
    ["Assignee", issue.assignee],
    ["Reporter", issue.reporter],
    ["Resolution", issue.resolution],
    ["Due", jiraDate(issue.dueDate)],
    ["Created", jiraDate(issue.created)],
    ["Updated", jiraDate(issue.updated)],
    ["Components", issue.components?.length ? issue.components.join(", ") : null],
    ["Fix versions", issue.fixVersions?.length ? issue.fixVersions.join(", ") : null],
  ] as Array<[string, string | null]>).filter((r): r is [string, string] => !!r[1]);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-jira">{issue.key}</span>
        <span className="inline-flex h-5 items-center rounded-md bg-muted px-2 text-xs font-medium text-ink-2">{issue.status}</span>
      </div>
      <p className="font-medium text-pretty">{issue.summary}</p>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1 text-[13px]/[18px] sm:grid-cols-[6rem_1fr_6rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 truncate">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Labels">
          {labels.map((l) => (
            <li key={l} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-ink-2">{l}</li>
          ))}
        </ul>
      )}
      {issue.description && <p className="border-t pt-3 whitespace-pre-wrap text-ink-2">{issue.description}</p>}
      {comments.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">Comments ({comments.length})</p>
          {comments.map((c, i) => (
            <div key={c.id ?? i} className="text-[13px]/[18px]">
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">{c.author ?? "Unknown"}</span>
                {jiraDate(c.created) && <> · {jiraDate(c.created)}</>}
              </p>
              {c.body && <p className="whitespace-pre-wrap text-ink-2">{c.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function stepError(part: ToolPart): string | null {
  if (part.state === "output-error") return part.errorText ?? "The query failed";
  const output = part.state === "output-available" ? part.output : undefined;
  return isSubAgentOutput(output) && output.error ? output.error : null;
}

function StepBody({ part, progressStore, resultsOnly = false }: { part: ToolPart; progressStore: ProgressStore; resultsOnly?: boolean }) {
  const progress = useProgress(progressStore, part.toolCallId);
  const complete = part.state === "output-available";
  const output = complete ? part.output : undefined;

  const error = stepError(part);
  if (error) return <ErrorLine>{error}</ErrorLine>;

  if (complete && part.type === "tool-get_jira_issue") {
    const issue = jiraIssueOf(output);
    if (issue) return <JiraIssueCard issue={issue} />;
  }
  if (complete && part.type === "tool-add_jira_comment") {
    const url = jiraCommentUrl(output);
    if (url) {
      return (
        <p className="text-sm text-ink-2">
          Comment posted.{" "}
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">
            View in Jira
          </a>
        </p>
      );
    }
  }

  const parts = stepParts(part, progress?.parts);
  if (parts.length > 0 || !complete) {
    const query = typeof part.input?.query === "string" ? part.input.query : null;
    if (resultsOnly) return <ProgressItems parts={parts} isAnimating={!complete} resultsOnly />;
    return (
      <>
        {parts.length === 0 && query && <QueryBlock query={query} />}
        <ProgressItems parts={parts} isAnimating={!complete} />
        {!complete && <WorkingIndicator label={`Querying ${providerLabel(providerOf(part.type))}`} />}
      </>
    );
  }

  // Raw outputs: GCP MCP results, New Relic issue actions and pre-progress sessions. A folded step hides a plain status object.
  const query = inputText(part);
  return (
    <>
      {query && !resultsOnly && <QueryBlock query={query} />}
      {output != null && !(resultsOnly && isPlainObject(output)) && <ResultView data={output} />}
    </>
  );
}

// A folded step keeps its charts and tables visible; only the query hides.
type StepProps = { part: ToolPart; progressStore: ProgressStore };

// The AI SDK clones the streaming message per chunk, so part identity changes even when nothing read here did.
function stepPropsEqual(prev: StepProps, next: StepProps): boolean {
  if (prev.progressStore !== next.progressStore) return false;
  const a = prev.part;
  const b = next.part;
  if (a === b) return true;
  if (a.toolCallId !== b.toolCallId || a.type !== b.type || a.state !== b.state) return false;
  if (a.state === "output-available" || a.state === "output-error") return true;
  return a.output === b.output && a.errorText === b.errorText && a.input?.task === b.input?.task && a.input?.query === b.input?.query && a.input?.title === b.input?.title;
}

// A finished step with one chart or table result sits in a card, with its query behind the chevron.
function ChartStep({ part, query, results, totalRows }: { part: ToolPart; query: string | null; results: unknown; totalRows?: number }) {
  const [open, setOpen] = useState(false);
  const provider = providerOf(part.type);
  const title = stepTitle(part, provider);
  return (
    <li className="animate-in fade-in duration-200">
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card p-4 shadow-sm max-sm:px-3">
        <FoldTrigger
          chevronEnd
          disabled={!query}
          chevronClassName={cn("text-muted-foreground", !query && "hidden")}
          aria-label={query ? `${title}: show query` : title}
          className="flex w-full items-start justify-between gap-3 rounded-md text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ProviderDot provider={provider} />
            <span className="sr-only">{providerLabel(provider)}:</span>
            <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          </span>
        </FoldTrigger>
        {query && (
          <CollapsibleContent className="mt-3">
            <QueryBlock query={query} />
          </CollapsibleContent>
        )}
        <div className="mt-2">
          <ResultView data={results} totalRows={totalRows} />
        </div>
      </Collapsible>
    </li>
  );
}

export const ProviderStep = memo(function ProviderStep({ part, progressStore }: StepProps) {
  const [open, setOpen] = useState(false);
  const progress = useProgress(progressStore, part.toolCallId);
  const provider = providerOf(part.type);
  const running = part.state !== "output-available" && part.state !== "output-error";
  const queries = running || stepError(part) ? [] : stepParts(part, progress?.parts).filter((p) => p.type === "query");
  const only = queries.length === 1 && queries[0].type === "query" && queries[0].query && isRowResult(queries[0].results) ? queries[0] : null;
  if (only) return <ChartStep part={part} query={only.query} results={only.results} totalRows={only.totalRows} />;
  const rows = running || stepError(part) ? null : rowsOf(part.output);
  if (rows) return <ChartStep part={part} query={inputText(part)} results={rows} />;
  const error = open ? null : stepError(part);
  return (
    <li className="animate-in fade-in duration-200">
      <Collapsible open={open} onOpenChange={setOpen}>
        <FoldTrigger
          chevronEnd
          chevronClassName="text-muted-foreground"
          className="-ml-1.5 flex max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:text-foreground"
        >
          <ProviderDot provider={provider} />
          <span className="sr-only">{providerLabel(provider)}:</span>
          <span className="min-w-0 truncate text-sm font-medium">{stepTitle(part, provider)}</span>
          {running && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />}
        </FoldTrigger>
        <CollapsibleContent className="mt-2 ml-4 space-y-2">
          <StepBody part={part} progressStore={progressStore} />
        </CollapsibleContent>
      </Collapsible>
      {!open && (
        <div className="mt-2 ml-4 space-y-2">
          <StepBody part={part} progressStore={progressStore} resultsOnly />
        </div>
      )}
      {error && <div className="mt-1 ml-4"><ErrorLine>{error}</ErrorLine></div>}
    </li>
  );
}, stepPropsEqual);

function smallToolLabel(part: ToolPart, spec: (typeof SMALL_TOOLS)[string]): string {
  const output = (part.output ?? {}) as Record<string, unknown>;
  if ("error" in output) return `${spec.errorLabel}: ${String(output.error)}`;
  if ("cancelled" in output) return "Follow-up timer cancelled";
  const note = typeof part.input?.note === "string" && part.input.note ? `: ${part.input.note}` : "";
  if (typeof output.dueAt === "string") return `${spec.done} for ${output.dueAt}${note}`;
  if (part.type === "tool-report_issue_status" && Array.isArray(part.input?.issues)) {
    const statuses = [...new Set((part.input.issues as Array<{ status?: string }>).map((i) => i.status).filter(Boolean))];
    if (statuses.length) return `${spec.done}: ${statuses.join(", ")}`;
  }
  return spec.done;
}

/** Monitor saves, small tool lines (timer, widgets, triage reports) and anything else that is not a provider query. */
export const OtherToolPart = memo(function OtherToolPart({ part }: { part: ToolPart }) {
  // Outputs present on mount come from history, not a save that just happened.
  const savedLive = useRef(part.state !== "output-available").current;

  if (MONITOR_TOOLS.has(part.type)) {
    if (part.state === "output-available") return <MonitorSavedCard output={(part.output ?? {}) as MonitorSavedOutput} fresh={savedLive} />;
    if (part.state === "output-error") return <ErrorLine>{part.errorText ?? "Monitor save failed"}</ErrorLine>;
    return <WorkingIndicator label="Working on the monitor" />;
  }

  const spec = SMALL_TOOLS[part.type];
  if (!spec) return null;
  if (part.state === "output-error") return <ErrorLine>{`${spec.errorLabel}: ${part.errorText ?? "failed"}`}</ErrorLine>;
  if (part.state !== "output-available") return <WorkingIndicator label={spec.loading} />;
  const failed = hasErrorOutput(part.output);
  const Icon = failed ? AlertCircle : spec.icon;
  return (
    <Collapsible>
      <FoldTrigger
        chevronEnd
        chevronClassName="mt-0.5 text-muted-foreground"
        className={cn(
          "-ml-1.5 flex max-w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[13px]/[18px] hover:text-foreground",
          failed ? "text-destructive" : "text-ink-2",
        )}
      >
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", !failed && "text-muted-foreground")} aria-hidden="true" />
        <span className="min-w-0">{smallToolLabel(part, spec)}</span>
      </FoldTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-4 rounded-md border bg-background px-3 py-2 font-mono text-xs">
          <JsonTree data={part.output} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
