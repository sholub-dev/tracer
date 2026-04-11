import { extractMcpContent, isTransportError, detectTruncation } from "../../mcp/mcp-tools.js";
import type { SubAgentQuery } from "../../agents/chat/sub-agent.js";
import type { McpProvider } from "../../mcp/mcp-provider.js";

// ── Helpers ──

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v) || Math.abs(v) > 1000) return v.toLocaleString();
    return v.toFixed(2);
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (!isNaN(n) && v.trim() !== "") {
      if (Number.isInteger(n) || Math.abs(n) > 1000) return n.toLocaleString();
      return n.toFixed(2);
    }
    return v;
  }
  if (Array.isArray(v)) return v.length <= 3 ? v.join(", ") : `[${v.length} items]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(empty)";
  const hdr = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`)
    .join("\n");
  return `${hdr}\n${sep}\n${body}`;
}

function trunc(s: string, max = 100): string {
  const str = String(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Slice an array to `max` items and return a "Showing X of Y" note. */
function cap<T>(items: T[], max: number, label: string): { display: T[]; note: string } {
  if (items.length <= max) return { display: items, note: "" };
  return {
    display: items.slice(0, max),
    note: `\n\n*Showing ${max} of ${items.length} ${label}*`,
  };
}

/** Extract a human-readable message from a log entry's payload. */
function extractLogMessage(entry: Record<string, unknown>): string {
  if (typeof entry.textPayload === "string") return trunc(entry.textPayload);
  if (entry.jsonPayload && typeof entry.jsonPayload === "object") {
    const jp = entry.jsonPayload as Record<string, unknown>;
    for (const k of ["message", "msg", "error", "text"]) {
      if (typeof jp[k] === "string") return trunc(jp[k] as string);
    }
    // Sample first two keys rather than stringifying the whole payload
    const sample = Object.entries(jp)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${typeof v === "object" ? "[Object]" : v}`)
      .join(" ");
    return trunc(sample);
  }
  if (entry.protoPayload && typeof entry.protoPayload === "object") {
    const pp = entry.protoPayload as Record<string, unknown>;
    if (pp.status && typeof pp.status === "object") {
      const st = pp.status as Record<string, unknown>;
      return trunc(`${st.code ?? ""} ${st.message ?? ""}`.trim());
    }
  }
  return "—";
}

/** Unwrap GCP API envelope shapes — handles arrays, { logEntries: [...] }, etc. */
function toArray(data: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const k of keys) {
      if (Array.isArray(d[k])) return d[k] as unknown[];
    }
  }
  return [];
}

// ── Per-tool formatters ──

function formatLogEntries(data: unknown): string {
  const entries = toArray(data, "logEntries", "entries");
  if (entries.length === 0) return "No log entries found.";

  const { display, note } = cap(entries, 10, "entries");
  const rows = display.map((e) => {
    const entry = e as Record<string, unknown>;
    const ts =
      typeof entry.timestamp === "string"
        ? entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z")
        : "—";
    const sev = String(entry.severity ?? "DEFAULT");
    const resource = entry.resource as Record<string, unknown> | undefined;
    const labels = resource?.labels as Record<string, string> | undefined;
    const resName = labels
      ? Object.values(labels).filter(Boolean).slice(0, 2).join("/")
      : String(resource?.type ?? "—");
    const msg = extractLogMessage(entry);
    return [ts, sev, resName, msg];
  });

  return mdTable(["Timestamp", "Severity", "Resource", "Message"], rows) + note;
}

function formatTimeSeries(data: unknown): string {
  const series = toArray(data, "timeSeries");
  if (series.length === 0) return "No time series data found.";

  const MAX_ROWS = 20;
  const rows: string[][] = [];

  for (const ts of series) {
    if (rows.length >= MAX_ROWS) break;

    const t = ts as Record<string, unknown>;
    const metricType = (t.metric as Record<string, unknown> | undefined)?.type ?? "—";
    const metricLabels = (t.metric as Record<string, unknown> | undefined)?.labels;
    const metricSuffix =
      metricLabels && typeof metricLabels === "object"
        ? Object.values(metricLabels as Record<string, string>).filter(Boolean).join("/")
        : "";
    const metricName = metricSuffix ? `${metricType} [${metricSuffix}]` : String(metricType);

    const points = Array.isArray(t.points) ? (t.points as Record<string, unknown>[]) : [];
    if (points.length === 0) {
      rows.push(["—", String(metricName), "no data"]);
      continue;
    }

    // Downsample to at most 5 points per series
    let displayPoints = points;
    let pointNote = "";
    if (points.length > 5) {
      const step = Math.ceil(points.length / 5);
      displayPoints = points.filter((_, i) => i % step === 0);
      pointNote = ` (${points.length} pts total)`;
    }

    for (const pt of displayPoints) {
      if (rows.length >= MAX_ROWS) break;
      const p = pt as Record<string, unknown>;
      const interval = p.interval as Record<string, unknown> | undefined;
      const time = String(interval?.endTime ?? interval?.startTime ?? "—");
      const value = p.value as Record<string, unknown> | undefined;
      const val = value
        ? (value.int64Value ?? value.doubleValue ?? value.distributionValue ?? JSON.stringify(value))
        : "—";
      rows.push([time, `${metricName}${pointNote}`, fmtVal(val)]);
    }
  }

  if (rows.length === 0) return "Time series returned but no data points found.";
  return mdTable(["Time", "Metric", "Value"], rows);
}

function formatSpans(spans: unknown[]): string {
  if (spans.length === 0) return "(no spans)";

  const { display, note } = cap(spans, 20, "spans");
  const rows = display.map((s) => {
    const span = s as Record<string, unknown>;
    const name = String(span.displayName ?? span.name ?? "—");
    const startMs = span.startTime ? new Date(String(span.startTime)).getTime() : NaN;
    const endMs = span.endTime ? new Date(String(span.endTime)).getTime() : NaN;
    const dur = !isNaN(startMs) && !isNaN(endMs) ? `${endMs - startMs}ms` : "—";
    const status = (span.status as Record<string, unknown> | undefined)?.code ?? "OK";
    return [trunc(name, 60), dur, String(status)];
  });

  return mdTable(["Span", "Duration", "Status"], rows) + note;
}

function formatTraces(data: unknown): string {
  const traces = toArray(data, "traces");
  if (traces.length === 0) return "No traces found.";

  const { display, note } = cap(traces, 10, "traces");
  const rows = display.map((t) => {
    const trace = t as Record<string, unknown>;
    const id = String(trace.traceId ?? "—");
    const shortId = id.length > 16 ? id.slice(0, 16) + "…" : id;
    const spans = Array.isArray(trace.spans) ? (trace.spans as Record<string, unknown>[]) : [];
    const root = spans[0];
    const name = root ? String(root.displayName ?? root.name ?? "—") : "—";
    const startMs = root?.startTime ? new Date(String(root.startTime)).getTime() : NaN;
    const endMs = root?.endTime ? new Date(String(root.endTime)).getTime() : NaN;
    const dur = !isNaN(startMs) && !isNaN(endMs) ? `${endMs - startMs}ms` : "—";
    return [shortId, trunc(name, 60), dur, String(spans.length)];
  });

  return mdTable(["Trace ID", "Root Span", "Duration", "Spans"], rows) + note;
}

function formatTrace(data: unknown): string {
  if (!data || typeof data !== "object") return "No trace data.";
  const trace = data as Record<string, unknown>;
  const traceId = String(trace.traceId ?? "—");
  const spans = Array.isArray(trace.spans) ? (trace.spans as unknown[]) : [];
  return `**Trace:** ${traceId}\n\n${formatSpans(spans)}`;
}

function formatErrorGroups(data: unknown): string {
  const groups = toArray(data, "errorGroupStats", "groups");
  if (groups.length === 0) return "No error groups found.";

  const { display, note } = cap(groups, 10, "error groups");
  const rows = display.map((g) => {
    const group = g as Record<string, unknown>;
    const groupInfo = group.group as Record<string, unknown> | undefined;
    const rep = group.representative as Record<string, unknown> | undefined;
    const title = groupInfo?.title ?? rep?.message ?? "—";
    const count = fmtVal(group.count ?? group.numAffectedServices);
    const first =
      typeof group.firstSeenTime === "string"
        ? group.firstSeenTime.replace("T", " ").split(".")[0] + "Z"
        : "—";
    const last =
      typeof group.lastSeenTime === "string"
        ? group.lastSeenTime.replace("T", " ").split(".")[0] + "Z"
        : "—";
    return [trunc(String(title), 80), count, first, last];
  });

  return mdTable(["Error", "Count", "First Seen", "Last Seen"], rows) + note;
}

function formatMetricDescriptors(data: unknown): string {
  const descriptors = toArray(data, "metricDescriptors");
  if (descriptors.length === 0) return "No metric descriptors found.";

  const { display, note } = cap(descriptors, 20, "descriptors");
  const rows = display.map((d) => {
    const desc = d as Record<string, unknown>;
    return [String(desc.type ?? desc.name ?? "—"), String(desc.displayName ?? "—")];
  });

  return mdTable(["Metric Type", "Display Name"], rows) + note;
}

function formatAlertPolicies(data: unknown): string {
  const policies = toArray(data, "alertPolicies");
  if (policies.length === 0) return "No alert policies found.";

  const { display, note } = cap(policies, 15, "policies");
  const rows = display.map((p) => {
    const policy = p as Record<string, unknown>;
    const name = String(policy.displayName ?? policy.name ?? "—");
    const enabled =
      policy.enabled === true ? "yes" : policy.enabled === false ? "no" : "—";
    const conditions = Array.isArray(policy.conditions) ? String(policy.conditions.length) : "—";
    return [trunc(name, 60), enabled, conditions];
  });

  return mdTable(["Policy", "Enabled", "Conditions"], rows) + note;
}

// ── Main entry point ──

export function formatGcpResult(toolName: string, data: unknown): string {
  switch (toolName) {
    case "list_log_entries":
      return formatLogEntries(data);
    case "list_time_series":
      return formatTimeSeries(data);
    case "list_traces":
      return formatTraces(data);
    case "get_trace":
      return formatTrace(data);
    case "list_group_stats":
      return formatErrorGroups(data);
    case "list_metric_descriptors":
      return formatMetricDescriptors(data);
    case "list_alert_policies":
      return formatAlertPolicies(data);
    default: {
      // Generic fallback — compact JSON, size-capped
      const json = typeof data === "string" ? data : JSON.stringify(data);
      if (json.length <= 3_000) return "```json\n" + json + "\n```";
      return "```json\n" + json.slice(0, 3_000) + "\n...[truncated]\n```";
    }
  }
}

// ── GCP-specific MCP tool wrapper ──

const MAX_MODEL_RESULT_CHARS = 8_000;


function buildGcpModelResult(toolName: string, normalized: unknown): string {
  const formatted = formatGcpResult(toolName, normalized);
  if (formatted.length <= MAX_MODEL_RESULT_CHARS) return formatted;
  return (
    formatted.slice(0, MAX_MODEL_RESULT_CHARS) +
    "\n\n*[truncated — full results displayed in the UI]*"
  );
}

/**
 * GCP-specific variant of wrapMcpTools that formats results as Markdown
 * tables before returning them to the sub-agent, rather than raw JSON.
 */
export function wrapGcpMcpTools(
  mcpTools: Record<string, any>,
  provider: McpProvider,
): {
  wrappedTools: Record<string, any>;
  mcpToolNames: string[];
  collectedQueries: SubAgentQuery[];
} {
  const collectedQueries: SubAgentQuery[] = [];
  const mcpToolNames = Object.keys(mcpTools);
  const wrappedTools: Record<string, any> = {};

  for (const [name, mcpTool] of Object.entries(mcpTools)) {
    const originalExecute = (mcpTool as any).execute.bind(mcpTool);

    wrappedTools[name] = {
      ...mcpTool,
      execute: async (input: any, context?: { abortSignal?: AbortSignal }) => {
        const queryStr =
          typeof input === "string" ? input : JSON.stringify(input).slice(0, 500);

        const execArgs = context?.abortSignal
          ? [input, { abortSignal: context.abortSignal }]
          : [input];

        try {
          const result = await originalExecute(...execArgs);
          const normalized = extractMcpContent(result);

          if (detectTruncation(normalized)) {
            const errorMsg =
              `The result exceeded the server's size limit and was discarded. ` +
              `To fix this:\n` +
              `1. Reduce pageSize (use 5-10, never exceed 20)\n` +
              `2. Add more specific filters to narrow results\n` +
              `3. Request fewer fields or a shorter time range\n` +
              `Retry with a more targeted query.`;
            collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: errorMsg } });
            return { content: [{ type: "text", text: errorMsg }] };
          }

          // Store full result for UI display
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: normalized });
          // Return GCP-formatted Markdown to the model
          return { content: [{ type: "text", text: buildGcpModelResult(name, normalized) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: message } });
          if (isTransportError(err)) provider.invalidateTools();
          return { error: message };
        }
      },
    };
  }

  return { wrappedTools, mcpToolNames, collectedQueries };
}
