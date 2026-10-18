import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { diffBanners, remainingSeconds, type PendingFiring } from "../../lib/firing-confirm";
import { trpc } from "../../lib/trpc";

const TOASTER_ID = "alerts";
const toastId = (id: string) => `firing-${id}`;

interface FiringBannerProps {
  firing: PendingFiring;
  receivedAt: number;
  onDecide: (start: boolean) => Promise<void>;
}

function FiringBanner({ firing, receivedAt, onDecide }: FiringBannerProps) {
  const [now, setNow] = useState(Date.now());
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const seconds = remainingSeconds(firing.remainingMs, receivedAt, now);
  // The banner closes only when the server has the answer; a failed answer can be sent again before the deadline.
  const decide = (start: boolean) => { setDecided(true); onDecide(start).catch(() => setDecided(false)); };
  return (
    <div className="w-full space-y-2.5 rounded-xl border bg-card px-3.5 py-3 text-card-foreground shadow-lg">
      <div className="flex items-center gap-2 text-sm">
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{firing.monitorName}</span>
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">{firing.detail}</p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm text-muted-foreground tabular-nums" aria-live="off">
          {seconds > 0 ? `Investigating in ${seconds}s` : "Starting…"}
        </span>
        <Button size="sm" variant="outline" disabled={decided} onClick={() => decide(false)}>No</Button>
        <Button size="sm" disabled={decided} onClick={() => decide(true)}>Yes</Button>
      </div>
    </div>
  );
}

/** Asks, in every open window, whether a monitor that just fired should start its investigation. The server decides when the countdown ends. */
export function FiringConfirms() {
  const utils = trpc.useUtils();
  const shown = useRef(new Set<string>());

  trpc.monitors.pendingFirings.useSubscription(undefined, {
    onData: (list) => {
      const receivedAt = Date.now();
      const { show, gone } = diffBanners(shown.current, list);
      for (const id of gone) {
        shown.current.delete(id);
        toast.dismiss(toastId(id));
      }
      for (const firing of show) {
        shown.current.add(firing.id);
        const close = () => { shown.current.delete(firing.id); toast.dismiss(toastId(firing.id)); };
        toast.custom(
          () => (
            <FiringBanner
              firing={firing}
              receivedAt={receivedAt}
              onDecide={(start) =>
                utils.client.monitors.decideFiring.mutate({ id: firing.id, start }).then(close, (err: unknown) => {
                  toast.error(err instanceof Error ? err.message : "Could not send the answer");
                  throw err;
                })}
            />
          ),
          { id: toastId(firing.id), toasterId: TOASTER_ID, duration: Infinity, onDismiss: () => shown.current.delete(firing.id) },
        );
      }
    },
  });
  return null;
}
