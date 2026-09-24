import { memo, useMemo } from "react";
import { WEB_CONFIG } from "../../lib/config";
import { parseThreshold, sinceToSeconds } from "../../lib/monitor-utils";
import { substituteTimeRange, substituteWindow, unixNow } from "@tracer-sh/shared";
import { QueryChart } from "../charts/QueryChart";

const CHART_HEIGHT = 180;

interface MonitorChartProps {
  provider: string;
  query: string;
  condition: string;
  chartQuery: string | null;
  lastRunAt: number | null;
  since: string;
}

export const MonitorChart = memo(function MonitorChart({ provider, query: monitorQuery, condition, chartQuery: monitorChartQuery, lastRunAt, since }: MonitorChartProps) {
  const sinceSeconds = sinceToSeconds(since);
  // Refresh the chart only when a run crosses a chart bucket boundary.
  const bucketSeconds = Math.max(300, sinceSeconds / WEB_CONFIG.maxBuckets);
  const refreshKey = Math.floor((lastRunAt ?? 0) / bucketSeconds);
  const chartQuery = useMemo(() => {
    if (provider !== "posthog") return `${substituteTimeRange(monitorQuery, since)} TIMESERIES AUTO`;
    const until = Math.ceil(unixNow() / bucketSeconds) * bucketSeconds;
    return substituteWindow(provider, monitorChartQuery ?? monitorQuery, until - sinceSeconds, until);
  }, [provider, monitorQuery, monitorChartQuery, since, sinceSeconds, bucketSeconds, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const threshold = useMemo(() => parseThreshold(condition), [condition]);

  return (
    <div className="flex-1 px-5 py-4 border-t border-[#e8e6e1]">
      <QueryChart
        provider={provider}
        query={chartQuery}
        height={CHART_HEIGHT}
        refreshKey={refreshKey}
        threshold={threshold}
        growWithLegend
        className="[&_.chart-legend]:max-h-[88px] [&_.chart-legend]:overflow-y-auto"
      />
    </div>
  );
});
