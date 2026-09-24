import { memo, useState } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { formatFrequency } from "../../lib/monitor-utils";
import { Badge } from "../ui/Badge";

const MAX_GROUPS = 10;

export interface MonitorDraftOutput {
  draft?: {
    name: string;
    provider?: "newrelic" | "posthog";
    query: string;
    chartQuery?: string | null;
    condition: string;
    frequencySeconds: number;
  };
  sampleValue?: number;
  groups?: Array<{ key: string; count: number }>;
  wouldTrigger?: boolean;
  chatSessionId?: string;
  error?: string;
}

const labelClass = "text-[#666666] min-w-[5.5rem]";

export const MonitorDraftCard = memo(function MonitorDraftCard({ output }: { output: MonitorDraftOutput }) {
  const utils = trpc.useUtils();
  const [chartExpanded, setChartExpanded] = useState(false);
  const save = trpc.monitors.save.useMutation({
    onSuccess: () => utils.monitors.list.invalidate(),
  });

  if (output.error || !output.draft) {
    return (
      <div className="my-3">
        <div className={theme.toolLabel}>Monitor Draft</div>
        <div className={theme.resultErrorMessage}>{output.error ?? "Invalid monitor draft"}</div>
      </div>
    );
  }

  const { draft, chatSessionId, groups = [] } = output;
  const provider = draft.provider ?? "newrelic";
  const handleSave = () => {
    if (!chatSessionId) return;
    save.mutate({
      chatSessionId,
      name: draft.name,
      provider,
      query: draft.query,
      chartQuery: draft.chartQuery ?? null,
      condition: draft.condition,
      frequencySeconds: draft.frequencySeconds,
    });
  };

  return (
    <div className="my-3 rounded bg-white border border-[#d4d2cd] p-4 font-sans">
      <div className={theme.toolLabel}>Monitor Draft</div>
      <div className="text-sm font-medium text-[#2c2c2c] mb-3">{draft.name}</div>

      <div className="space-y-2 text-xs">
        <div className="flex gap-2">
          <span className={labelClass}>Provider</span>
          <span className="text-[#444444]">{theme.providerCardAccents[provider].label}</span>
        </div>
        <div>
          <div className="text-[#666666] mb-1">Query</div>
          <div className={theme.toolQueryCode}>{draft.query}</div>
        </div>
        {draft.chartQuery && (
          <div>
            <button
              type="button"
              onClick={() => setChartExpanded((v) => !v)}
              aria-expanded={chartExpanded}
              className="text-[#2b5ea7] hover:text-[#234d8a] mb-1"
            >
              Chart query {chartExpanded ? "∨" : ">"}
            </button>
            {chartExpanded && <div className={theme.toolQueryCode}>{draft.chartQuery}</div>}
          </div>
        )}
        <div className="flex gap-2">
          <span className={labelClass}>Condition</span>
          <code className="font-mono text-[#444444]">count {draft.condition}</code>
        </div>
        <div className="flex gap-2">
          <span className={labelClass}>Frequency</span>
          <span className="text-[#444444]">{formatFrequency(draft.frequencySeconds)}</span>
        </div>
        {output.sampleValue !== undefined && (
          <div className="flex items-center gap-2">
            <span className={labelClass}>Sample value</span>
            <span className="font-mono text-[#444444]">{output.sampleValue}</span>
            {output.wouldTrigger !== undefined && (
              <Badge variant={output.wouldTrigger ? "error" : "success"}>
                {output.wouldTrigger ? "Would trigger now" : "Would not trigger now"}
              </Badge>
            )}
          </div>
        )}
        {groups.length > 0 && (
          <div>
            <div className="text-[#666666] mb-1">Groups ({groups.length})</div>
            <div className="space-y-0.5">
              {groups.slice(0, MAX_GROUPS).map((g) => (
                <div key={g.key} className="flex justify-between gap-4 font-mono text-[11px] text-[#444444]">
                  <span className="truncate">{g.key}</span>
                  <span>{g.count}</span>
                </div>
              ))}
              {groups.length > MAX_GROUPS && (
                <div className="text-[#666666]">and {groups.length - MAX_GROUPS} more</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={!chatSessionId || save.isPending || save.isSuccess}
          className={theme.primaryBtn}
        >
          {save.isPending ? "Saving..." : save.isSuccess ? "Saved" : "Save"}
        </button>
        {save.error && <span className={theme.errorText}>{save.error.message}</span>}
        {!chatSessionId && <span className={theme.warnText}>Missing chat session; cannot save.</span>}
      </div>
    </div>
  );
});
