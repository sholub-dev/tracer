import { useEffect, useState, type ReactNode } from "react";
import type { SyncSession } from "@tracer-sh/shared";
import { Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { countdown, isSyncOver, modeText, progressFraction, progressText, STEPS, stepMessage, stepStates, type Device } from "../../lib/sync-steps";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** True once `active` has stayed true for `ms`. */
function useAfter(active: boolean, ms: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    setPassed(false);
    if (!active) return;
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return passed;
}

/** The steps of one sync. The computer and the phone render the same view of the same session. */
export function SyncProgress({ session, device, children }: { session: SyncSession; device: Device; children?: ReactNode }) {
  const states = stepStates(session);
  const { phase } = session;
  const ended = isSyncOver(phase);
  const failed = ended && phase !== "done";
  const waitsForPerson = phase === "waiting" || phase === "approval";
  const now = useNow(waitsForPerson);
  const fraction = progressFraction(session.bytes);
  // Most syncs move their data in under a second; a bar that flashes from half to full looks broken.
  const showBar = useAfter(phase === "transfer", 1000);

  return (
    <div className="min-w-0 flex-1 basis-56 space-y-4">
      <ol className="space-y-3">
        {STEPS.map((label, i) => {
          const state = states[i];
          const current = state === "current";
          return (
            <li key={label} className="flex items-start gap-3" aria-current={current && !ended ? "step" : undefined}>
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-muted-foreground",
                  state === "done" && "border-success/40 bg-success/10 text-success",
                  current && !failed && "border-primary/40 text-primary",
                  current && failed && "border-destructive/40 bg-destructive/10 text-destructive",
                )}
              >
                {state === "done" ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : current && failed ? (
                  <X className="size-3" aria-hidden="true" />
                ) : current ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : null}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm font-medium", state === "todo" && "text-muted-foreground")}>{label}</div>
                {current && (
                  <div className="mt-0.5 space-y-2 text-[13px]/[18px]">
                    <p role={failed ? "alert" : "status"} className={failed ? "text-destructive" : "text-ink-2"}>
                      {stepMessage(session, device)}
                    </p>
                    {phase === "approval" && session.mode && <p className="text-muted-foreground">{modeText(session.mode, device)}</p>}
                    {phase === "transfer" && showBar && (
                      <div className="space-y-1">
                        <div
                          role="progressbar"
                          aria-label="Send data"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
                          className="h-1.5 overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className={cn("h-full rounded-full bg-primary transition-[width] duration-700 ease-out", fraction === null && "w-1/3 animate-pulse")}
                            style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
                          />
                        </div>
                        {session.bytes && <p className="text-muted-foreground">{progressText(session.bytes)}</p>}
                      </div>
                    )}
                    {waitsForPerson && (
                      <p className="text-muted-foreground">
                        {phase === "waiting" ? "Code expires in" : "Time left to allow:"} {countdown(session.expiresAt, now)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {phase === "done" && (
        <p role="status" className="flex items-start gap-1.5 text-sm text-success">
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {stepMessage(session, device)}
        </p>
      )}
      {children}
    </div>
  );
}
