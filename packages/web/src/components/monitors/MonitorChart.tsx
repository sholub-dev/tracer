import { memo, useMemo } from "react";
import { WEB_CONFIG } from "../../lib/config";
import { parseThreshold, sinceToSeconds } from "../../lib/monitor-utils";
import { substituteWindow, unixNow } from "@tracer-sh/shared";
import { QueryChart } from "../charts/QueryChart";
import { cn } from "@/lib/utils";

const CHART_HEIGHT = 180;
const HOUR = 3600;
const DAY = 24 * HOUR;
// Fixed buckets per range preset; NRQL's AUTO picks 6h buckets for 7d.
const BUCKET_SECONDS: Record<number, number> = { [HOUR]: 120, [3 * HOUR]: 300, [6 * HOUR]: 600, [DAY]: 900, [7 * DAY]: 3600, [30 * DAY]: 21_600, [90 * DAY]: DAY };

interface MonitorChartProps {
  provider: string;
  query: string;
  condition: string;
  chartQuery: string | null;
  lastRunAt: number | null;
  since: string;
  className?: string;
}

export const MonitorChart = memo(function MonitorChart({ provider, query: monitorQuery, condition, chartQuery: monitorChartQuery, lastRunAt, since, className }: MonitorChartProps) {
  const sinceSeconds = sinceToSeconds(since);
  const bucketSeconds = BUCKET_SECONDS[sinceSeconds] ?? Math.max(300, Math.ceil(sinceSeconds / WEB_CONFIG.maxBuckets / 60) * 60);
  const refreshKey = lastRunAt ?? 0;
  const { chartQuery, transform } = useMemo(() => {
    // Buckets end on local clock boundaries, so the last point is the current bucket, not one hours old.
    const now = unixNow();
    const offset = new Date().getTimezoneOffset() * 60;
    const until = Math.ceil((now - offset) / bucketSeconds) * bucketSeconds + offset;
    const from = until - sinceSeconds;
    // No events (e.g. a FACET query with no matches) is a flat zero line, not an empty chart.
    const zeros = () => Array.from({ length: sinceSeconds / bucketSeconds }, (_, i) =>
      ({ beginTimeSeconds: from + i * bucketSeconds, endTimeSeconds: from + (i + 1) * bucketSeconds, events: 0 }));
    const transform = (rows: Record<string, unknown>[]) => (rows.length > 0 ? rows : zeros());
    const query = provider !== "posthog"
      ? `${substituteWindow(provider, monitorQuery, from, until)} TIMESERIES ${bucketSeconds / 60} minutes`
      : substituteWindow(provider, monitorChartQuery ?? monitorQuery, from, until);
    return { chartQuery: query, transform };
  }, [provider, monitorQuery, monitorChartQuery, since, sinceSeconds, bucketSeconds, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const threshold = useMemo(() => parseThreshold(condition), [condition]);

  return (
    <div className={cn("flex-1 border-t border-border px-5 py-4", className)}>
      <QueryChart
        provider={provider}
        query={chartQuery}
        height={CHART_HEIGHT}
        refreshKey={refreshKey}
        threshold={threshold}
        growWithLegend
        transform={transform}
      />
    </div>
  );
});
