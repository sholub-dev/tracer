import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { unixNow } from "@tracer-sh/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { formatTime } from "../../lib/monitor-utils";

const countdown = (secs: number) => {
  const m = Math.floor(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(secs % 60).padStart(2, "0")}`;
};

// One CSS animation from the width at mount to empty, so it stays smooth between the 1s text ticks.
function ShrinkingBar({ fireAt, setAt }: { fireAt: number; setAt: number }) {
  const [style] = useState(() => {
    const left = Math.max(0, fireAt - unixNow());
    return { transform: `scaleX(${Math.min(1, left / Math.max(1, fireAt - setAt))})`, animationDuration: `${left}s` };
  });
  return <span data-timer-bar className="block h-full origin-left animate-shrink rounded-full bg-primary" style={style} />;
}

/** The session's pending follow-up timer, live. */
export function FollowUpTimerBar({ sessionId, className }: { sessionId: string; className?: string }) {
  const { data: timer } = trpc.sessions.timer.useQuery({ id: sessionId });
  const [now, setNow] = useState(unixNow);
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(unixNow()), 1000);
    return () => clearInterval(id);
  }, [timer]);
  if (!timer) return null;
  const left = Math.max(0, timer.fireAt - now);
  return (
    <div role="timer" aria-label={`Follow-up at ${formatTime(timer.fireAt)}: ${timer.note}`} className={cn("flex items-center gap-3 pb-2.5 text-[13px]/[18px] text-ink-2", className)}>
      <Timer className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="shrink-0 rounded-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {left > 0 ? (
              <>
                Follow-up in <span className="font-medium text-foreground tabular-nums">{countdown(left)}</span>{" "}
                <span className="text-muted-foreground">({formatTime(timer.fireAt)})</span>
              </>
            ) : (
              "Follow-up due now"
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">{timer.note}</TooltipContent>
      </Tooltip>
      <span className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <ShrinkingBar key={timer.fireAt} fireAt={timer.fireAt} setAt={timer.setAt} />
      </span>
    </div>
  );
}
