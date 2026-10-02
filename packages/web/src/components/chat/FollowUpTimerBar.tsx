import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";

const countdown = (secs: number) => {
  const m = Math.floor(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(secs % 60).padStart(2, "0")}`;
};

/** The session's pending follow-up timer, live. */
export function FollowUpTimerBar({ sessionId }: { sessionId: string }) {
  const { data: timer } = trpc.sessions.timer.useQuery({ id: sessionId });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [timer]);
  if (!timer) return null;
  const at = timer.fireAt === null ? null : new Date(timer.fireAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const status = timer.fireAt === null ? "running now" : timer.fireAt <= now ? "due now" : `in ${countdown(timer.fireAt - now)} (${at})`;
  return (
    <div className="px-4 py-1.5 bg-[#f5f4f0] border-t border-[#d4d2cd] text-xs text-[#444444] font-sans truncate" title={timer.note}>
      <span className="font-medium">Follow-up {status}:</span> {timer.note}
    </div>
  );
}
