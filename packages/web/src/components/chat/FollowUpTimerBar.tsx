import { useEffect, useState } from "react";
import { unixNow } from "@tracer-sh/shared";
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
    return { width: `${Math.min(100, (100 * left) / Math.max(1, fireAt - setAt))}%`, animation: `shrink-width ${left}s linear forwards` };
  });
  return <div className="h-full bg-[#2b5ea7]" style={style} />;
}

/** The session's pending follow-up timer, live. */
export function FollowUpTimerBar({ sessionId, className = "" }: { sessionId: string; className?: string }) {
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
    <div className={`flex items-center gap-3 py-2 text-xs text-[#444444] font-sans ${className}`} title={timer.note}>
      <span className="font-medium whitespace-nowrap tabular-nums">
        {left > 0 ? `Follow-up in ${countdown(left)} (${formatTime(timer.fireAt)})` : "Follow-up due now"}
      </span>
      <div className="flex-1 h-1 rounded-full bg-[#d4d2cd] overflow-hidden">
        <ShrinkingBar key={timer.fireAt} fireAt={timer.fireAt} setAt={timer.setAt} />
      </div>
    </div>
  );
}
