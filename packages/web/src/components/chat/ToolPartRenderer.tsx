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
