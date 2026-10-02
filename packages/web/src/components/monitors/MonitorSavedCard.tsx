import { memo, useEffect } from "react";
import { AlertCircle, CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";

export interface MonitorSavedOutput {
  monitorId?: string;
  name?: string;
  created?: boolean;
  deleted?: boolean;
  run?: boolean;
  alert?: boolean;
  sampleValue?: number;
  wouldTrigger?: boolean;
  error?: string;
}

export const MonitorSavedCard = memo(function MonitorSavedCard({ output, fresh }: { output: MonitorSavedOutput; fresh: boolean }) {
  const utils = trpc.useUtils();
  const { monitorId } = output;
  // Always refetch: the part can mount with its output already set, even for a save that just happened.
  useEffect(() => {
    if (!monitorId) return;
    void utils.monitors.list.invalidate().then(() => {
      // Only new cards are worth scrolling to; updates change in place.
      if (fresh && output.created) document.getElementById(`monitor-${monitorId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [fresh, monitorId, output.created, utils]);

  if (output.error || !monitorId) {
    return (
      <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-destructive/25 bg-destructive-tint px-3 py-2.5 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        {output.error ?? "Monitor was not saved"}
      </div>
    );
  }

  const facts = [
    output.run !== undefined && `Run ${output.run ? "on" : "off"}`,
    output.alert !== undefined && `Alert ${output.alert ? "on" : "off"}`,
    output.sampleValue !== undefined && `Sample ${output.sampleValue}`,
  ].filter(Boolean);

  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 animate-in fade-in duration-200">
      <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span title={output.name} className="block truncate text-sm font-medium">
          {output.deleted ? "Deleted" : output.created ? "Created" : "Updated"} "{output.name}"
        </span>
        {facts.length > 0 && <span className="block truncate text-xs text-muted-foreground tabular-nums">{facts.join(" · ")}</span>}
      </span>
      {output.wouldTrigger !== undefined && (
        <Badge className={cn("rounded-md", output.wouldTrigger ? "bg-destructive-tint text-destructive" : "bg-muted text-ink-2")}>
          {output.wouldTrigger ? "Would fire now" : "Would not fire now"}
        </Badge>
      )}
    </div>
  );
});
