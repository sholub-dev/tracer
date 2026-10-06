import { memo, useEffect, useMemo, useRef } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { sinceToSeconds } from "../../lib/monitor-utils";
import { formatTime } from "../../lib/format";

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
  const repeatOf = t.groups.find((g) => g.repeat && g.sessionId)?.sessionId ?? null;
  const sessionId = t.sessionId;
  const unread = t.sessionStatus === "done";
  return (
    <li
      className={cn(
        "relative flex items-center gap-3 rounded-md py-2 pl-2.5 text-[13px] leading-[18px] whitespace-nowrap",
        sessionId ? "pr-3 transition-colors duration-150 hover:bg-muted/60" : "pr-[38px]",
      )}
    >
      <span className="flex w-2 shrink-0 justify-center" aria-hidden="true">
        {unread && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className="w-28 shrink-0 text-ink-2 tabular-nums sm:w-36">{formatTime(t.triggeredAt)}</span>
      {sessionId ? (
        // The row is one link; its ::after stretches over the row so the Repeat button can sit beside it.
        <button
          type="button"
          title={fired.full}
          onClick={() => onNavigate(sessionId)}
          className={cn(
            "min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/50",
            unread && "font-semibold",
          )}
        >
          {fired.short}
          {unread && <span className="sr-only"> (unread)</span>}
        </button>
      ) : (
        <span title={fired.full} className="min-w-0 flex-1 truncate">{fired.short}</span>
      )}
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {t.sessionStatus === "streaming" && (
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Investigating
          </span>
        )}
        {repeatOf && (
          <button
            type="button"
            onClick={() => onNavigate(repeatOf)}
            className="relative z-10 rounded-sm text-primary outline-none hover:text-primary-hover hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Repeat of {repeatLabels.get(repeatOf) ?? "earlier run"}
          </button>
        )}
        {!sessionId && t.status === "investigating" && <span>Investigation deleted</span>}
        {t.status === "muted" && <Badge className="rounded-md bg-muted font-normal text-ink-2">Alert off</Badge>}
      </span>
      {sessionId && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </li>
  );
});

interface MonitorTriggersProps {
  monitorId: string;
  lastRunAt: number | null;
  since: string;
  rangeLabel: string;
  onNavigate: (sessionId: string) => void;
}

export const MonitorTriggers = memo(function MonitorTriggers({ monitorId, lastRunAt, since, rangeLabel, onNavigate }: MonitorTriggersProps) {
  const utils = trpc.useUtils();
  const query = trpc.monitors.triggers.useQuery({ monitorId, sinceSeconds: sinceToSeconds(since) }, { placeholderData: (prev) => prev, refetchOnMount: "always" });
  const triggers = query.data ?? [];

  const seenRunAt = useRef(lastRunAt);
  useEffect(() => {
    if (seenRunAt.current === lastRunAt) return;
    seenRunAt.current = lastRunAt;
    utils.monitors.triggers.invalidate({ monitorId });
  }, [lastRunAt, monitorId, utils]);

  const repeatLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const t of triggers) if (t.sessionId) labels.set(t.sessionId, formatTime(t.triggeredAt));
    return labels;
  }, [triggers]);

  if (triggers.length === 0) {
    return (
      <p className="flex h-8 items-center px-2.5 text-[13px] leading-[18px] text-muted-foreground">
        No firings in {rangeLabel}
      </p>
    );
  }

  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group/trigger text-ink-2 aria-expanded:bg-transparent aria-expanded:hover:bg-muted">
          <ChevronRight className="size-3.5 transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90" aria-hidden="true" />
          Fired {triggers.length === 1 ? "once" : `${triggers.length} times`} in {rangeLabel}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 mb-1 max-h-80 divide-y overflow-y-auto border-t">
          {triggers.map((t) => (
            <TriggerRow key={t.id} trigger={t} repeatLabels={repeatLabels} onNavigate={onNavigate} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});
