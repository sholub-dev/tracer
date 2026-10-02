import { useEffect, useState } from "react";
import { unixNow } from "@tracer-sh/shared";
import { trpc } from "../../lib/trpc";
import { formatTime } from "../../lib/monitor-utils";

const countdown = (secs: number) => {
  const m = Math.floor(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(secs % 60).padStart(2, "0")}`;
};

/** The session's pending follow-up timer, live. */
export function FollowUpTimerBar({ sessionId }: { sessionId: string }) {
  const { data: timer } = trpc.sessions.timer.useQuery({ id: sessionId });
  const [now, setNow] = useState(unixNow);
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(unixNow()), 1000);
    return () => clearInterval(id);
  }, [timer]);
  if (!timer) return null;
  const status = timer.fireAt <= now ? "due now" : `in ${countdown(timer.fireAt - now)} (${formatTime(timer.fireAt)})`;
  return (
    <div className="px-4 py-1.5 bg-[#f5f4f0] border-t border-[#d4d2cd] text-xs text-[#444444] font-sans truncate" title={timer.note}>
      <span className="font-medium">Follow-up {status}:</span> {timer.note}
    </div>
  );
}
