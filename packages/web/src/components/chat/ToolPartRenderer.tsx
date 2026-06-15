import React, { memo } from "react";
import { Streamdown } from "streamdown";
import { CLIENT_TOOL_NAMES } from "@tracer-sh/shared";
import { JsonTree } from "../ui/JsonTree";
import type { ProgressPart } from "@tracer-sh/shared";
import { theme } from "../../lib/theme";
import ResultView from "../charts/ResultView";
import { useProgress, type ProgressStore } from "../../lib/progress-store";
import { ThinkingDots } from "./MessageParts";
import { ReasoningBlock } from "./ReasoningBlock";
import { AnalysisContainer } from "./AnalysisContainer";

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  input?: { task?: string; query?: string };
}

interface SubAgentOutput {
  analysis?: string;
  queries?: Array<{ query: string; results: unknown }>;
  parts?: ProgressPart[];
  error?: string;
}

const CRUD_LABELS: Record<string, { done: string; loading: string; errorLabel: string }> = {
  [CLIENT_TOOL_NAMES.CREATE_WIDGET]: { done: "Widget Created", loading: "Creating widget...", errorLabel: "Widget Error" },
  [CLIENT_TOOL_NAMES.UPDATE_WIDGET]: { done: "Widget Updated", loading: "Updating widget...", errorLabel: "Widget Error" },
  [CLIENT_TOOL_NAMES.DELETE_WIDGET]: { done: "Widget Deleted", loading: "Deleting widget...", errorLabel: "Widget Error" },
  [CLIENT_TOOL_NAMES.CREATE_MONITOR]: { done: "Monitor Created", loading: "Creating monitor...", errorLabel: "Monitor Error" },
  [CLIENT_TOOL_NAMES.UPDATE_MONITOR]: { done: "Monitor Updated", loading: "Updating monitor...", errorLabel: "Monitor Error" },
  [CLIENT_TOOL_NAMES.DELETE_MONITOR]: { done: "Monitor Deleted", loading: "Deleting monitor...", errorLabel: "Monitor Error" },
  [CLIENT_TOOL_NAMES.TOGGLE_MONITOR]: { done: "Monitor Toggled", loading: "Toggling monitor...", errorLabel: "Monitor Error" },
};

/** Provider labels by query-tool part type. `tool-execute_*` are the direct query tools a single
 *  agent calls itself (direct + unified mode); the bare `tool-nrql`/`tool-posthog`/... keys render
 *  persisted orchestrator-era sessions. GCP's tools come from its MCP server with dynamic names
 *  (e.g. tool-list_log_entries), so they have no fixed key — GCP is the only MCP-backed provider,
 *  so any unmapped provider query tool is GCP (handled by the fallback below). */
const SUB_AGENT_LABELS: Record<string, string> = {
  "tool-execute_nrql": "New Relic",
  "tool-execute_hogql": "PostHog",
  "tool-nrql": "New Relic",
  "tool-newrelic": "New Relic",
  "tool-hogql": "PostHog",
  "tool-posthog": "PostHog",
  "tool-get_jira_issue": "Jira",
  "tool-add_jira_comment": "Jira",
};

function getSubAgentLabel(toolType: string): string {
  return SUB_AGENT_LABELS[toolType] ?? "Google Cloud";
}

/** Map a provider query-tool part type to its per-provider accent key (left border + label).
 *  Unmapped tools are GCP's dynamically-named MCP tools, so they resolve to the gcp accent. */
const SUB_AGENT_ACCENTS: Record<string, string> = {
  "tool-execute_nrql": "newrelic",
  "tool-execute_hogql": "posthog",
  "tool-nrql": "newrelic",
  "tool-newrelic": "newrelic",
  "tool-hogql": "posthog",
  "tool-posthog": "posthog",
  "tool-get_jira_issue": "jira",
  "tool-add_jira_comment": "jira",
};

function getProviderAccent(toolType: string): { container: string; label: string } {
  const key = SUB_AGENT_ACCENTS[toolType] ?? "gcp";
  return (
    theme.investigationAccents[key] ?? {
      container: theme.investigationContainer,
      label: theme.investigationLabel,
    }
  );
}

// ── Jira integration tool outputs ──

interface JiraCommentView {
  id: string | null;
  author: string | null;
  body: string | null;
  created: string | null;
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
  labels: string[];
  components: string[];
  fixVersions: string[];
  created: string | null;
  updated: string | null;
  dueDate: string | null;
  resolution: string | null;
  comments: JiraCommentView[];
}

function isJiraIssueOutput(o: unknown): o is { issue: JiraIssueView } {
  return (
    !!o && typeof o === "object" && "issue" in o &&
    !!(o as { issue?: unknown }).issue && typeof (o as { issue: unknown }).issue === "object"
  );
}

function isJiraCommentOutput(o: unknown): o is { posted: boolean; url: string } {
  if (!o || typeof o !== "object") return false;
  const r = o as { posted?: unknown; url?: unknown };
  return r.posted === true && typeof r.url === "string";
}

/** ISO timestamp → just the date portion. */
function jiraDate(s: string | null): string | null {
  return s ? s.slice(0, 10) : null;
}

const JiraIssueCard = memo(function JiraIssueCard({
  issue, container, labelClass, headerLabel,
}: { issue: JiraIssueView; container: string; labelClass: string; headerLabel: string }) {
  // Older persisted chats stored a slimmer issue shape, so every optional field
  // (especially the arrays) must be treated as possibly missing.
  const labels = issue.labels ?? [];
  const components = issue.components ?? [];
  const fixVersions = issue.fixVersions ?? [];
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
    ["Components", components.length ? components.join(", ") : null],
    ["Fix versions", fixVersions.length ? fixVersions.join(", ") : null],
  ] as Array<[string, string | null]>).filter((r): r is [string, string] => !!r[1]);

  return (
    <div className={container}>
      <div className={labelClass}>{headerLabel}</div>
      <div className="font-mono text-xs text-[#0052cc] mb-1">{issue.key}</div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="font-medium text-sm">{issue.summary}</span>
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#e6eefc] text-[#0052cc]">
          {issue.status}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-1">
              <span className="opacity-50 min-w-[5.5rem]">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
      {labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-2">
          <span className="opacity-50 text-xs mr-1">Labels</span>
          {labels.map((l) => (
            <span key={l} className="text-[11px] px-1.5 py-0.5 rounded bg-[#f0eee9] text-[#555]">{l}</span>
          ))}
        </div>
      )}
      {issue.description && (
        <div className="text-sm whitespace-pre-wrap text-[#333] border-t border-[#e5e3de] pt-2 mt-1">
          {issue.description}
        </div>
      )}
      {comments.length > 0 && (
        <div className="border-t border-[#e5e3de] pt-2 mt-2 space-y-2">
          <div className="opacity-50 text-xs">Comments ({comments.length})</div>
          {comments.map((c, i) => (
            <div key={c.id ?? i} className="text-xs">
              <div className="flex gap-2 mb-0.5 opacity-70">
                <span className="font-medium">{c.author ?? "Unknown"}</span>
                {jiraDate(c.created) && <span>{jiraDate(c.created)}</span>}
              </div>
              {c.body && <div className="whitespace-pre-wrap text-[#333]">{c.body}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

const JiraCommentCard = memo(function JiraCommentCard({
  url, container, labelClass, headerLabel,
}: { url: string; container: string; labelClass: string; headerLabel: string }) {
  return (
    <div className={container}>
      <div className={labelClass}>{headerLabel}</div>
      <div className="text-sm">
        Comment posted.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline text-[#0052cc]">
          View in Jira
        </a>
      </div>
    </div>
  );
});

function isSubAgentOutput(output: unknown): output is SubAgentOutput {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const o = output as Record<string, unknown>;
  return "parts" in o || "queries" in o || "analysis" in o || "error" in o;
}

/** Convert legacy { queries, analysis } output to ordered parts array */
function legacyToParts(output: SubAgentOutput): ProgressPart[] {
  const parts: ProgressPart[] = [];
  if (output.queries) {
    for (const q of output.queries) {
      parts.push({ type: "query", query: q.query, results: q.results });
    }
  }
  if (output.analysis) {
    parts.push({ type: "text", content: output.analysis });
  }
  return parts;
}

function queryCount(parts: ProgressPart[]): number {
  return parts.filter((p) => p.type === "query").length;
}

const TOOL_LABELS: Record<string, string> = {
  execute_nrql: "Executing NRQL query",
  execute_hogql: "Executing HogQL query",
};

// ── Memoized part components ──

const ToolCallItem = memo(function ToolCallItem({ toolName }: { toolName: string }) {
  const label = TOOL_LABELS[toolName] ?? toolName;
  return (
    <div className="flex items-center gap-2 py-2">
      <span className="inline-block w-3.5 h-3.5 border-2 border-[#2b5ea7] border-t-transparent rounded-full animate-spin" />
      <span className="text-sm text-[#2b5ea7] font-sans">{label}</span>
    </div>
  );
});

const TextItem = memo(function TextItem({ content, isAnimating }: { content: string; isAnimating: boolean }) {
  return (
    <div className={theme.analysisBlock}>
      <Streamdown isAnimating={isAnimating} controls={{ code: true }} linkSafety={{ enabled: false }}>{content}</Streamdown>
    </div>
  );
});

const SummaryItem = memo(function SummaryItem({ content }: { content: string }) {
  return (
    <div className={theme.summaryBlock}>
      <div className={theme.summaryLabel}>Analysis</div>
      <Streamdown isAnimating={false} controls={{ code: true }} linkSafety={{ enabled: false }}>{content}</Streamdown>
    </div>
  );
});

const QueryItem = memo(function QueryItem({ query, results, index, total }: { query: string; results: unknown; index: number; total: number }) {
  return (
    <div className="mb-3">
      <details className="mb-2" open={total === 1}>
        <summary className={theme.toolQueryToggle}>
          Query {total > 1 ? `${index + 1}: ` : ""}{query.length > 80 ? query.slice(0, 80) + "..." : query}
        </summary>
        <div className={theme.toolQueryCode}>{query}</div>
      </details>
      <ResultView data={results} />
    </div>
  );
});

/** Render one progress part. `inAnalysis` selects clean prose (like direct mode's
 *  Analysis section) vs the lighter investigation-phase text styling. */
function renderProgressPart(
  p: ProgressPart,
  key: number,
  isAnimating: boolean,
  qTotal: number,
  nextQueryIndex: () => number,
  inAnalysis: boolean,
) {
  if (p.type === "tool-call") {
    if (!isAnimating) return null;
    return <ToolCallItem key={key} toolName={p.toolName} />;
  }
  if (p.type === "reasoning") {
    return <ReasoningBlock key={key} content={p.content} isAnimating={isAnimating} />;
  }
  if (p.type === "text") {
    if (inAnalysis) {
      if (!p.content.trim()) return null;
      return (
        <Streamdown key={key} isAnimating={isAnimating} controls={{ code: true }} linkSafety={{ enabled: false }}>
          {p.content}
        </Streamdown>
      );
    }
    return <TextItem key={key} content={p.content} isAnimating={isAnimating} />;
  }
  if (p.type === "summary") {
    return <SummaryItem key={key} content={p.content} />;
  }
  if (p.type === "query" && p.query) {
    const idx = nextQueryIndex();
    return <QueryItem key={key} query={p.query} results={p.results} index={idx} total={qTotal} />;
  }
  return null;
}

const ProgressPartsList = memo(function ProgressPartsList({ parts, isAnimating }: { parts: ProgressPart[]; isAnimating: boolean }) {
  const qTotal = queryCount(parts);
  let qIdx = 0;
  const nextQueryIndex = () => qIdx++;

  // Split at the begin_analysis marker (like MessageParts does for direct mode): the part
  // before it is the investigation, everything after is the final Analysis box.
  const markerIdx = parts.findIndex((p) => p.type === "analysis-start");
  const before = markerIdx === -1 ? parts : parts.slice(0, markerIdx);
  const after = markerIdx === -1 ? [] : parts.slice(markerIdx + 1);

  return (
    <>
      {before.map((p, i) => renderProgressPart(p, i, isAnimating, qTotal, nextQueryIndex, false))}
      {after.length > 0 && (
        <AnalysisContainer>
          {after.map((p, i) => renderProgressPart(p, before.length + 1 + i, isAnimating, qTotal, nextQueryIndex, true))}
        </AnalysisContainer>
      )}
      {isAnimating && <ThinkingDots className={theme.investigationThinking} />}
    </>
  );
});

export const ToolPartRenderer = memo(function ToolPartRenderer({ part, progressStore }: { part: ToolPart; progressStore: ProgressStore }) {
  // begin_analysis is an invisible marker — never render it
  if (part.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) return null;

  // AI SDK prefixes tool invocation parts with "tool-". Any tool invocation
  // that isn't CRUD is a sub-agent (provider investigation tool).
  // Subscribe to progress for sub-agents so the already-rendered progress DOM
  // is reused when state transitions to "output-available"
  // (avoids unmounting + remounting thousands of DOM elements in a single frame).
  const isToolInvocation = part.type.startsWith("tool-");
  const isCrud = part.type in CRUD_LABELS;
  const isSubAgent = isToolInvocation && !isCrud;
  const progress = useProgress(progressStore, isSubAgent ? part.toolCallId : undefined);

  if (isSubAgent) {
    const label = getSubAgentLabel(part.type);
    const accent = getProviderAccent(part.type);
    const isComplete = part.state === "output-available";
    const output = isComplete ? part.output : undefined;

    // Handle error output
    if (isComplete && isSubAgentOutput(output) && output.error) {
      return (
        <div className={accent.container}>
          <div className={accent.label}>{label}</div>
          <div className={theme.resultErrorMessage}>{output.error}</div>
        </div>
      );
    }

    // Jira integration tools return plain result objects (not progress streams),
    // so render them as readable cards instead of falling through to raw JSON.
    if (part.type === "tool-get_jira_issue" && isComplete && isJiraIssueOutput(output)) {
      return (
        <JiraIssueCard
          issue={output.issue}
          container={accent.container}
          labelClass={accent.label}
          headerLabel={label}
        />
      );
    }
    if (part.type === "tool-add_jira_comment" && isComplete && isJiraCommentOutput(output)) {
      return (
        <JiraCommentCard
          url={output.url}
          container={accent.container}
          labelClass={accent.label}
          headerLabel={label}
        />
      );
    }

    // Unified rendering path for both streaming and completed states.
    // Prefer progress data (already in DOM) to avoid DOM churn on completion.
    // Fall back to output.parts for page reload (progress store is empty).
    let parts: ProgressPart[] | undefined;
    if (isComplete && isSubAgentOutput(output)) {
      parts = progress?.parts?.length
        ? progress.parts
        : (output.parts?.length ? output.parts : legacyToParts(output));
    } else if (progress?.parts?.length) {
      parts = progress.parts;
    } else if (!isComplete) {
      parts = [];
    }

    if (parts) {
      const qCount = queryCount(parts);
      // Always keep the provider name in the header — in unified mode several providers'
      // query tools stream side by side, so each must be unambiguously labeled.
      const headerLabel = isComplete
        ? `${label} (${qCount} ${qCount === 1 ? "query" : "queries"})`
        : qCount > 0
          ? `${label} — investigating (${qCount} ${qCount === 1 ? "query" : "queries"})`
          : `Querying ${label}...`;
      return (
        <div className={accent.container}>
          <div className={accent.label}>{headerLabel}</div>
          {part.input?.task && (
            <div className={theme.investigationTask}>
              Task: {part.input.task}
            </div>
          )}
          <ProgressPartsList parts={parts} isAnimating={!isComplete} />
        </div>
      );
    }

    // Legacy fallback: raw array result (direct query output)
    if (isComplete && Array.isArray(output)) {
      const query = part.input?.query;
      return (
        <div>
          <div className={theme.toolLabel}>{label} Result</div>
          {query && (
            <details className="mb-2">
              <summary className={theme.toolQueryToggle}>Show query</summary>
              <div className={theme.toolQueryCode}>{query}</div>
            </details>
          )}
          <ResultView data={output} />
        </div>
      );
    }

    // Fallback for unknown completed shapes
    if (isComplete && output != null) {
      return (
        <div>
          <div className={theme.toolLabel}>{label} Result</div>
          <ResultView data={output} />
        </div>
      );
    }

    return null;
  }

  // ── Widget & Monitor CRUD tools ──
  const crudLabel = CRUD_LABELS[part.type];
  if (crudLabel) {
    if (part.state === "output-available") {
      const output = part.output as Record<string, unknown> | undefined;
      const hasError = output && "error" in output;
      return (
        <div>
          <div className={theme.toolLabel}>
            {hasError ? crudLabel.errorLabel : crudLabel.done}
          </div>
          <details className="mb-2">
            <summary className={theme.toolQueryToggle}>Show details</summary>
            <div className={theme.toolQueryCode}>
              <JsonTree data={output} />
            </div>
          </details>
        </div>
      );
    }
    return <div className={theme.toolLoading}>{crudLabel.loading}</div>;
  }

  // Unknown tool types — skip
  return null;
});
