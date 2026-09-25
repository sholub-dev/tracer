import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { usePolling } from "../../lib/hooks";
import { formatTime, sinceToSeconds } from "../../lib/monitor-utils";
import { MonitorChart } from "./MonitorChart";
import { Badge } from "../ui/Badge";
import { Spinner } from "../ui/Spinner";

const STREAMING_POLL_MS = 5_000;
const MAX_KEYS_SHOWN = 2;

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
  repeatLabels: Map<string, string>;
  onNavigate: (sessionId: string) => void;
}

const TriggerRow = memo(function TriggerRow({ trigger: t, repeatLabels, onNavigate }: TriggerRowProps) {
  const fired = describeFired(t);
  const repeatOf = t.status === "repeat" ? t.groups.find((g) => g.repeat && g.sessionId)?.sessionId ?? null : null;
  const sessionId = t.sessionId;
  return (
    <div
      role={sessionId ? "button" : undefined}
      tabIndex={sessionId ? 0 : undefined}
      onClick={sessionId ? () => onNavigate(sessionId) : undefined}
      onKeyDown={sessionId ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onNavigate(sessionId); } : undefined}
      className={`px-5 py-2 text-xs font-sans flex items-center gap-3 whitespace-nowrap ${
        sessionId ? "cursor-pointer hover:bg-[#f5f4f0]/60" : ""
      }`}
    >
      <span className="text-[#666666] w-28 shrink-0">{formatTime(t.triggeredAt)}</span>
      <span title={fired.full} className="flex-1 min-w-0 truncate text-[#444444]">{fired.short}</span>
      {t.sessionStatus === "streaming" && <Spinner size="sm" />}
      {repeatOf ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNavigate(repeatOf); }}
          className="shrink-0 text-[#2b5ea7] hover:text-[#234d8a]"
        >
          Repeat of {repeatLabels.get(repeatOf) ?? "earlier run"}
        </button>
      ) : sessionId ? (
        <span className="shrink-0 text-[#2b5ea7]">Open session</span>
      ) : t.status === "investigating" ? (
        <span className="shrink-0 text-[#999999]">Session deleted</span>
      ) : (
        <span className="shrink-0">
          <Badge variant="default">{t.status === "muted" ? "Alert off" : "Repeat"}</Badge>
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
  condition: string;
  chartQuery: string | null;
  lastRunAt: number | null;
  since: string;
  onNavigate: (sessionId: string) => void;
}

export const MonitorTriggers = memo(function MonitorTriggers({ monitorId, provider, query: monitorQuery, condition, chartQuery: monitorChartQuery, lastRunAt, since, onNavigate }: MonitorTriggersProps) {
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
      {/* The list replaces the chart in place, so the card (and its grid row) keeps its height. */}
      <div className="relative flex-1 flex flex-col min-h-[212px]">
        <MonitorChart provider={provider} query={monitorQuery} condition={condition} chartQuery={monitorChartQuery} lastRunAt={lastRunAt} since={since} />
        {expanded && (
          <div className="absolute inset-0 z-20 overflow-y-auto bg-white border-t border-[#e8e6e1] divide-y divide-[#f0eee9]">
            {triggers.map((t) => (
              <TriggerRow key={t.id} trigger={t} repeatLabels={repeatLabels} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </div>

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
        className={`px-5 flex items-center justify-between py-3 border-t border-[#e8e6e1] ${
          hasTriggers ? "cursor-pointer hover:bg-[#f5f4f0]/60" : ""
        }`}
      >
        <span className={theme.cardTitle}>
          Times fired ({triggers.length}){hasTriggers && ` ${expanded ? "∨" : ">"}`}
        </span>
      </div>
    </>
  );
});
