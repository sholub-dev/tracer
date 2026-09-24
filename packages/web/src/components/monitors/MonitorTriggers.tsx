import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { usePolling } from "../../lib/hooks";
import { WEB_CONFIG } from "../../lib/config";
import { formatTime, sinceToSeconds } from "../../lib/monitor-utils";
import { substituteTimeRange, substituteWindow, unixNow } from "@tracer-sh/shared";
import { QueryChart } from "../charts/QueryChart";
import { Badge } from "../ui/Badge";
import { Spinner } from "../ui/Spinner";

const STREAMING_POLL_MS = 5_000;
const MAX_KEYS_SHOWN = 2;
const TRIGGERS_PREVIEW = 5;
const CHART_HEIGHT = 180;

type Trigger = NonNullable<ReturnType<ReturnType<typeof trpc.useUtils>["monitors"]["triggers"]["getData"]>>[number];

function describeFired(t: Trigger): { short: string; full: string } {
  const keys = t.groups.filter((g) => g.key);
  if (keys.length === 0) {
    const text = `${t.value} ${t.value === 1 ? "event" : "events"}`;
    return { short: text, full: text };
  }
  const labels = keys.map((g) => `${g.key} (${g.count})`);
  const extra = labels.length - MAX_KEYS_SHOWN;
  const short = labels.slice(0, MAX_KEYS_SHOWN).join(", ") + (extra > 0 ? ` +${extra}` : "");
  return { short, full: labels.join(", ") };
}

interface TriggerRowProps {
  trigger: Trigger;
  monitorId: string;
  repeatLabels: Map<string, string>;
  onNavigate: (monitorId?: string, sessionId?: string) => void;
}

const TriggerRow = memo(function TriggerRow({ trigger: t, monitorId, repeatLabels, onNavigate }: TriggerRowProps) {
  const fired = describeFired(t);
  const repeatOf = t.status === "repeat" ? t.groups.find((g) => g.repeat && g.sessionId)?.sessionId ?? null : null;
  const sessionId = t.sessionId;
  return (
    <div
      role={sessionId ? "button" : undefined}
      tabIndex={sessionId ? 0 : undefined}
      onClick={sessionId ? () => onNavigate(monitorId, sessionId) : undefined}
      onKeyDown={sessionId ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onNavigate(monitorId, sessionId); } : undefined}
      className={`px-5 py-2 border-t border-[#f0eee9] text-xs font-sans flex items-center gap-3 whitespace-nowrap ${
        sessionId ? "cursor-pointer hover:bg-[#f5f4f0]/60" : ""
      }`}
    >
      <span className="text-[#666666] w-28 shrink-0">{formatTime(t.triggeredAt)}</span>
      <span title={fired.full} className="flex-1 min-w-0 truncate text-[#444444]">{fired.short}</span>
      {t.sessionStatus === "streaming" && <Spinner size="sm" />}
      {repeatOf ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(monitorId, repeatOf); }}
          className="shrink-0 text-[#2b5ea7] hover:text-[#234d8a]"
        >
          Repeat of {repeatLabels.get(repeatOf) ?? "earlier run"}
        </button>
      ) : (
        <span className="shrink-0">
          <Badge variant={t.status === "investigating" ? "info" : "default"}>
            {t.status === "muted" ? "Alert off" : t.status === "repeat" ? "Repeat" : "Investigating"}
          </Badge>
        </span>
      )}
      <span
        title={t.sessionStatus === "done" ? "Unread" : undefined}
        className={`h-2 w-2 shrink-0 rounded-full ${t.sessionStatus === "done" ? "bg-[#2b5ea7]" : ""}`}
      />
    </div>
  );
});

interface MonitorTriggersProps {
  monitorId: string;
  provider: string;
  query: string;
  chartQuery: string | null;
  lastRunAt: number | null;
  since: string;
  onNavigate: (monitorId?: string, sessionId?: string) => void;
}

export const MonitorTriggers = memo(function MonitorTriggers({ monitorId, provider, query: monitorQuery, chartQuery: monitorChartQuery, lastRunAt, since, onNavigate }: MonitorTriggersProps) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const sinceSeconds = sinceToSeconds(since);
  const utils = trpc.useUtils();
  const query = trpc.monitors.triggers.useQuery({ monitorId, sinceSeconds }, { placeholderData: (prev) => prev });
  const triggers = query.data ?? [];
  const hasTriggers = triggers.length > 0;
  const expanded = open && hasTriggers;
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);
  const streaming = triggers.some((t) => t.sessionStatus === "streaming");

  const seenRunAt = useRef(lastRunAt);
  useEffect(() => {
    if (seenRunAt.current === lastRunAt) return;
    seenRunAt.current = lastRunAt;
    utils.monitors.triggers.invalidate({ monitorId });
  }, [lastRunAt, monitorId, utils]);

  usePolling(() => utils.monitors.triggers.invalidate({ monitorId }), STREAMING_POLL_MS, streaming, false);

  // Refresh the chart only when a run crosses a chart bucket boundary.
  const bucketSeconds = Math.max(300, sinceSeconds / WEB_CONFIG.maxBuckets);
  const refreshKey = Math.floor((lastRunAt ?? 0) / bucketSeconds);
  const chartQuery = useMemo(() => {
    if (provider !== "posthog") return `${substituteTimeRange(monitorQuery, since)} TIMESERIES AUTO`;
    const until = Math.ceil(unixNow() / bucketSeconds) * bucketSeconds;
    return substituteWindow(provider, monitorChartQuery ?? monitorQuery, until - sinceSeconds, until);
  }, [provider, monitorQuery, monitorChartQuery, since, sinceSeconds, bucketSeconds, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const repeatLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const t of triggers) {
      if (!t.sessionId) continue;
      labels.set(t.sessionId, formatTime(t.triggeredAt));
    }
    return labels;
  }, [triggers]);

  return (
    <>
      <div className="flex-1 px-5 py-4 border-t border-[#e8e6e1]">
        <QueryChart
          provider={provider}
          query={chartQuery}
          height={CHART_HEIGHT}
          refreshKey={refreshKey}
          growWithLegend
          className="[&_.chart-legend]:max-h-[88px] [&_.chart-legend]:overflow-y-auto"
        />
      </div>

      <div className="relative border-t border-[#e8e6e1]">
        {/* Opens upward over the chart so the card (and its row) keeps its height. */}
        {expanded && (
          <div className="absolute inset-x-0 bottom-full z-20 max-h-[260px] overflow-y-auto bg-white border-t border-[#e8e6e1] shadow-[0_-4px_8px_rgba(0,0,0,0.04)]">
            {(showAll ? triggers : triggers.slice(0, TRIGGERS_PREVIEW)).map((t) => (
              <TriggerRow key={t.id} trigger={t} monitorId={monitorId} repeatLabels={repeatLabels} onNavigate={onNavigate} />
            ))}
          </div>
        )}
        <div
          role={hasTriggers ? "button" : undefined}
          tabIndex={hasTriggers ? 0 : undefined}
          aria-expanded={hasTriggers ? expanded : undefined}
          onClick={hasTriggers ? toggleOpen : undefined}
          onKeyDown={hasTriggers ? (e) => {
            if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
            e.preventDefault();
            toggleOpen();
          } : undefined}
          className={`px-5 flex items-center justify-between py-3 ${
            hasTriggers ? "cursor-pointer hover:bg-[#f5f4f0]/60" : ""
          }`}
        >
          <span className={theme.cardTitle}>
            Times fired ({triggers.length}){hasTriggers && ` ${expanded ? "∨" : ">"}`}
          </span>
          {expanded && triggers.length > TRIGGERS_PREVIEW && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowAll((v) => !v); }}
              className="text-xs text-[#2b5ea7] hover:text-[#234d8a] font-sans"
            >
              {showAll ? "Show latest" : `Show all (${triggers.length})`}
            </button>
          )}
        </div>
      </div>
    </>
  );
});
