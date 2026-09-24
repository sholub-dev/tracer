import { memo, useEffect } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { Badge } from "../ui/Badge";

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
      <div className="my-3">
        <div className={theme.toolLabel}>Monitor</div>
        <div className={theme.resultErrorMessage}>{output.error ?? "Monitor was not saved"}</div>
      </div>
    );
  }

  return (
    <div className="my-2 flex items-center gap-3 font-sans text-xs text-[#666666]">
      <span title={output.name} className="min-w-0 truncate text-[#2c2c2c]">
        {output.deleted ? "Deleted" : output.created ? "Created" : "Updated"} monitor "{output.name}"
      </span>
      {output.run !== undefined && <span className="shrink-0">Run {output.run ? "on" : "off"}</span>}
      {output.alert !== undefined && <span className="shrink-0">Alert {output.alert ? "on" : "off"}</span>}
      {output.sampleValue !== undefined && (
        <span className="shrink-0">Sample <span className="font-mono text-[#444444]">{output.sampleValue}</span></span>
      )}
      {output.wouldTrigger !== undefined && (
        <Badge variant={output.wouldTrigger ? "error" : "success"}>
          {output.wouldTrigger ? "Would fire now" : "Would not fire"}
        </Badge>
      )}
    </div>
  );
});
