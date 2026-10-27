import { useEffect, useRef } from "react";
import { Activity, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { AlertBrief } from "@tracer-sh/server/router";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Toaster } from "@/components/ui/sonner";
import { detectBanners } from "../../lib/alert-banner";
import { formatClock } from "../../lib/format";
import { trpc } from "../../lib/trpc";

const TOASTER_ID = "alerts";
const DISMISSED_MS = 4000;
const SEVERITY: Record<AlertBrief["severity"], string> = {
  high: "bg-destructive-tint text-destructive",
  medium: "bg-warning-tint text-warning",
  low: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};
const VERDICT: Record<string, string> = {
  problem: "bg-destructive/10 text-destructive",
  "no problem": "bg-success-tint text-success",
  unclear: "bg-warning-tint text-warning",
};
const pill = "shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize";

/** The Toaster the alert banners render in: bottom-right on desktop, top-center below the safe area on a phone. */
export function AlertToaster() {
  const isMobile = useIsMobile();
  return (
    <Toaster
      id={TOASTER_ID}
      position={isMobile ? "top-center" : "bottom-right"}
      offset={isMobile ? { top: "calc(env(safe-area-inset-top) + 8px)" } : undefined}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 8px)", bottom: 16 }}
      style={{ "--width": isMobile ? "calc(100vw - 16px)" : "380px" } as React.CSSProperties}
    />
  );
}

interface AlertBannerProps {
  brief: Pick<AlertBrief, "name" | "triggeredAt">;
  /** Null while the run goes on. */
  result: AlertBrief | null;
  onOpen: () => void;
  onClose: () => void;
}

function AlertBanner({ brief, result, onOpen, onClose }: AlertBannerProps) {
  return (
    <div className="relative w-full space-y-1.5 rounded-xl border bg-card px-3.5 py-3 text-card-foreground shadow-lg">
      <button
        type="button"
        aria-label={`Open the investigation of ${brief.name}`}
        onClick={onOpen}
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none flex items-center gap-2 text-sm">
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{brief.name}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">· {formatClock(brief.triggeredAt)}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="pointer-events-auto relative z-10 ml-auto shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      {!result ? (
        <div className="pointer-events-none flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Investigating…
        </div>
      ) : result.dismissed ? (
        <div className="pointer-events-none text-sm text-muted-foreground">No action needed</div>
      ) : (
        <div className="pointer-events-none flex items-start gap-2 text-sm">
          <span className={cn(pill, SEVERITY[result.severity])}>{result.severity}</span>
          {result.verdict && <span className={cn(pill, VERDICT[result.verdict])}>{result.verdict}</span>}
          <span className="line-clamp-2 min-w-0">{result.headline || "No root cause found"}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Shows a banner when a monitor starts an alert session and turns it into the result when the run ends.
 * It reads the session list the sidebar keeps fresh; `activeId` is the open session, which needs no banner.
 */
export function useAlertBanners(open: (id: string) => void, activeId: string | null) {
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  const list = trpc.sessions.list.useQuery().data;
  const known = useRef<ReadonlySet<string> | null>(null);
  const shown = useRef(new Set<string>());
  const latest = useRef({ open, isMobile });
  latest.current = { open, isMobile };

  useEffect(() => {
    if (!list) return;
    if (activeId) {
      shown.current.delete(activeId);
      toast.dismiss(activeId);
    }
    const changes = detectBanners(known.current, shown.current, list, activeId);
    known.current = changes.known;

    const present = async (id: string, finished: boolean) => {
      // Not the query cache: a fetch there joins the in-flight request of the investigating state, which has no result yet.
      const brief = await utils.client.monitors.alertBrief.query({ sessionId: id }).catch(() => null);
      if (!shown.current.has(id)) return;
      if (!brief) {
        shown.current.delete(id);
        toast.dismiss(id);
        return;
      }
      if (finished) shown.current.delete(id);
      const result = finished ? brief : null;
      const forget = () => shown.current.delete(id);
      const close = () => { forget(); toast.dismiss(id); };
      toast.custom(
        () => <AlertBanner brief={brief} result={result} onClose={close} onOpen={() => { close(); latest.current.open(id); }} />,
        {
          id,
          toasterId: TOASTER_ID,
          // The toast is already going: a dismiss from here would re-trigger onDismiss.
          onDismiss: forget,
          onAutoClose: forget,
          duration: !finished ? Infinity : brief.dismissed ? DISMISSED_MS : latest.current.isMobile ? 6000 : 10_000,
        },
      );
    };

    for (const id of changes.gone) {
      shown.current.delete(id);
      toast.dismiss(id);
    }
    for (const id of changes.show) {
      shown.current.add(id);
      void present(id, false);
    }
    for (const id of changes.update) void present(id, true);
  }, [list, activeId, utils]);
}
