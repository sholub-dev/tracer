import { memo, useMemo } from "react";
import { WEB_CONFIG } from "../../lib/config";
import { parseThreshold, sinceToSeconds } from "../../lib/monitor-utils";
import { substituteWindow, unixNow } from "@tracer-sh/shared";
import { QueryChart } from "../charts/QueryChart";

const CHART_HEIGHT = 180;
const DAY = 86_400;
// Fixed buckets per range preset (24h, 7d, 30d, 90d); NRQL's AUTO picks 6h buckets for 7d.
const BUCKET_SECONDS: Record<number, number> = { [DAY]: 900, [7 * DAY]: 3600, [30 * DAY]: 21_600, [90 * DAY]: DAY };

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
  const bucketSeconds = BUCKET_SECONDS[sinceSeconds] ?? Math.max(300, Math.ceil(sinceSeconds / WEB_CONFIG.maxBuckets / 60) * 60);
  const refreshKey = lastRunAt ?? 0;
  const chartQuery = useMemo(() => {
    // Buckets end on local clock boundaries, so the last point is the current bucket, not one hours old.
    const offset = new Date().getTimezoneOffset() * 60;
    const until = Math.ceil((unixNow() - offset) / bucketSeconds) * bucketSeconds + offset;
    if (provider !== "posthog") {
      return `${substituteWindow(provider, monitorQuery, until - sinceSeconds, until)} TIMESERIES ${bucketSeconds / 60} minutes`;
    }
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
